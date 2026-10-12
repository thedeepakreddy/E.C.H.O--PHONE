import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBots,botState} from '../lib/bots.js';
import {createCloud,CloudError} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';
import http from 'node:http';
import {createRelay} from '../server.js';
import {signPass} from '../lib/secure.js';

const until=async f=>{for(let i=0;i<200;i++){if(await f())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
const retry=(id,botId='echo-assistant',attempt=1)=>({operation:'retry',id,botId,attempt,requestId:randomUUID()});
const checkpoint=()=>({version:1,contents:[{role:'user',parts:[{text:'Original goal'}]}],out:{actions:[],sources:[],saved:[],captures:[],references:[],expression:'attentive',question:null},pending:null,inFlight:null,completedEffects:[],reply:'',finished:false});

test('Phone budget exhaustion is failed and Retry continues its saved progress',async t=>{
 const state=botState(),id=randomUUID();let calls=0,resumed;
 const engine=createBots({withState:async(_d,f)=>f(state),timeoutMs:20,execute:async p=>{
  if(++calls>1){resumed=p;return {reply:'Continued after budget exhaustion'};}
  await p.onCheckpoint(checkpoint());await p.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Saved before the budget ended'});
  await new Promise((_resolve,reject)=>{if(p.signal.aborted)reject(p.signal.reason);else p.signal.addEventListener('abort',()=>reject(p.signal.reason),{once:true});});
 }});
 t.after(async()=>{await engine.stop('owner',id);await until(()=>engine.activeCount()===0);});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal'},{requestId:id});await until(()=>engine.activeCount()===0);
 const failed=(await engine.list('owner')).jobs[0];assert.equal(failed.status,'failed');assert.match(failed.error,/time budget.*Use Retry.*saved progress/i);assert.equal(failed.draft,'Saved before the budget ended');
 const accepted=await engine.control('owner',retry(id,'research'));await until(()=>engine.activeCount()===0);
 assert.equal(resumed.goal,'Original goal');assert.deepEqual(resumed.checkpoint.contents,checkpoint().contents);assert.equal(resumed.partialDraft,'Saved before the budget ended');
 const jobs=(await engine.list('owner')).jobs;assert.equal(jobs[0].id,accepted.newRunId);assert.equal(jobs[0].attempt,2);assert.equal(jobs[0].status,'done');assert.equal(jobs[1].status,'failed');
});

test('Phone user Stop stays stopped and advises reviewing changes before Follow up rather than Retry',async()=>{
 for(const useControl of [false,true]){
  const state=botState(),id=randomUUID();let ready=false;
  const engine=createBots({withState:async(_d,f)=>f(state),timeoutMs:80,execute:async p=>{
   await p.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Saved before user Stop'});ready=true;
   await new Promise((_resolve,reject)=>{if(p.signal.aborted)reject(p.signal.reason);else p.signal.addEventListener('abort',()=>reject(p.signal.reason),{once:true});});
  }});
  await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal',timeoutMs:1},{timeoutMs:1});await until(()=>ready);
  await new Promise(r=>setTimeout(r,10));assert.equal((await engine.list('owner')).jobs[0].status,'running','request/context timeout fields cannot change the internal budget');
  if(useControl)await engine.control('owner',{id,botId:'research',attempt:1,requestId:randomUUID(),operation:'stop'});else await engine.stop('owner',id);
  await until(()=>engine.activeCount()===0);
  const stopped=(await engine.list('owner')).jobs[0];assert.equal(stopped.status,'stopped');assert.equal(stopped.draft,'Saved before user Stop');
  assert.match(stopped.error,/Review.*saved changes.*before Follow up/i);assert.doesNotMatch(stopped.error,/retry/i);
  await assert.rejects(engine.control('owner',retry(id,'research')),/Only failed or interrupted/);
 }
});

test('Phone generic failures recommend Retry to continue saved progress without mistaking provider text for a timer marker',async()=>{
 const state=botState(),id=randomUUID();
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async({onEvent})=>{await onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Some saved progress'});throw Error('Time budget exhausted');}});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal'});await until(()=>engine.activeCount()===0);
 const failed=(await engine.list('owner')).jobs[0];assert.equal(failed.status,'failed');assert.equal(failed.draft,'Some saved progress');
 assert.match(failed.error,/^The bot could not finish.*Use Retry to continue saved progress/);assert.doesNotMatch(failed.error,/start a new run/);
});

test('Phone retries retain at most 30 persisted jobs including the failed source and newest continuation',async()=>{
 const state=botState(),id=randomUUID();
 state.jobs=Array.from({length:29},()=>({id:randomUUID(),botId:'research',goal:'Older completed task',status:'done',events:[],commands:[]}));
 const oldest=state.jobs[0].id;
 state.jobs.push({id,botId:'research',botRevision:1,goal:'Continue this goal',attempt:1,status:'failed',draft:'Saved paragraph',events:[],commands:[]});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>({reply:'Continued'})});
 const accepted=await engine.control('owner',retry(id,'research'));await until(()=>engine.activeCount()===0);
 assert.equal(state.jobs.length,30,'persisted state, not just the UI list, must be bounded');
 assert.ok(!state.jobs.some(j=>j.id===oldest));
 const jobs=(await engine.list('owner')).jobs;assert.equal(jobs[0].id,accepted.newRunId);assert.equal(jobs[1].id,id);assert.equal(jobs[1].status,'failed');assert.equal(jobs[1].draft,'Saved paragraph');
});

test('Phone keeps only the latest 256 retry receipts including aliases without recreating an evicted continuation',async()=>{
 const state=botState();let effects=0;
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>{effects++;throw Error('Fixture failure');}});
 const original=randomUUID();await engine.run('owner',{requestId:original,botId:'research',revision:1,goal:'First failed goal'});await until(()=>engine.activeCount()===0);
 const first=retry(original,'research'),accepted=await engine.control('owner',first);await until(()=>engine.activeCount()===0);
 const other=randomUUID();await engine.run('owner',{requestId:other,botId:'research',revision:1,goal:'Another failed goal'});await until(()=>engine.activeCount()===0);
 const otherAccepted=await engine.control('owner',retry(other,'research'));await until(()=>engine.activeCount()===0);
 let latest;
 for(let i=0;i<257;i++){latest=retry(other,'research');assert.equal((await engine.control('owner',latest)).newRunId,otherAccepted.newRunId);}
 assert.equal(state.retryReceipts.length,256,'aliases must share the same bounded receipt window');
 assert.ok(!state.retryReceipts.some(r=>r.requestId===first.requestId));assert.equal(state.retryReceipts.at(-1).requestId,latest.requestId);
 const before=effects;
 assert.equal((await engine.control('owner',first)).newRunId,accepted.newRunId,'a retained linked attempt recovers an evicted acknowledgment');
 assert.equal((await engine.control('owner',retry(original,'research'))).newRunId,accepted.newRunId);assert.equal(effects,before);assert.equal(state.jobs.length,4);assert.equal(state.retryReceipts.length,256);
 for(let i=0;i<257;i++)await engine.control('owner',retry(other,'research'));
 // Both windows expired: the backend must deny replay and explain the missing history.
 state.jobs=[];
 await assert.rejects(engine.control('owner',first),/expired.*Refresh.*saved progress/i);assert.equal(effects,before);assert.equal(state.jobs.length,0);
});

test('Phone manual retries stop at attempt 10 while acknowledgment repeats still return the tenth attempt',async()=>{
 const state=botState();let calls=0;
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>{calls++;throw Error('Fixture failure');}});
 let id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'One bounded retry chain'});await until(()=>engine.activeCount()===0);
 let tenthCommand,tenthResult;
 for(let attempt=1;attempt<10;attempt++){
  const command=retry(id,'research',attempt),result=await engine.control('owner',command);await until(()=>engine.activeCount()===0);
  const newest=(await engine.list('owner')).jobs[0];assert.equal(newest.attempt,attempt+1);assert.equal(newest.parentId,id);id=result.newRunId;
  if(attempt===9){tenthCommand=command;tenthResult=result;}
 }
 assert.equal(calls,10);assert.equal(state.jobs.length,10);
 assert.equal((await engine.control('owner',tenthCommand)).newRunId,tenthResult.newRunId);
 assert.equal((await engine.control('owner',{...tenthCommand,requestId:randomUUID()})).newRunId,tenthResult.newRunId);
 await assert.rejects(engine.control('owner',retry(id,'research',10)),/10 attempts.*Review.*saved progress.*new task/i);
 assert.equal(calls,10);assert.equal(state.jobs.length,10);assert.ok(state.jobs.every(j=>j.attempt<=10));
});

test('reading legacy oversized Phone state persists bounded jobs and receipts',async()=>{
 const state=botState();let saved;
 state.jobs=Array.from({length:75},()=>({id:randomUUID(),botId:'research',status:'done',events:[],commands:[]}));
 state.retryReceipts=Array.from({length:300},()=>({requestId:randomUUID(),id:randomUUID(),botId:'research',attempt:1,newRunId:randomUUID(),message:'Previously accepted.'}));
 const newestJob=state.jobs.at(-1).id,newestReceipt=state.retryReceipts.at(-1).requestId;
 const engine=createBots({withState:async(_d,f,options)=>{const result=await f(state);if(options.save())saved=structuredClone(state);return result;},execute:async()=>({})});
 assert.equal((await engine.list('owner')).jobs[0].id,newestJob);
 assert.equal(saved.jobs.length,30);assert.equal(saved.retryReceipts.length,256);assert.equal(saved.retryReceipts.at(-1).requestId,newestReceipt);
});

test('a retained retry receipt returns its original run ID with honest guidance after the run history expires',async()=>{
 const state=botState();let calls=0;
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>{calls++;throw Error('Fixture failure');}});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Old failed goal'});await until(()=>engine.activeCount()===0);
 const command=retry(id,'research'),accepted=await engine.control('owner',command);await until(()=>engine.activeCount()===0);
 for(let i=0;i<30;i++){await engine.run('owner',{requestId:randomUUID(),botId:'research',revision:1,goal:'Newer goal'});await until(()=>engine.activeCount()===0);}
 assert.equal(state.jobs.length,30);assert.ok(!state.jobs.some(j=>j.id===id||j.id===accepted.newRunId));
 const before=calls,result=await engine.control('owner',command);
 assert.equal(result.newRunId,accepted.newRunId);assert.equal(result.repeated,true);assert.match(result.message,/history has expired.*Refresh.*saved progress.*No new run/i);
 await assert.rejects(engine.control('owner',retry(id,'research')),/expired.*Refresh.*saved progress/i);assert.equal(calls,before);
});

test('Phone Retry continues completed tool output after the second tool fails and uses the current brain',async()=>{
 const state=botState(),requests=[];let writes=0,reads=0,fail=true;
 const gemini={model:'first-brain',generate:async(body,options)=>{
  requests.push({body:structuredClone(body),model:options.modelId});
  return {candidates:[{content:{role:'model',parts:body.contents.some(c=>c.parts.some(p=>p.functionResponse))?[{text:'Finished using the saved note and Today.'}]:[
   {text:'Partial draft'},
   {functionCall:{id:'save-1',name:'save_memory',args:{text:'Remember the goal'}}},
   {functionCall:{id:'today-2',name:'get_today',args:{}}},
  ]}}]};
 }};
 const cloud=createCloud({gemini,store:createStore({key:Buffer.alloc(32)}),tools:{}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{
  save:async()=>{writes++;return {id:'private-note',title:'Saved goal',dates:[]};},
  today:async()=>{reads++;if(fail)throw new CloudError('failed','Today lost its connection.');return {items:['real Today output']};},
 }})});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'echo-assistant',revision:1,goal:'Remember this and read Today'},{requestId:id});
 await until(()=>engine.activeCount()===0);
 assert.equal((await engine.list('owner')).jobs[0].status,'failed');assert.equal(writes,1);
 fail=false;gemini.model='currently-configured-brain';
 const command=retry(id),result=await engine.control('owner',command);
 await until(()=>engine.activeCount()===0);
 const jobs=(await engine.list('owner')).jobs;
 assert.equal(jobs[0].id,result.newRunId);assert.equal(jobs[0].parentId,id);assert.equal(jobs[0].attempt,2);
 assert.equal(jobs[0].goal,'Remember this and read Today');assert.equal(jobs[0].status,'done');
 assert.equal(jobs[1].status,'failed');assert.equal(jobs[1].draft,'Partial draft');
 assert.equal(writes,1,'the completed write is never replayed');assert.equal(reads,2,'only the unfinished read repeats');
 const resumed=requests.at(-1);assert.equal(resumed.model,'currently-configured-brain');
 assert.deepEqual(resumed.body.contents.flatMap(c=>c.parts).filter(p=>p.functionResponse).map(p=>p.functionResponse.name),['save_memory','get_today']);
 assert.equal(resumed.body.contents.flatMap(c=>c.parts).find(p=>p.functionResponse?.name==='save_memory').functionResponse.response.title,'Saved goal');
 assert.match(result.message,/saved|continu/i);
 assert.equal((await engine.control('owner',command)).newRunId,result.newRunId,'network repeat after completion returns the same run');
 const different=await engine.control('owner',retry(id));assert.equal(different.newRunId,result.newRunId);
 assert.equal((await engine.list('owner')).jobs.length,2);
});

test('a resumed provider repeating the completed write with reordered arguments reuses its actual output',async()=>{
 const state=botState();let fail=true,writes=0,turn=0;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async body=>{
  if(fail&&turn++===1)throw Error('Provider offline after write');
  const responses=body.contents.flatMap(c=>c.parts).filter(p=>p.functionResponse);
  const parts=responses.length===0?[{functionCall:{name:'save_memory',args:{text:'Save once',title:'One note'}}}]:responses.length===1?[{functionCall:{name:'save_memory',args:{title:'One note',text:'Save once'}}}]:[{text:'Only one saved note.'}];
  return {candidates:[{content:{role:'model',parts}}]};
 }}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{save:async()=>{writes++;return {id:'one-note',title:'One note',dates:[]};}}})});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'echo-assistant',revision:1,goal:'Save once'},{requestId:id});await until(()=>engine.activeCount()===0);
 fail=false;await engine.control('owner',retry(id));await until(()=>engine.activeCount()===0);
 assert.equal(writes,1,'argument key order must not bypass completed side-effect protection');assert.equal((await engine.list('owner')).jobs[0].status,'done');
});

test('Retry forwards saved partial text that did not reach a complete provider boundary',async()=>{
 const state=botState();let fail=true,captured;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async body=>{captured=structuredClone(body);return {candidates:[{content:{role:'model',parts:[{text:fail?'A useful unfinished paragraph':'Finished paragraph'}]}}]};}}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},onEvent:async event=>{await p.onEvent(event);if(fail&&event.type==='TEXT_MESSAGE_CONTENT')throw Error('Offline mid-draft');}})});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal'},{requestId:id});await until(()=>engine.activeCount()===0);
 fail=false;await engine.control('owner',retry(id,'research'));await until(()=>engine.activeCount()===0);
 assert.match(captured.contents.flatMap(c=>c.parts).map(p=>p.text??'').join('\n'),/Saved partial draft.*\nA useful unfinished paragraph/);assert.equal((await engine.list('owner')).jobs[1].draft,'A useful unfinished paragraph');
});

test('simultaneous retries across accounts cannot exceed the shared worker capacity',async()=>{
 const states=new Map(),releases=[];
 for(const owner of ['one','two']){const st=botState();st.jobs.push({id:randomUUID(),botId:'research',botRevision:1,goal:'Original goal',attempt:1,status:'failed',events:[],commands:[]});states.set(owner,st);}
 const engine=createBots({withState:async(d,f)=>f(states.get(d)),maxActive:1,execute:async()=>{await new Promise(r=>releases.push(r));return {reply:'Done'};}});
 const results=await Promise.allSettled([...states].map(([d,st])=>engine.control(d,retry(st.jobs[0].id,'research'))));
 const admitted=results.filter(r=>r.status==='fulfilled').length;await until(()=>releases.length===admitted);releases.forEach(r=>r());await until(()=>engine.activeCount()===0);
 assert.equal(admitted,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/busy/);
});

test('applied updates survive a crash between their acknowledgement and the provider checkpoint',async()=>{
 const state=botState(),requests=[];let release,fail=true,round=0;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async body=>{
  requests.push(structuredClone(body));if(round++===0){await new Promise(r=>release=r);return {candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_today',args:{}}}]}}]};}
  return {candidates:[{content:{role:'model',parts:[{text:'Finished with annual pricing'}]}}]};
 }}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{today:async()=>({items:['Actual task']})},takeUpdates:async()=>{const updates=await p.takeUpdates();if(fail&&updates.length)throw Error('Crash after update acknowledgement');return updates;}})});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal'},{requestId:id});await until(()=>release);
 await engine.control('owner',{id,botId:'research',attempt:1,operation:'update',text:'Use annual pricing',requestId:randomUUID()});release();await until(()=>engine.activeCount()===0);
 assert.equal((await engine.list('owner')).jobs[0].commands[0].status,'applied');fail=false;
 await engine.control('owner',retry(id,'research'));await until(()=>engine.activeCount()===0);
 assert.ok(requests.at(-1).contents.some(c=>c.parts.some(p=>p.text==='User update for this task: Use annual pricing')));
 assert.equal((await engine.list('owner')).jobs[0].status,'done');assert.equal((await engine.list('owner')).jobs[1].commands[0].status,'applied');
});

test('Retry request IDs cannot alias another task or be reused as a fresh run after history pruning',async()=>{
 const state=botState(),id=randomUUID(),other=randomUUID();state.jobs.push({id,botId:'research',botRevision:1,goal:'Original goal',attempt:1,status:'failed',events:[],commands:[]},{id:other,botId:'plan',goal:'Other task',status:'done',events:[],commands:[]});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>({reply:'Done'})});
 const command=retry(id,'research');await engine.control('owner',command);await until(()=>engine.activeCount()===0);
 await assert.rejects(engine.control('owner',{...retry(id,'research'),requestId:other}),/another instruction/);
 state.jobs=[];
 await assert.rejects(engine.run('owner',{requestId:command.requestId,botId:'research',revision:1,goal:'Different new task'}),/another instruction|different task/);
});

test('double-clicks and network retries claim one continuation, persist receipts across workers, and validate exact identities',async()=>{
 const state=botState(),id=randomUUID(),calls=[];let release;
 state.jobs.push({id,botId:'research',botRevision:1,goal:'Original goal',attempt:3,status:'failed',events:[],commands:[],context:{device:'owner'}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async p=>{calls.push(p);await new Promise(r=>release=r);return {reply:'Done'};}});
 const a=retry(id,'research',3),b=retry(id,'research',3);
 const responses=await Promise.all([engine.control('owner',a),engine.control('owner',a),engine.control('owner',b)]);
 await until(()=>release);assert.equal(new Set(responses.map(r=>r.newRunId)).size,1);assert.equal(calls.length,1);
 assert.equal((await engine.list('owner')).jobs[0].attempt,4);
 await assert.rejects(engine.control('owner',{...a,attempt:2}),/another instruction|attempt/);
 await assert.rejects(engine.control('owner',retry(id,'research',2)),/attempt/);
 await assert.rejects(engine.control('owner',retry(id,'plan',3)),/no longer/);
 await assert.rejects(engine.control('owner',{...a,attempt:undefined,requestId:randomUUID()}),/exact/);
 release();await until(()=>engine.activeCount()===0);
 const restarted=createBots({withState:async(_d,f)=>f(state),execute:async()=>{throw Error('Duplicate continuation');}});
 // A receipt remains usable even after its original job leaves the visible history.
 state.jobs=state.jobs.filter(j=>j.id!==id);
 assert.equal((await restarted.control('owner',a)).newRunId,responses[0].newRunId);
 assert.equal((await restarted.control('owner',b)).newRunId,responses[0].newRunId);
});

test('retry eligibility rejects terminal/live runs, stale bot revisions, changed grants and exhausted capacity',async()=>{
 for(const status of ['done','stopped','needs-you','running','queued']){
  const state=botState(),id=randomUUID();state.jobs.push({id,botId:'research',botRevision:1,attempt:1,status,leaseUntil:999999,events:[],commands:[]});
  const engine=createBots({withState:async(_d,f)=>f(state),now:()=>1000,execute:async()=>({})});
  await assert.rejects(engine.control('owner',retry(id,'research')),/failed or interrupted/);assert.equal(state.jobs.length,1);
 }
 for(const change of ['revision','mode']){
  const state=botState(),id=randomUUID(),bot=state.bots[0];state.jobs.push({id,botId:bot.id,botRevision:1,botConfig:structuredClone(bot),goal:'Original goal',attempt:1,status:'failed',events:[],commands:[]});
  if(change==='revision')bot.revision++;else bot.mode='assist';
  const engine=createBots({withState:async(_d,f)=>f(state),execute:async()=>({})});
  await assert.rejects(engine.control('owner',retry(id,'research')),/revision or tool grants changed/);
 }
 const state=botState(),id=randomUUID();state.jobs.push({id,botId:'research',botRevision:1,goal:'Original goal',attempt:1,status:'failed',events:[],commands:[]});
 const engine=createBots({withState:async(_d,f)=>f(state),maxActive:0,execute:async()=>({})});
 await assert.rejects(engine.control('owner',retry(id,'research')),/busy/);assert.equal(state.jobs.length,1);
});

test('offline interruption keeps progress, isolates owners and fences late checkpoints, events and effects from the old worker',async()=>{
 const states=new Map();let time=1000,old,release,newCall;
 const withState=async(d,f)=>{if(!states.has(d))states.set(d,botState());return f(states.get(d));};
 const engine=createBots({withState,now:()=>time,execute:async p=>{if(!old){old=p;await p.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Unfinished partial draft'});await p.onCheckpoint(checkpoint());await new Promise(r=>release=r);await p.ensure();return {reply:'Late old result'};}newCall=p;return {reply:'Continued result'};}});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Original goal'},{device:'owner',requestId:id});await until(()=>release);
 time+=180001;assert.equal((await engine.list('owner')).jobs[0].status,'interrupted');assert.equal((await engine.list('owner')).jobs[0].draft,'Unfinished partial draft');
 await assert.rejects(engine.control('other',retry(id,'research')),/no longer/);assert.equal((await engine.list('other')).jobs.length,0);
 const result=await engine.control('owner',retry(id,'research'));await until(()=>newCall);
 assert.equal(old.signal.aborted,true);assert.equal(newCall.goal,'Original goal');assert.deepEqual(newCall.checkpoint.contents,checkpoint().contents);
 await assert.rejects(old.onCheckpoint({...checkpoint(),reply:'private late data'}),/stopped/);
 await assert.rejects(old.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'private late data'}),/stopped/);
 release();await until(()=>engine.activeCount()===0);
 const jobs=(await engine.list('owner')).jobs;assert.equal(jobs[0].id,result.newRunId);assert.equal(jobs[0].result.reply,'Continued result');assert.equal(jobs[1].status,'interrupted');
 assert.ok(jobs.every(j=>!j.checkpoint&&!j.history&&!j.context&&!j.botConfig&&!j.worker));assert.ok(!JSON.stringify(jobs).includes('private late data'));
});

test('an uncertain in-flight mutation blocks Retry and cannot be bypassed with another request ID',async()=>{
 const state=botState();let effects=0;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async()=>({candidates:[{content:{role:'model',parts:[{functionCall:{name:'save_memory',args:{text:'Save this once'}}}]}}]})}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{save:async()=>{effects++;throw Error('Connection lost after commit');}}})});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'echo-assistant',revision:1,goal:'Save this once'},{requestId:id});await until(()=>engine.activeCount()===0);
 assert.equal(effects,1);assert.match((await engine.list('owner')).jobs[0].error,/may already have happened/);
 for(let i=0;i<2;i++)await assert.rejects(engine.control('owner',retry(id)),/may already have happened.*Check the saved changes/);
 assert.equal(state.jobs.length,1);assert.equal(effects,1);
});

test('checkpoint persistence is awaited before the next effect and failed persistence leaves an honest uncertain write',async()=>{
 let release,entered=false,writes=0,reads=0,last;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'fixture',generate:async()=>({candidates:[{content:{role:'model',parts:[{functionCall:{name:'save_memory',args:{text:'Write once'}}},{functionCall:{name:'get_today',args:{}}}]}}]})}});
 const run=cloud.chat({text:'Write once and read Today',bot:{id:'echo-assistant',mode:'assist',role:'Assist',runId:'fixture'},memory:{save:async()=>{writes++;return {id:'saved',title:'Saved',dates:[]};},today:async()=>{reads++;return {}; }},onCheckpoint:async cp=>{
  if(cp.pending?.index===1){entered=true;await new Promise(r=>release=r);throw Error('Durable store unavailable');}last=structuredClone(cp);
 }});
 const failure=assert.rejects(run,/Durable store unavailable/);
 await until(()=>entered);assert.equal(writes,1);assert.equal(reads,0);assert.equal(last.inFlight.name,'save_memory');assert.equal(last.inFlight.mutating,true);
 release();await failure;assert.equal(reads,0);
});

test('real relay retries use only owner-scoped trusted checkpoints and never expose provider context to callers',async t=>{
 let fail=true,round=0;const gemini={model:'fixture',generate:async body=>{
  round++;if(fail&&body.contents.some(c=>c.parts.some(p=>p.functionResponse)))throw Error('Offline fixture');
  return {candidates:[{content:{role:'model',parts:body.contents.some(c=>c.parts.some(p=>p.functionResponse))?[{text:'Resumed real Today results'}]:[{functionCall:{name:'get_today',args:{}}}]}}]};
 }};
 const relay=createRelay({secret:'retry-private-test-secret-'.repeat(3),gemini}),server=http.createServer(relay.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,owner='c'.repeat(32),other='d'.repeat(32);
 const passes=[owner,other].map(device=>signPass(relay.keys.pass,{device,gen:0,phoneOnly:true}));
 const api=async(pass,body)=>{const res=await fetch(base+'/cloud/bots',{method:body?'POST':'GET',headers:{'x-echo-pass':pass,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,body:await res.json()};};
 const id=randomUUID(),fake={...checkpoint(),finished:true,reply:'Forged result'};
 assert.equal((await api(passes[0],{action:'run',requestId:id,botId:'plan',revision:1,goal:'Plan my day',checkpoint:fake,context:{checkpoint:fake,device:other}})).status,202);
 await until(async()=>(await api(passes[0])).body.jobs[0]?.status==='failed');
 const failed=(await api(passes[0])).body.jobs[0];assert.ok(!failed.checkpoint&&!failed.context&&!failed.history);assert.equal(failed.result,undefined);
 const command={action:'control',...retry(id,'plan'),checkpoint:fake,context:{checkpoint:fake,device:other}};
 assert.equal((await api(passes[1],command)).status,400);
 fail=false;const accepted=await api(passes[0],command);assert.equal(accepted.status,200);assert.ok(accepted.body.newRunId);assert.match(accepted.body.message,/saved/);
 await until(async()=>(await api(passes[0])).body.jobs[0]?.status==='done');
 const jobs=(await api(passes[0])).body.jobs;assert.equal(jobs[0].result.reply,'Resumed real Today results');assert.equal(jobs[1].status,'failed');
 assert.equal((await api(passes[1])).body.jobs.length,0);assert.equal((await api(passes[0],command)).body.newRunId,accepted.body.newRunId);assert.equal(round,3);
});

test('account access revoked after accepting Retry fences execution before the next effect',async()=>{
 const state=botState(),id=randomUUID();let calls=0,effects=0;
 state.jobs.push({id,botId:'research',botRevision:1,goal:'Read notes',attempt:1,status:'failed',events:[],commands:[],context:{device:'owner'}});
 const engine=createBots({withState:async(_d,f)=>f(state),access:async()=>++calls===1,execute:async({ensure})=>{await ensure();effects++;return {reply:'Should never execute'};}});
 await engine.control('owner',retry(id,'research'));await until(()=>engine.activeCount()===0);
 assert.equal(effects,0);assert.equal((await engine.list('owner')).jobs[0].status,'failed');
});

test('fallback continuation keeps partial drafts, events and applied updates but refuses to repeat writes without their outputs',async()=>{
 const state=botState(),id=randomUUID();let captured,writes=0;
 state.jobs.push({id,botId:'echo-assistant',botRevision:1,goal:'Original goal',attempt:1,status:'failed',draft:'Available partial draft',events:[{type:'TOOL_CALL_RESULT',tool:'save_memory'}],history:[],context:{device:'owner'},commands:[{id:randomUUID(),operation:'update',text:'Use annual pricing',status:'applied',attempt:1}]});
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'current',generate:async body=>{
  captured=structuredClone(body);return {candidates:[{content:{role:'model',parts:body.contents.some(c=>c.parts.some(p=>p.functionResponse))?[{text:'Available partial draft, with annual pricing. Please check the saved note.'}]:[{functionCall:{name:'save_memory',args:{text:'Original goal'}}}]}}]};
 }}});
 const engine=createBots({withState:async(_d,f)=>f(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{save:async()=>{writes++;return {id:'duplicate',title:'Duplicate',dates:[]};}}})});
 const result=await engine.control('owner',retry(id));await until(()=>engine.activeCount()===0);
 assert.match(result.message,/fallback|unavailable/i);assert.equal(writes,0,'missing tool outputs must not cause blind side-effect replay');
 const text=captured.contents.flatMap(c=>c.parts).map(p=>p.text??'').join('\n');assert.match(text,/Available partial draft/);assert.match(text,/Use annual pricing/);assert.match(text,/save_memory/);
 assert.equal((await engine.list('owner')).jobs[1].status,'failed');
});
