import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRelay} from '../server.js';
import {GeminiError} from '../lib/gemini.js';

const answer={candidates:[{content:{role:'model',parts:[{text:'Hello. I am here.'}]}}]};
async function fixture(t,generate) {
 const relay=createRelay({secret:'local-cloud-recovery-fixture-'.repeat(3),gemini:{model:'gemini-3.8-flash',fallbackModels:['gemini-3.5-flash-lite'],generate}});
 const server=http.createServer(relay.handler);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>{server.closeAllConnections();server.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const session=await (await fetch(`${origin}/phone/session`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
 async function request(path,body,signal) {
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'x-echo-pass':session.cloudPass,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal});
  return {status:response.status,...await response.json()};
 }
 return {request};
}

test('real chat and voice routes return retryable overload errors, and recovery receipts prevent duplicate requests',async t=>{
 let unavailable=true;const models=[];
 const f=await fixture(t,async(_body,{modelId})=>{
  models.push(modelId);
  if(unavailable||modelId==='gemini-3.8-flash')throw new GeminiError('server','high demand');
  return answer;
 });
 const thread=(await f.request('/cloud/conversations',{action:'create'})).thread;
 const request={text:'Hi',requestId:'fixture-original-request',threadId:thread.id};
 const failed=await f.request('/cloud/chat',request);
 assert.equal(failed.status,503);assert.equal(failed.error,'unavailable');assert.equal(failed.retryable,true);
 assert.equal(failed.retryVersion,'');
 const voice=await f.request('/cloud/voice',{audio:'A'.repeat(120),requestId:'fixture-voice-request',threadId:thread.id});
 assert.equal(voice.status,503);assert.equal(voice.retryable,true);
 unavailable=false;
 const recovered=await f.request('/cloud/chat',{...request,retryVersion:failed.retryVersion});
 assert.equal(recovered.status,200);assert.equal(recovered.modelInfo.used,'gemini-3.5-flash-lite');
 const count=models.length;
 const repeat=await f.request('/cloud/chat',request);
 assert.equal(repeat.reply,recovered.reply);assert.equal(models.length,count);
 const history=await f.request(`/cloud/conversations?id=${thread.id}`);
 assert.equal(history.thread.messages.length,2);
 assert.deepEqual(history.thread.messages[1].modelInfo,recovered.modelInfo);
});

test('Retry is rejected before generation when newer messages changed its authoritative history',async t=>{
 let fail=true,calls=0;
 const f=await fixture(t,async()=>{calls++;if(fail)throw new GeminiError('server','busy');return answer;});
 const thread=(await f.request('/cloud/conversations',{action:'create'})).thread;
 const original={text:'Original Hi',requestId:'original-stale-fixture',threadId:thread.id};
 const failed=await f.request('/cloud/chat',original);
 assert.equal(failed.retryable,true);
 fail=false;await f.request('/cloud/chat',{text:'A new topic',requestId:'newer-success-fixture',threadId:thread.id});
 const count=calls;
 const rejected=await f.request('/cloud/chat',{...original,retryVersion:failed.retryVersion});
 assert.equal(rejected.status,400);assert.equal(rejected.retryable,false);
 assert.match(rejected.message,/conversation changed|newer messages/i);
 assert.equal(calls,count,'The stale retry never reaches the provider');
});

test('disconnect cancels the model turn and does not start an overload fallback',async t=>{
 let started,aborted;const began=new Promise(resolve=>started=resolve),cancelled=new Promise(resolve=>aborted=resolve);
 const models=[];
 const f=await fixture(t,async(_body,{modelId,signal})=>{
  models.push(modelId);started();
  return new Promise((resolve,reject)=>{
   const stop=()=>{aborted();reject(signal.reason);};
   if(signal.aborted)return stop();
   signal.addEventListener('abort',stop,{once:true});
  });
 });
 const stop=new AbortController();
 const pending=f.request('/cloud/chat',{text:'Hi',requestId:'disconnect-fixture'},stop.signal);
 await began;stop.abort();await assert.rejects(pending);
 await Promise.race([cancelled,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Disconnect did not cancel the model')),1000);timer.unref();})]);
 assert.deepEqual(models,['gemini-3.8-flash']);
});
