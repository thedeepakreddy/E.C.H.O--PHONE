/* Animation never changes runner state. Unknown activity is not invented. */
export function behaviorFor(agent,online=true){
 if(!online)return 'offline';
 const s=agent?.status;
 if(['needs-you','needs-input'].includes(s)||agent?.result?.question)return 'needs-input';
 if(['cancelled','stopped','interrupted','failed','blocked'].includes(s))return 'stopped';
 if(['done','completed'].includes(s))return 'completed';
 if(['queued','pending'].includes(s))return agent?.waitingFor?.length?'dependency':'queued';
 if(!['working','running'].includes(s))return 'idle';
 if(agent?.activity?.kind==='reading')return 'reading';
 if(agent?.activity?.kind==='writing')return 'writing';
 return 'working';
}
export function createBehaviorTracker(){
 const states=new Map();
 return {update(agent,online,time){
  const key=agent.executionKey||`${agent.id}:${agent.attempt??1}`,old=states.get(agent.id),base=behaviorFor(agent,online);
  const applied=new Set((agent.commands??[]).filter(c=>c.status==='applied').map(c=>c.id));
  let until=old?.key===key?old.until:0;
  if(old?.key===key&&online&&['working','reading','writing'].includes(base)&&(agent.commands??[]).some(c=>c.operation==='update'&&c.status==='applied'&&!old.applied.has(c.id)))until=time+1100;
  states.set(agent.id,{key,applied,until});return until>time&&online&&['working','reading','writing'].includes(base)?'acknowledge':base;
 },clear(){states.clear();}};
}
