import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRelay} from '../server.js';
import {signPass} from '../lib/secure.js';
import {checkMacUpdate} from '../lib/mac-updates.js';
const SECRET='u'.repeat(48),DEVICE='a'.repeat(32),OTHER='b'.repeat(32),NOW=Date.now();
const subscription=n=>({endpoint:`http://push.test/${n}`,keys:{p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'}});
const update=(extra={})=>({id:'event-0001',sessionId:'session-0001',generation:0,devices:[DEVICE],at:NOW,expiresAt:NOW+86400_000,title:'Echo finished a task',body:'Report checked and saved.',kind:'finished',...extra});
test('validates bounded updates and expiry without accepting commands or URLs',()=>{
 assert.equal(checkMacUpdate(update(),NOW,0).kind,'finished');
 for(const b of [update({generation:1}),update({devices:['../../secrets']}),update({at:NOW+120000}),update({expiresAt:NOW}),update({body:'a'.repeat(1001)}),update({kind:'execute'})])assert.throws(()=>checkMacUpdate(b,NOW,0));
});
test('paired updates: isolation, durable inbox, retries, multi-installations, revocation and expiry',async()=>{
 let time=NOW,fail=true;const attempts=[];
 const relay=createRelay({secret:SECRET,now:()=>time,pollMs:10,pushAnyHost:true,fetchJson:async()=>({}),pushFetch:async url=>{attempts.push(url);return {status:url.endsWith('/two')&&fail?503:201};}});
 const server=http.createServer(relay.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const pass=(d,phoneOnly=false,gen=0)=>signPass(relay.keys.pass,{device:d,phoneOnly,gen,now:time});
 const call=(p,b,auth)=>fetch(base+p,{method:b?'POST':'GET',headers:auth?{...auth,'content-type':'application/json'}:{},body:b?JSON.stringify(b):undefined});
 const phone=(p,b,d=DEVICE,standalone=false,gen=0)=>call(p,b,{'x-echo-pass':pass(d,standalone,gen)});
 const mac=(p,b)=>call(p,b,{authorization:`Bearer ${SECRET}`});
 try{
  assert.equal((await call('/agent/updates')).status,404);
  assert.equal((await mac('/agent/updates')).status,200);assert.deepEqual((await (await mac('/agent/updates')).json()).devices,[]);
  await phone('/cloud/status');await phone('/cloud/push/subscribe',{subscription:subscription('one'),installation:'installation-one'});
  await phone('/cloud/push/subscribe',{subscription:subscription('two'),installation:'installation-two'});
  await phone('/cloud/push/subscribe',{subscription:subscription('standalone'),installation:'standalone-other'},OTHER,true);
  const inventory=await (await mac('/agent/updates')).json();assert.deepEqual(inventory.devices,[DEVICE]);assert.equal(inventory.pushDevices,1);
  assert.equal((await phone('/cloud/mac-updates',undefined,OTHER,true)).status,403);
  const first=await (await mac('/agent/updates',update({devices:[DEVICE,OTHER]}))).json();assert.equal(first.recipients,1);assert.equal(first.pushes,1);assert.equal(first.pending,true);
  assert.deepEqual(attempts,['http://push.test/one','http://push.test/two']);
  const inbox=await (await phone('/cloud/mac-updates')).json();assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].body,update().body);assert.equal(inbox.items[0].devices,undefined);assert.equal(inbox.items[0].delivered,undefined);
  fail=false;const retry=await (await mac('/agent/updates',update({devices:[DEVICE,OTHER]}))).json();assert.equal(retry.pending,false);assert.equal(retry.pushes,2);assert.deepEqual(attempts,['http://push.test/one','http://push.test/two','http://push.test/two']);
  await mac('/agent/updates',update({devices:[DEVICE,OTHER]}));assert.equal(attempts.length,3,'ack retries do not repeat successful notifications');
  assert.equal((await mac('/agent/updates',update({devices:[DEVICE,OTHER],body:'Modified under reused ID'}))).status,400);
  assert.equal((await (await phone('/cloud/mac-updates')).json()).items.length,1);
  // Paired inbox works without push subscriptions too.
  await phone('/cloud/status',undefined,OTHER);const stored=await (await mac('/agent/updates',update({id:'event-0002',devices:[OTHER]}))).json();assert.equal(stored.recipients,1);assert.equal(stored.pushes,0);assert.equal((await (await phone('/cloud/mac-updates',undefined,OTHER)).json()).items.length,1);
  time+=31*86400_000;assert.deepEqual((await (await mac('/agent/updates')).json()).devices,[],'expired paired sessions do not receive owner data');
  time=NOW;await call('/agent/poll',undefined,{authorization:`Bearer ${SECRET}`,'x-echo-pass-gen':'1'});
  const revoked=await (await mac('/agent/updates')).json();assert.equal(revoked.generation,1);assert.deepEqual(revoked.devices,[]);assert.equal((await phone('/cloud/mac-updates')).status,401);assert.equal((await mac('/agent/updates',update())).status,400);
  await phone('/cloud/status',undefined,DEVICE,false,1);assert.equal((await (await phone('/cloud/mac-updates',undefined,DEVICE,false,1)).json()).items.length,0,'revoked-generation inbox is not resurrected on a new pairing');
 }finally{server.closeAllConnections();server.close();}
});
