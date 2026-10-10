import {createHash} from 'node:crypto';
import {subscriptions,dropSubscription} from './daily.js';
const DAY=86400_000,ID=/^[a-zA-Z0-9-]{8,64}$/,DEVICE=/^[0-9a-f]{32}$/;
const input=(message)=>Object.assign(new Error(message),{input:true});
export function checkMacUpdate(b,now,generation){
 if(!b||!ID.test(b.id)||!ID.test(b.sessionId)||b.generation!==generation||!Array.isArray(b.devices)||!b.devices.length||b.devices.length>100||b.devices.some(d=>typeof d!=='string'||!DEVICE.test(d)))throw input('Invalid update identity.');
 if(!Number.isFinite(b.at)||!Number.isFinite(b.expiresAt)||b.at>now+60000||b.expiresAt<=now||b.expiresAt-b.at>DAY+60000||now-b.at>DAY)throw input('This update expired.');
 if(typeof b.title!=='string'||!b.title.trim()||b.title.length>100||typeof b.body!=='string'||b.body.length>1000||!['handoff','progress','needs-you','finished'].includes(b.kind))throw input('Invalid update content.');
 return {id:b.id,sessionId:b.sessionId,generation:b.generation,devices:[...new Set(b.devices)],at:b.at,expiresAt:b.expiresAt,title:b.title,body:b.body,kind:b.kind};
}
export function pairedDevice(dev,generation,now){return !!dev&&!dev.suspended&&dev.pairedSession?.gen===generation&&dev.pairedSession.exp>now;}
export function createMacUpdates({withPhones,withKey,push,now,generation}){
 const inventory=()=>withPhones(phones=>{
  const devices=Object.entries(phones.devices).filter(([,d])=>pairedDevice(d,generation(),now()));
  return {generation:generation(),devices:devices.map(([id])=>id),pushDevices:devices.filter(([,d])=>subscriptions(d).some(s=>!s.phoneOnly)).length};
 },{save:false});
 const receive=async raw=>{
  const b=checkMacUpdate(raw,now(),generation());let recipients=0,pushes=0,pending=false;
  for(const device of b.devices)await withKey(`macupdates:${device}`,()=>({items:[]}),async st=>{
   st.items=st.items.filter(x=>now()-x.at<7*DAY).slice(-50);
   const hash=createHash('sha256').update(JSON.stringify(b)).digest('hex');
   let item=st.items.find(x=>x.id===b.id);
   if(item&&item.hash!==hash)throw input('This update ID already has different content.');
   // Gate the write and push under the same current paired account check.
   await withPhones(async phones=>{
    const dev=phones.devices[device];if(b.generation!==generation()||!pairedDevice(dev,generation(),now()))return;
    recipients++;
    if(!item){item={...b,devices:undefined,hash,delivered:[]};st.items.push(item);}
    const targets=subscriptions(dev).filter(s=>!s.phoneOnly);
    for(const sub of targets){
     if(item.delivered.includes(sub.id)){pushes++;continue;}
     const r=await push(sub.sub,{title:b.title,body:b.body.slice(0,300),tag:`mac-${b.id}`,url:b.kind==='needs-you'?'/?view=chat':'/?view=missions'}).catch(()=>({ok:false}));
     if(r.gone){dropSubscription(dev,sub.id);item.delivered.push(sub.id);}
     else if(r.ok){item.delivered.push(sub.id);pushes++;}
     else pending=true;
    }
   });
  },{ttl:8*86400});
  return {ok:true,recipients,pushes,pending};
 };
 const list=device=>withKey(`macupdates:${device}`,()=>({items:[]}),st=>({items:st.items.filter(x=>now()-x.at<7*DAY&&x.generation===generation()).slice(-30).reverse().map(({id,at,title,body,kind})=>({id,at,title,body,kind}))}),{save:false});
 return {inventory,receive,list};
}
