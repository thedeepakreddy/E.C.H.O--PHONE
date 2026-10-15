import test from 'node:test';
import assert from 'node:assert/strict';
import {createGemini, GeminiError} from '../lib/gemini.js';
import * as clients from '../lib/gemini.js';
import {createCloud} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

const answer=text=>({candidates:[{content:{role:'model',parts:[{text}]}}]});
const tools=parts=>({candidates:[{content:{role:'model',parts}}]});
function cloudFixture(generate, extra={}) {
 const gemini={model:'gemini-3.8-flash',fallbackModels:['gemini-3.5-flash-lite'],generate,...extra};
 return {gemini,cloud:createCloud({gemini,store:createStore({key:Buffer.alloc(32)}),tools:{}})};
}

test('Google high demand is not retried against the same unavailable model for another 45 seconds',async()=>{
 let calls=0;
 const client=createGemini({apiKey:'fixture',sleep:async()=>{},fetchImpl:async()=>{calls++;return Response.json({error:{message:'high demand'}},{status:503});}});
 await assert.rejects(client.generate({contents:[]}),e=>e.kind==='server');
 assert.equal(calls,1);
});

test('a stalled provider or response body is bounded, even if its transport ignores abort',{timeout:1000},async()=>{
 for(const fetchImpl of [async()=>new Promise(()=>{}),async()=>({ok:true,json:()=>new Promise(()=>{})})]) {
  const client=createGemini({apiKey:'fixture',requestTimeoutMs:20,fetchImpl});
  const started=Date.now();
  await assert.rejects(client.generate({contents:[]}),e=>e.kind==='server');
  assert.ok(Date.now()-started<1000);
 }
});

test('Stop during quota backoff prevents any later provider request',async()=>{
 const stop=new AbortController();let calls=0;
 const client=createGemini({apiKey:'fixture',sleep:async()=>{stop.abort(Error('fixture stopped'));},fetchImpl:async()=>{
  calls++;return Response.json({error:{details:[{retryDelay:'1s'}]}},{status:429});
 }});
 await assert.rejects(client.generate({contents:[]},{signal:stop.signal}),/fixture stopped/);
 assert.equal(calls,1);
});

test('non-JSON auth and invalid-request responses do not become retryable transport failures',async()=>{
 for(const [status,kind] of [[401,'auth'],[403,'auth'],[400,'other'],[429,'minute']]) {
  const client=createGemini({apiKey:'fixture',sleep:async()=>{},fetchImpl:async()=>new Response('not JSON',{status})});
  await assert.rejects(client.generate({contents:[]}),e=>e.kind===kind);
 }
});

test('known HTTP auth/quota/input status survives a stalled error body',async()=>{
 for(const [status,kind] of [[400,'other'],[401,'auth'],[403,'auth'],[429,'minute']]) {
  const client=createGemini({apiKey:'fixture',requestTimeoutMs:10,sleep:async()=>{},fetchImpl:async()=>({ok:false,status,json:()=>new Promise(()=>{})})});
  await assert.rejects(client.generate({contents:[]}),e=>e.kind===kind);
 }
});

test('fallback candidates come only from available stable general models and prefer fast Lite',()=>{
 assert.equal(typeof clients.pickFallbackModels,'function');
 assert.deepEqual(clients.pickFallbackModels(['gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.8-flash-lite-tts','gemini-4-flash-preview'],'gemini-3.8-flash'),['gemini-3.5-flash-lite']);
 assert.deepEqual(clients.pickFallbackModels(['gemini-3.8-flash'],'gemini-3.8-flash'),[]);
 assert.deepEqual(clients.pickFallbackModels(['gemini-3.6-flash','gemini-3.8-flash'],'gemini-3.8-flash'),['gemini-3.6-flash']);
});

test('chat recovers on one advertised fallback, labels it and pins subsequent tool rounds to that model',async()=>{
 const seen=[];let fallbackRound=0;
 const {cloud,gemini}=cloudFixture(async(body,{modelId})=>{
  seen.push(modelId);
  if(modelId===gemini.model)throw new GeminiError('server','high demand');
  return fallbackRound++===0?tools([{functionCall:{name:'echo_expression',args:{expression:'attentive'}}}]):answer('Hello from Echo.');
 });
 const result=await cloud.chat({text:'Hi'});
 assert.equal(result.reply,'Hello from Echo.');
 assert.deepEqual(result.modelInfo,{requested:'gemini-3.8-flash',used:'gemini-3.5-flash-lite',fallback:true});
 assert.deepEqual(seen,['gemini-3.8-flash','gemini-3.5-flash-lite','gemini-3.5-flash-lite']);
 assert.equal(gemini.model,'gemini-3.8-flash','one turn cannot change the global configured brain');
});

test('all unavailable models produce an honest safely retryable error without an unbounded chain',async()=>{
 const seen=[];const {cloud}=cloudFixture(async(_b,{modelId})=>{seen.push(modelId);throw new GeminiError('server','high demand');});
 await assert.rejects(cloud.chat({text:'Hi'}),e=>e.kind==='unavailable'&&e.retryable===true&&/busy|unavailable/i.test(e.message));
 assert.equal(seen.length,2);
});

test('authentication and quota errors never switch models',async()=>{
 for(const kind of ['auth','day','minute','other']) {
  let requests=0;const {cloud}=cloudFixture(async()=>{requests++;throw new GeminiError(kind,'fixture rejection');});
  await assert.rejects(cloud.chat({text:'Hi'}),e=>e.kind!=='unavailable');
  assert.equal(requests,1);
 }
});

test('failure after a completed write does not switch brains or offer whole-turn retry',async()=>{
 let requests=0,writes=0;
 const {cloud}=cloudFixture(async()=>++requests===1?tools([{functionCall:{name:'save_memory',args:{text:'Keep this once'}}}]):Promise.reject(new GeminiError('server','high demand')));
 await assert.rejects(cloud.chat({text:'Remember this',memory:{save:async()=>{writes++;return {id:'saved',title:'One note'};}}}),e=>e.kind==='unavailable'&&e.retryable===false);
 assert.equal(writes,1);assert.equal(requests,2);
});

test('a bot checkpoint keeps fallback model provenance without redoing accepted provider work',async()=>{
 let saved,round=0;const seen=[];
 const {cloud}=cloudFixture(async(_b,{modelId})=>{
  seen.push(modelId);if(modelId==='gemini-3.8-flash')throw new GeminiError('server','high demand');
  return round++===0?tools([{functionCall:{name:'ask_person',args:{question:'Which date?'}}}]):answer('Ready.');
 });
 const bot={id:'research',name:'Research',role:'Read',mode:'research',runId:'fixture'};
 const result=await cloud.chat({text:'Plan it',bot,onCheckpoint:async cp=>{saved=cp;}});
 assert.equal(result.modelInfo.used,'gemini-3.5-flash-lite');
 assert.equal(saved.modelInfo.used,'gemini-3.5-flash-lite');
 const resumed=await cloud.chat({text:'Tomorrow',bot,checkpoint:{...saved,finished:false,out:{...saved.out,question:null}},onCheckpoint:async()=>{}});
 assert.equal(resumed.modelInfo.used,'gemini-3.5-flash-lite');
 assert.equal(seen.filter(m=>m==='gemini-3.8-flash').length,1);
});
