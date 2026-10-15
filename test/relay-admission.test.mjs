import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRelay,MAX_QUEUE,MAX_BODY} from '../server.js';
import {createStore} from '../lib/store.js';
import {deriveKeys,signPass} from '../lib/secure.js';
import {botState} from '../lib/bots.js';
const secret='offline-relay-admission-fixture-'.repeat(2);
async function start(t,options={}){
 const relay=createRelay({secret,pollMs:10,requestMs:1200,...options});
 const server=http.createServer(relay.handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 return {relay,server,base,agent:path=>fetch(base+path,{headers:{authorization:`Bearer ${secret}`}})};
}
const eventually=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Fixture state did not settle');};
function slowBody(base){const req=http.request(base+'/status',{method:'POST',headers:{'content-length':'20'}});req.on('error',()=>{});req.on('response',res=>res.resume());req.write('x');return req;}
test('clean bot polls do not write sealed state; a real cleanup does write once',async t=>{
 const store=createStore({key:deriveKeys(secret).store});const device='a'.repeat(32),key=`bots:${device}`;
 await store.set(key,botState());let writes=0;const realSet=store.set;store.set=async(k,...args)=>{if(k===key)writes++;return realSet(k,...args);};
 const {base,relay}=await start(t,{store});const pass=signPass(relay.keys.pass,{device,gen:0,phoneOnly:true});
 for(let i=0;i<2;i++)assert.equal((await fetch(base+'/cloud/bots',{headers:{'x-echo-pass':pass}})).status,200);
 assert.equal(writes,0,'A function-valued save predicate must be evaluated, not treated as truthy');
 const state=botState();state.jobs.push({id:'stale',status:'running',leaseUntil:0,commands:[]});await realSet(key,state);
 await fetch(base+'/cloud/bots',{headers:{'x-echo-pass':pass}});assert.equal(writes,1);
 await fetch(base+'/cloud/bots',{headers:{'x-echo-pass':pass}});assert.equal(writes,1,'The cleaned state is not rewritten on the next poll');
});
test('relay admission is bounded while concurrent request bodies are unfinished and releases disconnects',async t=>{
 const {base,relay,agent,server}=await start(t,{requestMs:5000});await agent('/agent/poll');
 let received=0;server.on('request',req=>{if(req.url==='/status')received++;});
 const bodies=Array.from({length:MAX_QUEUE},()=>slowBody(base));t.after(()=>bodies.forEach(req=>req.destroy()));
 await eventually(()=>received===MAX_QUEUE);
 const overflow=await fetch(base+'/status');assert.equal(overflow.status,503);assert.equal((await overflow.json()).error,'busy');
 assert.equal(relay.state().admitted,MAX_QUEUE);assert.equal(relay.state().queued,0);
 bodies[0].destroy();await eventually(()=>relay.state().admitted===MAX_QUEUE-1);
 const replacement=slowBody(base);t.after(()=>replacement.destroy());await eventually(()=>relay.state().admitted===MAX_QUEUE);
 for(const req of bodies)req.destroy();replacement.destroy();await eventually(()=>relay.state().admitted===0);
 assert.equal(relay.state().queued,0,'An aborted body never becomes a later ghost request');
});
test('body deadline and Mac disconnect release admission without later ghost jobs',async t=>{
 const {base,relay,agent}=await start(t,{requestMs:80,pollMs:200});await agent('/agent/poll');
 const body=slowBody(base);t.after(()=>body.destroy());await eventually(()=>relay.state().admitted===1);
 await eventually(()=>relay.state().admitted===0);body.end('x'.repeat(19));await new Promise(resolve=>setImmediate(resolve));assert.equal(relay.state().queued,0);
 // A hanging poll disconnected by the Mac also cancels unfinished phone bodies.
 const pending=http.request(base+'/agent/poll',{headers:{authorization:`Bearer ${secret}`}});pending.on('error',()=>{});pending.end();
 const second=slowBody(base);t.after(()=>second.destroy());await eventually(()=>relay.state().admitted===1);
 pending.destroy();await eventually(()=>relay.state().admitted===0);assert.equal(relay.state().queued,0);
});
test('reply releases an in-flight reservation exactly once',async t=>{
 const {base,relay,agent}=await start(t);await agent('/agent/poll');
 const phone=fetch(base+'/status');await eventually(()=>relay.state().queued===1);
 const job=await (await agent('/agent/poll')).json();assert.equal(relay.state().admitted,1);assert.equal(relay.state().inFlight,1);
 const reply=()=>fetch(base+'/agent/reply',{method:'POST',headers:{authorization:`Bearer ${secret}`},body:JSON.stringify({id:job.id,status:200,body:Buffer.from('{}').toString('base64')})});
 assert.equal((await reply()).status,204);assert.equal((await phone).status,200);assert.equal(relay.state().admitted,0);
 await reply();assert.equal(relay.state().admitted,0,'A duplicate receipt cannot release another request');
});
test('oversized bodies release their reservation and are never dispatched',async t=>{
 const {base,relay,agent}=await start(t);await agent('/agent/poll');
 const response=await fetch(base+'/status',{method:'POST',body:Buffer.alloc(MAX_BODY+1)});
 assert.equal(response.status,413);assert.equal(relay.state().admitted,0);assert.equal(relay.state().queued,0);
});
