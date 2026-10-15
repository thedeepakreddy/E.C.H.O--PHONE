import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloud,CloudError} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';
import {runAgentTurn,runToolAttempt} from '../lib/vendor/openbot/agent-turn.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const call=(id,name,args={})=>({functionCall:{id,name,args}});
const response=parts=>({candidates:[{content:{role:'model',parts}}]});
const owner=(runId='run-a',attempt=1)=>({text:'Inert fixture task',bot:{id:'echo-assistant',name:'Echo',role:'Fixture',mode:'assist',runId},context:{requestId:`request-${runId}`,attempt}});
function fixture(parts,memory={},extra={}){
 const events=[],checkpoints=[];let round=0;
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'inert',generate:async()=>response(round++===0?parts:[{text:'Fixture finished.'}])}});
 return {events,checkpoints,run:options=>cloud.chat({...owner(),memory,onEvent:async e=>events.push(e),onCheckpoint:async cp=>checkpoints.push(structuredClone(cp)),...extra,...options})};
}
const lifecycle=events=>events.filter(e=>['TOOL_CALL_START','TOOL_CALL_END'].includes(e.type));
function assertPair(events,toolCallId,status='success'){
 const pair=lifecycle(events).filter(e=>e.toolCallId===toolCallId);
 assert.deepEqual(pair.map(e=>e.type),['TOOL_CALL_START','TOOL_CALL_END']);
 for(const field of ['botId','runId','requestId','attempt','toolCallId','toolAttemptId']){
  assert.notEqual(pair[0][field],undefined,`${field} is host-correlated`);
  assert.equal(pair[0][field],pair[1][field]);
 }
 assert.equal(pair[1].status,status);
 return pair;
}

test('assembling model calls emits no tool execution activity',async()=>{
 const events=[];
 const assembled=await runAgentTurn({threadId:'bot',runId:'model-round'},async()=>(async function*(){
  yield {choices:[{delta:{tool_calls:[{index:0,id:'queued',function:{name:'get_today',arguments:'{}'}}]}}]};
 })(),async event=>events.push(event));
 assert.equal(assembled.calls[0].id,'queued');
 assert.equal(events.filter(event=>event.type.startsWith('TOOL_CALL_')).length,0);
});
test('a late queued call starts only when its actual attempt begins',async()=>{
 const entered=deferred(),release=deferred(),order=[];let reads=0;
 const f=fixture([call('first','get_today'),call('second','get_today')],{today:async()=>{
  order.push(`execute-${++reads}`);if(reads===1){entered.resolve();await release.promise;}return {items:[]};
 }});
 const running=f.run({onEvent:async event=>{f.events.push(event);if(event.type==='TOOL_CALL_START')order.push(`start-${event.toolCallId}`);}});
 try{
  await entered.promise;
  assert.deepEqual(lifecycle(f.events).map(e=>[e.type,e.toolCallId]),[['TOOL_CALL_START','first']]);
  assert.deepEqual(order,['start-first','execute-1']);
 }finally{release.resolve();await running;}
 assertPair(f.events,'first');assertPair(f.events,'second');
 assert.deepEqual(order,['start-first','execute-1','start-second','execute-2']);
});
test('essential questions leave later queued calls unannounced and durable',async()=>{
 let reads=0;
 const f=fixture([call('question','ask_person',{question:'Which date?'}),call('skipped','get_today')],{today:async()=>{reads++;return {};}});
 const result=await f.run();assert.equal(result.question,'Which date?');assert.equal(reads,0);
 assertPair(f.events,'question','waiting');
 assert.ok(!f.events.some(e=>e.toolCallId==='skipped'));
 assert.equal(f.checkpoints.at(-1).pending.index,1);
 assert.equal(f.checkpoints.at(-1).pending.calls[1].id,'skipped');
});
test('abort during the durable pre-attempt checkpoint announces no skipped calls',async()=>{
 const abort=new AbortController();let reads=0;
 const f=fixture([call('aborted','get_today')],{today:async()=>{reads++;return {};}});
 await assert.rejects(f.run({signal:abort.signal,onCheckpoint:async cp=>{if(cp.inFlight)abort.abort();}}),/stopped/i);
 assert.equal(reads,0);assert.equal(lifecycle(f.events).length,0);
});
test('a revised saved task never emits execution events for its old queued arguments',async()=>{
 const f=fixture([call('question','ask_person',{question:'Which date?'}),call('old','get_today')],{today:async()=>({})});
 await f.run();
 const saved={...f.checkpoints.at(-1),continuation:{kind:'revise',text:'Use the new scope'}};
 const events=[];
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'inert',generate:async()=>response([{text:'Revised fixture result.'}])}});
 await cloud.chat({...owner('revised',2),memory:{},checkpoint:saved,onEvent:async e=>events.push(e)});
 assert.equal(lifecycle(events).length,0);
});
test('actual failed and denied attempts each have one matching end',async()=>{
 const failed=fixture([call('failed','get_today')],{today:async()=>{throw new CloudError('failed','Fixture read failed');}});
 await assert.rejects(failed.run(),/Fixture read failed/);assertPair(failed.events,'failed','failed');
 const denied=fixture([call('denied','save_memory',{text:'Forbidden'})],{save:async()=>{throw Error('must not execute');}});
 await denied.run({bot:{...owner().bot,id:'research',mode:'research'}});
 assertPair(denied.events,'denied','denied');
});
test('unknown writes close telemetry without clearing their checkpoint replay guard',async()=>{
 const f=fixture([call('write','save_memory',{text:'Once'})],{save:async()=>{throw Error('Fixture connection lost');}});
 await assert.rejects(f.run(),/may already have happened/);
 assertPair(f.events,'write','uncertain');
 assert.equal(f.checkpoints.at(-1).inFlight.mutating,true);
 assert.equal(f.checkpoints.at(-1).pending.index,0);
});
test('same-name overlapping tools cannot turn the newer attempt idle when the old one ends',async()=>{
 const oldEntered=deferred(),newEntered=deferred(),oldRelease=deferred(),newRelease=deferred();
 const events=[];let active;
 const onEvent=async event=>{
  events.push(event);
  if(event.type==='TOOL_CALL_START'&&event.requestId==='request-new')active=event.toolAttemptId;
  if(event.type==='TOOL_CALL_END'&&event.requestId==='request-new'&&event.toolAttemptId===active)active=null;
 };
 const old=fixture([call('same-call','get_today')],{today:async()=>{oldEntered.resolve();await oldRelease.promise;return {};}});
 const newer=fixture([call('same-call','get_today')],{today:async()=>{newEntered.resolve();await newRelease.promise;return {};}});
 const oldRun=old.run({...owner('old',1),onEvent});await oldEntered.promise;
 const newRun=newer.run({...owner('new',2),onEvent});await newEntered.promise;
 try{
  assert.ok(active,'the newer tool is actually running');
  oldRelease.resolve();await oldRun;
  assert.ok(active,'an old attempt completion cannot report the newer tool idle');
  const starts=events.filter(e=>e.type==='TOOL_CALL_START');
  assert.equal(starts.length,2);assert.notEqual(starts[0].toolAttemptId,starts[1].toolAttemptId);
  assert.deepEqual(starts.map(e=>e.attempt),[1,2]);
 }finally{oldRelease.resolve();newRelease.resolve();await Promise.all([oldRun,newRun]);}
 assert.equal(active,null);
});
test('sync telemetry observers cannot replace the actual tool error',async()=>{
 const events=[],error=new Error('actual fixture failure');
 await assert.rejects(runToolAttempt({toolCallId:'sync',toolAttemptId:'one',toolCallName:'get_today'},async()=>{throw error;},e=>events.push(e)),e=>e===error);
 assert.deepEqual(lifecycle(events).map(e=>e.type),['TOOL_CALL_START','TOOL_CALL_END']);
 assert.equal(events.at(-1).status,'failed');
});
test('explicit unsuccessful tool outcomes are not reported as success',async()=>{
 for(const status of ['failed','denied','uncertain','cancelled']){
  const events=[];
  await runToolAttempt({toolCallId:'returned',toolAttemptId:'one',toolCallName:'get_today'},async()=>({status}),async e=>events.push(e));
  assert.equal(events.at(-1).status,status);
 }
});
test('reusing a completed effect has no new execution activity',async()=>{
 let round=0,writes=0;const events=[];
 const cloud=createCloud({store:createStore({key:Buffer.alloc(32)}),tools:{},gemini:{model:'inert',generate:async()=>response(
  round++<2?[call(`write-${round}`,'save_memory',{text:'Once'})]:[{text:'One actual saved note.'}]
 )}});
 await cloud.chat({...owner(),memory:{save:async()=>{writes++;return {id:'note',title:'Saved',dates:[]};}},onEvent:async e=>events.push(e)});
 assert.equal(writes,1);assertPair(events,'write-1');
 assert.ok(!events.some(e=>e.toolCallId==='write-2'),'a replayed result never claims another execution');
});
