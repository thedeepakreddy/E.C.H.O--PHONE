import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBots,botState} from '../lib/bots.js';
import {createCloud} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

const originalFetch=globalThis.fetch;
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('Services are forbidden in phone command fixtures');};
after(()=>{globalThis.fetch=originalFetch;assert.equal(networkAttempts,0);});
const until=async predicate=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Phone fixture timed out');};
const reply=parts=>({candidates:[{content:{role:'model',parts}}]});
const today=()=>({functionCall:{name:'get_today',args:{}}});
const updateTexts=body=>body.contents.flatMap(c=>c.parts).map(p=>p.text).filter(text=>text?.startsWith('User update for this task: '));
const retry=(id,attempt=1)=>({id,botId:'research',attempt,operation:'retry',requestId:randomUUID()});

// Commits copy state only after the callback and persistence succeed, like the relay.
function durableState(){
 let state=botState(),serial=Promise.resolve();
 const fixture={beforeCommit:async()=>{},snapshot:()=>structuredClone(state)};
 fixture.withState=(_owner,fn,options)=>{
  const pending=serial.then(async()=>{
   const next=structuredClone(state),result=await fn(next);
   if(!options||options.save()){await fixture.beforeCommit(next);state=structuredClone(next);}
   return structuredClone(result);
  });
  serial=pending.catch(()=>{});return pending;
 };
 return fixture;
}
function cloudFixture(generate){
 return createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'offline-fixture',generate}});
}
const cloudRun=(cloud,p,extra={})=>cloud.chat({...p,text:p.goal,bot:{...p.bot,runId:p.context.requestId},memory:{today:async()=>({items:[]})},...extra});

test('real cloud rounds apply annual, monthly, annual by command ID in order',async()=>{
 const state=durableState(),id=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()],requests=[];
 const words=['Use annual pricing','Use monthly pricing','Use annual pricing'];let round=0,engine;
 const cloud=cloudFixture(async body=>{
  requests.push(structuredClone(body));
  if(round<3){
   const command={id,botId:'research',attempt:1,operation:'update',requestId:ids[round],text:words[round]};
   await engine.control('owner',command);await engine.control('owner',command);round++;
   return reply([today()]);
  }
  return reply([{text:'Pricing updated.'}]);
 });
 engine=createBots({withState:state.withState,execute:p=>cloudRun(cloud,p)});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Compare prices'});
 await until(()=>engine.activeCount()===0);
 assert.equal(state.snapshot().jobs[0].status,'done');
 assert.deepEqual(updateTexts(requests.at(-1)),[
  'User update for this task: Use annual pricing','User update for this task: Use monthly pricing','User update for this task: Use annual pricing',
 ]);
 assert.deepEqual(state.snapshot().jobs[0].checkpoint.appliedUpdates.map(c=>c.id),ids);
 assert.equal(state.snapshot().jobs[0].commands.length,3,'Delivery retries do not create extra commands');
});

for(const crash of ['after acknowledgement','after checkpoint'])test(`${crash}: Retry keeps IDs and applies each command once`,async()=>{
 const state=durableState(),id=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()],requests=[];
 const words=['Use annual pricing','Use monthly pricing','Use annual pricing'];let round=0,fail=true,reads=0,engine;
 const cloud=cloudFixture(async body=>{
  requests.push(structuredClone(body));
  if(round<3){await engine.control('owner',{id:state.snapshot().jobs.at(-1).id,botId:'research',attempt:fail?1:2,
   operation:'update',requestId:ids[round],text:words[round++]});return reply([today()]);}
  return reply([{text:'Recovered pricing.'}]);
 });
 engine=createBots({withState:state.withState,execute:p=>cloudRun(cloud,p,{
  memory:{today:async()=>{reads++;return {items:[]};}},
  takeUpdates:async options=>{const updates=await p.takeUpdates(options);if(fail&&crash==='after acknowledgement'&&updates.length)throw Error('Crash after durable acknowledgement');return updates;},
  onCheckpoint:async cp=>{await p.onCheckpoint(cp);if(fail&&crash==='after checkpoint'&&cp.appliedUpdates?.length)throw Error('Crash after durable checkpoint');},
 })});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Compare prices'});
 await until(()=>engine.activeCount()===0);
 const failed=state.snapshot().jobs[0];assert.equal(failed.status,'failed');
 assert.equal(failed.commands[0].status,'applied');
 assert.equal(failed.checkpoint.appliedUpdates.length,crash==='after checkpoint'?1:0);
 fail=false;await engine.control('owner',retry(id));await until(()=>engine.activeCount()===0);
 const resumed=state.snapshot().jobs.at(-1);assert.equal(resumed.status,'done');
 assert.deepEqual(updateTexts(requests.at(-1)),words.map(text=>`User update for this task: ${text}`));
 assert.deepEqual(resumed.checkpoint.appliedUpdates.map(c=>c.id),ids);
 assert.equal(reads,3,'Completed tool responses are retained across Retry');
});

test('a legacy checkpoint binds ordered string updates to IDs without replaying their text',async()=>{
 let saved,last;
 const cloud=cloudFixture(async body=>{last=structuredClone(body);return reply([{text:'Pricing ready.'}]);});
 const input={text:'Compare prices',bot:{id:'research',name:'Research',mode:'research',role:'Read',runId:'legacy-fixture'}};
 await cloud.chat({...input,appliedUpdates:['Use annual pricing','Use monthly pricing'],onCheckpoint:async cp=>{saved=structuredClone(cp);}});
 delete saved.appliedUpdates;
 const commands=[{id:randomUUID(),text:'Use annual pricing'},{id:randomUUID(),text:'Use monthly pricing'},{id:randomUUID(),text:'Use annual pricing'}];
 await cloud.chat({...input,checkpoint:saved,appliedUpdates:commands});
 assert.deepEqual(updateTexts(last),commands.map(c=>`User update for this task: ${c.text}`));
});

test('real cloud heartbeat storage failure is failed, never a user stop',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const state=durableState(),id=randomUUID();let providerSignal,fail=false;
 const cloud=cloudFixture(async(_body,{signal})=>{
  providerSignal=signal;
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 });
 state.beforeCommit=async()=>{if(fail){fail=false;throw Error('Offline heartbeat storage failure');}};
 const engine=createBots({withState:state.withState,execute:p=>cloudRun(cloud,p)});
 t.after(async()=>{if(engine.activeCount())await engine.stop('owner',id);await until(()=>engine.activeCount()===0);});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Read prices'});
 await until(()=>providerSignal);fail=true;t.mock.timers.tick(20000);
 await until(()=>engine.activeCount()===0);
 const job=state.snapshot().jobs[0];assert.equal(job.status,'failed');
 assert.doesNotMatch(job.error,/^Stopped\./);
 assert(providerSignal.aborted);
});

for(const cause of ['user stop','timeout','lease expiry','lease superseded'])test(`real cloud ${cause} preserves its own failure reason and fences late output`,async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const state=durableState(),id=randomUUID();let at=1000,providerSignal;
 const cloud=cloudFixture(async(_body,{signal})=>{
  providerSignal=signal;
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 });
 const engine=createBots({withState:state.withState,now:()=>at,timeoutMs:cause==='timeout'?25:240000,execute:p=>cloudRun(cloud,p)});
 t.after(async()=>{if(engine.activeCount())await engine.stop('owner',id);await until(()=>engine.activeCount()===0);});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Read prices'});
 await until(()=>providerSignal);
 if(cause==='user stop')await engine.stop('owner',id);
 if(cause==='lease expiry'){at+=180001;t.mock.timers.tick(20000);}
 if(cause==='lease superseded'){
  await state.withState('owner',st=>{st.jobs[0].worker='new-owner-fixture';st.jobs[0].attempt=2;st.jobs[0].draft='New worker progress';});
  t.mock.timers.tick(20000);
 }
 await until(()=>engine.activeCount()===0);
 const job=state.snapshot().jobs[0];assert(providerSignal.aborted);assert.equal(job.result,undefined);
 if(cause==='user stop'){assert.equal(job.status,'stopped');assert.match(job.error,/^Stopped\./);}
 if(cause==='timeout'){assert.equal(job.status,'failed');assert.match(job.error,/time budget/);}
 if(cause==='lease expiry'){assert.equal(job.status,'interrupted');assert.match(providerSignal.reason.message,/lease/i);}
 if(cause==='lease superseded'){
  assert.match(providerSignal.reason.message,/lease/i);assert.equal(job.status,'running');
  assert.equal(job.worker,'new-owner-fixture');assert.equal(job.draft,'New worker progress');
 }
});

test('catching a failed durable checkpoint cannot restore permission for effects',async()=>{
 const state=durableState(),id=randomUUID();let effects=0,failed=false;
 state.beforeCommit=async st=>{if(st.jobs[0]?.checkpoint?.fixture&&!failed){failed=true;throw Error('Offline checkpoint commit failure');}};
 const engine=createBots({withState:state.withState,execute:async p=>{
  try{await p.onCheckpoint({version:1,fixture:true});}catch{/* Simulate a caller trying to continue after storage recovers. */}
  await p.ensure();effects++;return {reply:'Must not run'};
 }});
 await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Save progress before acting'});
 await until(()=>engine.activeCount()===0);
 assert.equal(effects,0);assert.equal(state.snapshot().jobs[0].status,'failed');
 assert.equal(state.snapshot().jobs[0].checkpoint,undefined,'Failed commits never become trusted checkpoints');
});

test('legacy updates without IDs reject ambiguous repeats instead of silently dropping instructions',async()=>{
 const cloud=cloudFixture(async()=>reply([{text:'Must not be called'}]));
 await assert.rejects(cloud.chat({text:'Compare prices',bot:{id:'research',mode:'research',role:'Read',runId:'legacy-repeat'},
  appliedUpdates:['Use annual pricing','Use monthly pricing','Use annual pricing']}),/legacy update.*command ID.*cannot safely/i);
});

test('failed post-effect checkpoint leaves the durable mutation fence and blocks Retry',async()=>{
 const state=durableState(),id=randomUUID();let writes=0,reads=0,fail=true;
 const cloud=cloudFixture(async()=>reply([{functionCall:{name:'save_memory',args:{text:'Save once'}}},today()]));
 state.beforeCommit=async st=>{
  const cp=st.jobs.at(-1)?.checkpoint;
  if(fail&&cp?.pending?.index===1&&!cp.inFlight){fail=false;throw Error('Offline post-effect checkpoint failure');}
 };
 const engine=createBots({withState:state.withState,execute:p=>cloudRun(cloud,p,{memory:{
  save:async()=>{writes++;return {id:'inert-note',title:'Saved',dates:[]};},today:async()=>{reads++;return {items:[]};},
 }})});
 await engine.run('owner',{requestId:id,botId:'echo-assistant',revision:1,goal:'Save once, then read Today'});
 await until(()=>engine.activeCount()===0);
 const job=state.snapshot().jobs[0];assert.equal(job.status,'failed');
 assert.equal(job.checkpoint.inFlight.mutating,true);assert.equal(writes,1);assert.equal(reads,0);
 await assert.rejects(engine.control('owner',{...retry(id),botId:'echo-assistant'}),/may already have happened/);
 assert.equal(writes,1);assert.equal(state.snapshot().jobs.length,1);
});
