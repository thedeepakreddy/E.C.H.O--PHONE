import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {botState,createBots} from '../lib/bots.js';
import {createCloud} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

const wait=async predicate=>{for(let n=0;n<200;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Fixture did not settle');};
async function fixture(t,{context={},execute}={}){
 const state=botState(),id=randomUUID();let input,release;
 const engine=createBots({withState:async(_owner,fn)=>fn(state),execute:async p=>{input=p;if(execute)return execute(p);await new Promise(resolve=>release=resolve);return {reply:'Done'};}});
 t.after(async()=>{await engine.stop('owner',id);release?.();await wait(()=>engine.activeCount()===0);});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Read fixture sources'},context);
 await wait(()=>input);
 return {engine,id,input,state,job:async()=>(await engine.list('owner')).jobs[0],identity:(call='call-a',attempt='tool-a')=>({botId:'research',runId:id,requestId:id,attempt:1,toolCallId:call,toolAttemptId:attempt,toolCallName:'web_search'})};
}

test('cloud execution context uses the owner job request and numeric attempt, including Retry',async t=>{
 const inputs=[];
 const f=await fixture(t,{context:{requestId:'stale-request',attempt:99,device:'other'},execute:async p=>{inputs.push(p);throw Error('Offline fixture');}});
 await wait(()=>f.engine.activeCount()===0);
 assert.equal(inputs[0].context.requestId,f.id);
 assert.equal(inputs[0].context.attempt,1);
 assert.equal(inputs[0].context.device,'owner');
 const next=randomUUID();
 await f.engine.control('owner',{operation:'retry',id:f.id,botId:'research',attempt:1,requestId:next});
 await wait(()=>inputs.length===2&&f.engine.activeCount()===0);
 assert.equal(inputs[1].context.requestId,next);
 assert.equal(inputs[1].context.attempt,2);
});

test('same-name overlapping attempts retain truthful active activity and persisted matching ends',async t=>{
 const f=await fixture(t),first=f.identity(),second=f.identity('call-b','tool-b');
 const send=(type,identity,status)=>f.input.onEvent({...identity,type,...(status?{status}:{})});
 await Promise.all([send('TOOL_CALL_START',first),send('TOOL_CALL_START',second)]);
 assert.equal((await f.job()).activity.toolAttemptId,'tool-b');
 await send('TOOL_CALL_END',first,'success');
 await send('TOOL_CALL_RESULT',first,'success');
 await f.input.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Streaming while another tool is running'});
 await f.input.onEvent({type:'TEXT_MESSAGE_END'});
 await f.input.onEvent({type:'RUN_STARTED',threadId:'research',runId:`${f.id}-1`});
 let job=await f.job();
 assert.equal(job.activity.kind,'reading');
 assert.equal(job.activity.toolAttemptId,'tool-b');
 assert.equal(job.draft,'Streaming while another tool is running');
 await send('TOOL_CALL_END',second,'denied');
 job=await f.job();
 assert.equal(job.activity.kind,'working');
 assert.deepEqual(job.events.filter(e=>e.type==='TOOL_CALL_END').map(({botId,runId,requestId,attempt,toolCallId,toolAttemptId,tool,status})=>({botId,runId,requestId,attempt,toolCallId,toolAttemptId,tool,status})),[
  {botId:'research',runId:f.id,requestId:f.id,attempt:1,toolCallId:'call-a',toolAttemptId:'tool-a',tool:'web_search',status:'success'},
  {botId:'research',runId:f.id,requestId:f.id,attempt:1,toolCallId:'call-b',toolAttemptId:'tool-b',tool:'web_search',status:'denied'},
 ]);
});

test('stale owner/run/request/attempt and unmatched or replayed call events cannot replace active work',async t=>{
 const f=await fixture(t),identity=f.identity();
 await f.input.onEvent({...identity,type:'TOOL_CALL_START'});
 const before=structuredClone(await f.job());
 for(const patch of [{botId:'write'},{runId:randomUUID()},{requestId:randomUUID()},{attempt:0},{attempt:'1'},
  {toolCallId:'other-call'},{toolAttemptId:'other-attempt'},{toolCallName:'save_memory'}]){
  await f.input.onEvent({...identity,...patch,type:'TOOL_CALL_END',status:'success'});
  await f.input.onEvent({...identity,...patch,type:'TOOL_CALL_RESULT',status:'success'});
 }
 for(const patch of [{botId:'write'},{runId:randomUUID()},{requestId:randomUUID()},{attempt:2},{attempt:undefined}]){
  await f.input.onEvent({...identity,...patch,toolAttemptId:'stale-tool',type:'TOOL_CALL_START'});
 }
 await f.input.onEvent({...identity,type:'TOOL_CALL_START'});
 await f.input.onEvent({...identity,type:'TOOL_CALL_RESULT',status:'success'}); // no actual end yet
 await f.input.onEvent({...identity,type:'TOOL_CALL_END',status:'invented-success'});
 await f.input.onEvent({type:'RUN_STARTED',threadId:'write',runId:`${f.id}-1`});
 await f.input.onEvent({type:'TEXT_MESSAGE_CONTENT',requestId:randomUUID(),delta:'Stale text'});
 assert.deepEqual((await f.job()).events,before.events);
 assert.deepEqual((await f.job()).activity,before.activity);
 assert.equal((await f.job()).draft,undefined);
 await f.input.onEvent({...identity,type:'TOOL_CALL_END',status:'failed'});
 const current=f.identity('call-a','new-tool-attempt');
 await f.input.onEvent({...current,type:'TOOL_CALL_START'});
 await f.input.onEvent({...identity,type:'TOOL_CALL_START'}); // cannot resurrect an ended nonce
 await f.input.onEvent({...identity,type:'TOOL_CALL_END',status:'success'});
 await f.input.onEvent({...identity,type:'TOOL_CALL_RESULT',status:'success'}); // mismatched outcome
 await f.input.onEvent({...identity,type:'TOOL_CALL_RESULT',status:'failed'});
 await f.input.onEvent({...identity,type:'TOOL_CALL_RESULT',status:'failed'});
 const job=await f.job();
 assert.equal(job.activity.toolAttemptId,'new-tool-attempt');
 assert.equal(job.events.filter(e=>e.type==='TOOL_CALL_START').length,2);
 assert.equal(job.events.filter(e=>e.type==='TOOL_CALL_END').length,1);
 assert.equal(job.events.filter(e=>e.type==='TOOL_CALL_RESULT').length,1);
});

test('fallback Retry cannot reuse one same-name receipt for another unresolved write attempt',async()=>{
 for(const modern of [true,false]){
  const state=botState(),id=randomUUID(),identity={botId:'echo-assistant',runId:id,requestId:id,attempt:1,tool:'save_memory'};
  const first={...identity,toolCallId:'write-a',toolAttemptId:'attempt-a'},second={...identity,toolCallId:'write-b',toolAttemptId:'attempt-b'};
  const event=(owner,type,status)=>({...modern?owner:{tool:'save_memory'},type,...(status?{status}:{})});
  state.jobs.push({id,botId:'echo-assistant',botRevision:1,goal:'Save notes',attempt:1,status:'failed',context:{},events:[
   event(first,'TOOL_CALL_START'),event(second,'TOOL_CALL_START'),event(second,'TOOL_CALL_END','success'),event(second,'TOOL_CALL_RESULT','success'),
  ]});
  let executions=0;
  const engine=createBots({withState:async(_owner,fn)=>fn(state),execute:async()=>{executions++;return {reply:'Must not replay'};}});
  await assert.rejects(engine.control('owner',{operation:'retry',id,botId:'echo-assistant',attempt:1,requestId:randomUUID()}),/earlier action may already have happened/i);
  assert.equal(executions,0);
 }
});

test('a delayed matching checkpoint receipt cannot replace newer writing activity',async t=>{
 const f=await fixture(t),identity=f.identity();
 await f.input.onEvent({...identity,type:'TOOL_CALL_START'});
 await f.input.onEvent({...identity,type:'TOOL_CALL_END',status:'success'});
 await f.input.onEvent({type:'TEXT_MESSAGE_CONTENT',delta:'Newer useful draft'});
 const before=structuredClone((await f.job()).activity);
 assert.equal(before.kind,'writing');
 await f.input.onEvent({...identity,type:'TOOL_CALL_RESULT',status:'success'});
 assert.deepEqual((await f.job()).activity,before);
});

test('real cloud-to-owner telemetry announces only attempted calls and keeps the question checkpoint',async t=>{
 let release,entered;const started=new Promise(resolve=>entered=resolve),reads=[];
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'offline',generate:async()=>({candidates:[{content:{role:'model',parts:[
  {functionCall:{id:'first',name:'get_today',args:{}}},
  {functionCall:{id:'question',name:'ask_person',args:{question:'Which date?'}}},
  {functionCall:{id:'skipped',name:'get_today',args:{}}},
 ]}}]})}});
 const f=await fixture(t,{execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{today:async()=>{reads.push('today');entered();await new Promise(resolve=>release=resolve);return {};}}})});
 t.after(()=>release?.());
 await started;
 try{
  const job=await f.job();
  assert.equal(job.activity.kind,'reading');
  assert.equal(job.activity.toolCallId,'first');
  assert.equal(job.activity.attempt,1);
  assert.deepEqual(job.events.filter(e=>e.type.startsWith('TOOL_CALL_')).map(e=>[e.type,e.toolCallId]),[['TOOL_CALL_START','first']]);
 }finally{release();}
 await wait(()=>f.engine.activeCount()===0);
 const job=await f.job();
 assert.equal(job.status,'needs-you');
 assert.equal(job.result.question,'Which date?');
 assert.deepEqual(reads,['today']);
 assert.deepEqual(job.events.filter(e=>e.type==='TOOL_CALL_END').map(e=>[e.toolCallId,e.status]),[['first','success'],['question','waiting']]);
 assert.ok(!job.events.some(e=>e.toolCallId==='skipped'));
 assert.equal(f.state.jobs[0].checkpoint.pending.index,2);
});

test('uncertain actual writes end visibly but retain their checkpoint and block Retry',async t=>{
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'offline',generate:async()=>({candidates:[{content:{role:'model',parts:[{functionCall:{id:'write',name:'save_memory',args:{text:'Once'}}}]}}]})}});
 const state=botState(),id=randomUUID();
 const engine=createBots({withState:async(_owner,fn)=>fn(state),execute:p=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{save:async()=>{throw Error('Outcome unknown fixture');}}})});
 await engine.run('owner',{requestId:id,botId:'echo-assistant',revision:1,goal:'Save once'});
 await wait(()=>engine.activeCount()===0);
 const job=(await engine.list('owner')).jobs[0];
 assert.equal(job.status,'failed');
 assert.equal(job.activity.kind,'working');
 assert.deepEqual(job.events.filter(e=>e.type==='TOOL_CALL_END').map(e=>[e.toolCallId,e.status]),[['write','uncertain']]);
 assert.ok(!job.events.some(e=>e.type==='TOOL_CALL_RESULT'));
 assert.equal(state.jobs[0].checkpoint.inFlight.mutating,true);
 await assert.rejects(engine.control('owner',{operation:'retry',id,botId:'echo-assistant',attempt:1,requestId:randomUUID()}),/may already have happened/);
});
