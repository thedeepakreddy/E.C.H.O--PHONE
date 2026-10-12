/** Echo's owner-scoped bot roster and durable runs. Agent execution is injected; account identity never comes from a model. */
import {randomUUID} from 'node:crypto';
export const BOT_MODES=['research','write','plan','assist'];
export const DEFAULT_BOTS=[
 {id:'research',name:'Research',mode:'research',role:'Find and verify useful facts. Cite sources and label uncertainty.'},
 {id:'plan',name:'Plan',mode:'plan',role:'Turn the goal into ordered, practical steps. Read Today when relevant and identify missing decisions.'},
 {id:'write',name:'Write',mode:'write',role:'Prepare the actual requested draft or document in a ready-to-use form.'},
 {id:'review',name:'Review',mode:'research',role:'Check the supplied work for errors, missing evidence and useful improvements.'},
 {id:'analyse',name:'Analyse',mode:'research',role:'Analyse the supplied information, explain patterns and distinguish evidence from assumptions.'},
 {id:'echo-assistant',name:'Echo Assistant',mode:'assist',role:'Handle supported daily work using the granted tools. Ask only for essential missing information.'},
].map(b=>({...b,revision:1,custom:false}));
const ACTIVE=new Set(['queued','running']),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,ID=/^[a-z0-9-]{1,64}$/;
const MAX_JOBS=30,MAX_RETRY_RECEIPTS=256,MAX_ATTEMPTS=10;
const BUDGET_EXHAUSTED=Symbol('bot budget exhausted');
const STOPPED_MESSAGE='Stopped. An action already in progress may finish; no further actions will start. Review any saved changes before Follow up.';
const bad=m=>Object.assign(new Error(m),{input:true});
export const botState=()=>({version:1,bots:structuredClone(DEFAULT_BOTS),jobs:[]});
const view=st=>({bots:st.bots,jobs:st.jobs.slice(-MAX_JOBS).reverse().map(({worker,leaseUntil,context,history,checkpoint,botConfig,resumeFallback,...j})=>j)});
const rememberRetry=(st,receipt)=>{st.retryReceipts=[...(st.retryReceipts??[]).slice(1-MAX_RETRY_RECEIPTS),receipt];};
export function createBots({withState,execute,now=Date.now,newId=randomUUID,access=async()=>true,maxActive=4,timeoutMs=240000}) {
 const instance=randomUUID(),workers=new Map();
 let reservedSlots=0;
 async function change(device,fn,readOnly=false){let dirty=false;return withState(device,async st=>{if(!st.bots||!st.jobs)dirty=true;st.bots??=structuredClone(DEFAULT_BOTS);st.jobs??=[];
  if(st.jobs.length>MAX_JOBS){st.jobs=st.jobs.slice(-MAX_JOBS);dirty=true;}
  if(st.retryReceipts?.length>MAX_RETRY_RECEIPTS){st.retryReceipts=st.retryReceipts.slice(-MAX_RETRY_RECEIPTS);dirty=true;}
  for(const j of st.jobs)if(ACTIVE.has(j.status)&&j.leaseUntil<=now()){dirty=true;j.status='interrupted';for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';j.error='Echo restarted or this run lost its connection. Review saved progress before starting a new run.';j.updatedAt=now();}
  return fn(st);
 },{save:()=>!readOnly||dirty});}
 const list=device=>change(device,st=>view(st),true);
 async function claimJob(device,fn){let reserved=false;
  try{const claim=await change(device,st=>fn(st,()=>{if(workers.size+reservedSlots>=maxActive)throw bad('Echo is busy with other bot tasks. Try again shortly.');reservedSlots++;reserved=true;}));return {...claim,reserved};}
  catch(error){if(reserved)reservedSlots--;throw error;}
 }
 function start(device,job,bot,reserved=false){const controller=new AbortController();workers.set(`${device}:${job.id}`,controller);if(reserved)reservedSlots--;void perform(device,job,bot,controller).catch(()=>{});}
 async function retry(device,b){
  if(!Number.isInteger(b.attempt)||b.attempt<1)throw bad('Choose the exact agent attempt to retry.');
  if(await access(device)===false)throw bad('This account cannot run bots.');
  const claim=await claimJob(device,(st,reserve)=>{
   st.retryReceipts??=[];
   const existing=st.retryReceipts.find(r=>r.requestId===b.requestId);
   if(existing){if(existing.id!==b.id||existing.botId!==b.botId||existing.attempt!==b.attempt)throw bad('This command ID belongs to another instruction.');return {receipt:existing,repeated:true,expired:!st.jobs.some(j=>j.id===existing.newRunId)};}
   const parent=st.jobs.find(j=>j.id===b.id&&j.botId===b.botId);if(!parent)throw bad('This agent task no longer exists or its retry history has expired. Refresh and review saved progress before starting a new task.');
   if(b.attempt!==(parent.attempt??1))throw bad('This agent attempt changed. Refresh before retrying it.');
   const previous=st.retryReceipts.find(r=>r.id===b.id&&r.attempt===b.attempt);
   // A retained child is a bounded durable mapping after acknowledgment eviction.
   const linked=st.jobs.find(j=>j.parentId===parent.id&&j.botId===parent.botId&&j.attempt===b.attempt+1);
   const newRunId=previous?.newRunId??linked?.id;
   if(st.jobs.some(j=>(j.id===b.requestId&&j.id!==newRunId)||j.commands?.some(c=>c.id===b.requestId)))throw bad('This command ID belongs to another instruction.');
   if(previous||linked){const receipt={...(previous??{id:b.id,botId:b.botId,attempt:b.attempt,newRunId,message:'Retry already accepted. Returning the existing continuation; no new run was started.'}),requestId:b.requestId};rememberRetry(st,receipt);return {receipt,repeated:true,expired:!st.jobs.some(j=>j.id===newRunId)};}
   if(!['failed','interrupted'].includes(parent.status))throw bad('Only failed or interrupted tasks can be retried.');
   if(b.attempt>=MAX_ATTEMPTS)throw bad('This task reached the limit of 10 attempts. Review saved progress and changes before starting a new task.');
   const bot=st.bots.find(x=>x.id===parent.botId);
   if(!bot||bot.revision!==parent.botRevision||(parent.botConfig&&JSON.stringify(parent.botConfig)!==JSON.stringify(bot)))throw bad('This bot’s revision or tool grants changed. Start a new task after reviewing saved progress.');
   if(parent.checkpoint?.inFlight?.mutating)throw bad(`The ${parent.checkpoint.inFlight.name} action may already have happened. Retry is blocked to avoid doing it twice. Check the saved changes before starting a new task.`);
   if(st.jobs.some(j=>ACTIVE.has(j.status)))throw bad('A bot is already working for you. Wait or stop it first.');
   reserve();
   const exact=parent.checkpoint?.version===1;
   if(!exact&&(parent.events??[]).some((e,i,events)=>e.type==='TOOL_CALL_START'&&['save_memory','update_commitment','remind_me','capture_commitment','organize_conversation','run_bot'].includes(e.tool)&&!events.slice(i+1).some(r=>r.type==='TOOL_CALL_RESULT'&&r.tool===e.tool)))throw bad('An earlier action may already have happened and has no saved outcome. Retry is blocked; check saved changes before starting a new task.');
   const applied=(parent.commands??[]).filter(c=>c.operation==='update'&&c.status==='applied');
   const history=exact?structuredClone(parent.history??[]):[...(parent.history??[]),{role:'user',text:parent.goal},
    {role:'echo',text:`Continuation from saved progress, not an exact provider resume. Partial output: ${parent.draft??parent.result?.reply??'None saved.'}\nSaved activity: ${JSON.stringify(parent.events??[])}\nDo not repeat completed external changes. If their outcome is unclear, ask the user.`}];
   const job={id:b.requestId,parentId:parent.id,botId:bot.id,botName:bot.name,botRevision:bot.revision,botConfig:structuredClone(bot),goal:parent.goal,attempt:b.attempt+1,
    commands:structuredClone(applied),status:'queued',createdAt:now(),updatedAt:now(),worker:instance,leaseUntil:now()+180000,
    events:structuredClone(parent.events??[]),draft:parent.draft,history,context:{...parent.context,device,requestId:b.requestId},checkpoint:exact?structuredClone(parent.checkpoint):undefined,resumeFallback:!exact||parent.resumeFallback||parent.checkpoint?.fallback};
   const receipt={requestId:b.requestId,id:b.id,botId:b.botId,attempt:b.attempt,newRunId:job.id,
    message:!job.resumeFallback?'Retry accepted. Continuing from saved conversation and completed tool results.':'Retry accepted with saved progress and partial output. A full original provider checkpoint is unavailable; this is a fallback continuation, not an exact resume. Writes are blocked to avoid repeating previous changes.'};
   st.jobs=[...st.jobs.slice(1-MAX_JOBS),job];rememberRetry(st,receipt);return {job,bot:structuredClone(bot),receipt,repeated:false};
  });
  if(!claim.repeated){workers.get(`${device}:${b.id}`)?.abort();start(device,claim.job,claim.bot,claim.reserved);}
  return {ok:true,newRunId:claim.receipt.newRunId,message:claim.expired?'Retry was already accepted, but its saved run history has expired. Refresh and review saved progress before starting a new task. No new run was started.':claim.receipt.message,repeated:claim.repeated};
 }
 async function control(device,b){
  if(!UUID.test(b.requestId??'')||!UUID.test(b.id??'')||!['update','stop','revise','retry'].includes(b.operation)||typeof b.botId!=='string'||(['update','revise'].includes(b.operation)&&(typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)))throw bad('Choose a task and enter an instruction in up to 4,000 characters.');
  if(b.operation==='retry')return retry(device,b);
  const command=await change(device,st=>{
   const j=st.jobs.find(j=>j.id===b.id&&j.botId===b.botId);if(!j)throw bad('This agent task no longer exists.');
   j.commands??=[];const prior=j.commands.find(c=>c.id===b.requestId);
   if(prior){if(prior.operation!==b.operation||prior.text!==(b.text?.trim()??'')||prior.attempt!==(b.attempt??1))throw bad('This command ID belongs to another instruction.');return {command:prior,repeated:true,...(b.operation==='revise'?{revised:{botId:j.botId,revision:j.botRevision,goal:`${j.goal}\n\nRevised instruction: ${prior.text}`,parentId:j.id},context:j.context}:{} )};}
   if((b.attempt??1)!==(j.attempt??1))throw bad('This agent attempt changed. Refresh before controlling it.');
   if(!ACTIVE.has(j.status))throw bad('This task already ended. Use Follow up.');
   if(b.operation==='revise'&&`${j.goal}\n\nRevised instruction: ${b.text.trim()}`.length>4000)throw bad('The original task and revision exceed 4,000 characters. Use Stop then Follow up with a shorter task.');
   if(j.commands.length>=40)throw bad('This task has reached its update limit.');
   const c={id:b.requestId,operation:b.operation,text:b.text?.trim()??'',attempt:j.attempt??1,status:b.operation==='stop'?'applied':'queued',createdAt:now()};j.commands.push(c);j.updatedAt=now();
   if(b.operation==='stop'||b.operation==='revise'){j.status='stopped';j.error=STOPPED_MESSAGE;for(const q of j.commands)if(q.status==='queued')q.status='not-applied';}
   return {command:c,...(b.operation==='revise'?{revised:{botId:j.botId,revision:j.botRevision,goal:`${j.goal}\n\nRevised instruction: ${c.text}`,parentId:j.id},context:j.context}:{} )};
  });
  if(b.operation==='stop'||b.operation==='revise')workers.get(`${device}:${b.id}`)?.abort();
  if(b.operation==='revise'){
   let next;try{next=await run(device,{...command.revised,requestId:b.requestId},{...command.context,requestId:b.requestId});}catch(error){await change(device,st=>{const c=st.jobs.find(j=>j.id===b.id)?.commands?.find(c=>c.id===b.requestId);if(c)c.status='not-applied';});throw error;}
   await change(device,st=>{const j=st.jobs.find(j=>j.id===b.id),c=j?.commands?.find(c=>c.id===b.requestId);if(c){c.status='applied';c.appliedAt=now();}});
   return {ok:true,message:'Revised task accepted. Previous effects will not be replayed.',newRunId:next.id,command:{...command.command,status:'applied'}};
  }
  return {ok:true,...command,message:command.command.status==='queued'?'Update queued for the next agent turn.':b.operation==='stop'?'Agent stopped. An action already in progress may finish.':'Update already applied.'};
 }
 async function save(device,b){return change(device,st=>{
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>40||typeof b.role!=='string'||!b.role.trim()||b.role.length>2000||!BOT_MODES.includes(b.mode))throw bad('Give the bot a name, a role in up to 2,000 characters, and a supported capability.');
  const old=b.id?st.bots.find(x=>x.id===b.id):null;if(b.id&&!old)throw bad('This bot no longer exists.');if(old&&(!old.custom||old.revision!==b.revision))throw bad('This bot changed or is built in. Refresh first.');
  if(!old&&st.bots.filter(x=>x.custom).length>=6)throw bad('You can create up to six personal bots.');
  if(old&&st.jobs.some(j=>j.botId===old.id&&ACTIVE.has(j.status)))throw bad('Stop or finish this bot’s run before editing its role.');
  const bot={id:old?.id??`bot-${newId()}`,name:b.name.trim(),role:b.role.trim(),mode:b.mode,custom:true,revision:(old?.revision??0)+1};if(old)st.bots[st.bots.indexOf(old)]=bot;else st.bots.push(bot);return bot;
 });}
 async function remove(device,b){return change(device,st=>{const bot=st.bots.find(x=>x.id===b.id);if(!bot?.custom||bot.revision!==b.revision)throw bad('This bot changed or cannot be removed.');if(st.jobs.some(j=>j.botId===bot.id&&ACTIVE.has(j.status)))throw bad('Stop or finish its active run first.');st.bots=st.bots.filter(x=>x.id!==bot.id);return {ok:true};});}
 async function stop(device,id){const result=await change(device,st=>{const j=st.jobs.find(x=>x.id===id);if(!j)throw bad('This run no longer exists.');if(ACTIVE.has(j.status)){j.status='stopped';j.updatedAt=now();j.error=STOPPED_MESSAGE;for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';}return view({bots:[],jobs:[j]}).jobs[0];});workers.get(`${device}:${id}`)?.abort();return result;}
 async function run(device,b,context={}) {
  if(!UUID.test(b.requestId??'')||!ID.test(b.botId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000)throw bad('Choose a bot and write its task in up to 4,000 characters.');
  const claim=await claimJob(device,(st,reserve)=>{
   if(st.retryReceipts?.some(r=>r.requestId===b.requestId))throw bad('This request ID belongs to another instruction.');
   const previous=st.jobs.find(j=>j.id===b.requestId);if(previous){if(previous.botId!==b.botId||previous.goal!==b.goal.trim())throw bad('This request ID belongs to a different task.');return {job:previous,repeated:true};}
   const bot=st.bots.find(x=>x.id===b.botId);if(!bot||bot.revision!==b.revision)throw bad('This bot changed. Refresh before running it.');
   if(st.jobs.some(j=>ACTIVE.has(j.status)))throw bad('A bot is already working for you. Wait or stop it first.');reserve();
   const parent=b.parentId?st.jobs.find(j=>j.id===b.parentId&&j.botId===bot.id):null;if(b.parentId&&!parent)throw bad('The previous run no longer exists for this bot.');
   const history=parent?[{role:'user',text:parent.goal},{role:'echo',text:`${parent.result?.reply??parent.error??'No completed result.'}\nPrevious status: ${parent.status}. External action buttons were only prepared; do not assume they were executed.`}]:[];
   const job={id:b.requestId,botId:bot.id,botName:bot.name,botRevision:bot.revision,botConfig:structuredClone(bot),goal:b.goal.trim(),attempt:1,commands:[],status:'queued',createdAt:now(),updatedAt:now(),worker:instance,leaseUntil:now()+180000,events:[],history,context};st.jobs=[...st.jobs.slice(1-MAX_JOBS),job];return {job,bot:structuredClone(bot),repeated:false};
  });
  if(!claim.repeated)start(device,claim.job,claim.bot,claim.reserved);
  return {id:claim.job.id,status:claim.job.status,repeated:claim.repeated};
 }
 async function perform(device,job,bot,controller){const key=`${device}:${job.id}`;let timer,heartbeat;
  const update=fn=>change(device,st=>{const live=st.jobs.find(j=>j.id===job.id);if(!live||live.worker!==instance||!ACTIVE.has(live.status)){controller.abort();throw bad('This run stopped.');}if(controller.signal.aborted)throw bad('This run stopped.');live.updatedAt=now();live.leaseUntil=now()+180000;return fn(live);});
  const ensure=async()=>{if(controller.signal.aborted)throw bad('This run stopped.');if(await access(device)===false)throw bad('This account cannot run bots.');await update(()=>{});};
  try{await ensure();await update(j=>{j.status='running';});timer=setTimeout(()=>controller.abort(Object.assign(new Error('Time budget exhausted'),{[BUDGET_EXHAUSTED]:true})),timeoutMs);timer.unref?.();
   heartbeat=setInterval(()=>{void update(()=>{}).catch(()=>controller.abort());},20000);heartbeat.unref?.();
   let draft='',lastActivityKind='',lastActivityAt=0;
   const activity=async(kind,text)=>{const at=now();if(kind===lastActivityKind&&at-lastActivityAt<1500)return;lastActivityKind=kind;lastActivityAt=at;await update(j=>{j.activity={kind,text,at};});};
   const takeUpdates=async()=>{await ensure();return update(j=>{const q=(j.commands??[]).filter(c=>c.operation==='update'&&c.status==='queued');for(const c of q){c.status='applied';c.appliedAt=now();}return q.map(c=>c.text);});};
   const result=await execute({bot,goal:job.goal,history:job.history,context:job.context,signal:controller.signal,ensure,takeUpdates,checkpoint:structuredClone(job.checkpoint),resumeFallback:job.resumeFallback,partialDraft:job.parentId?job.draft:undefined,
    appliedUpdates:(job.commands??[]).filter(c=>c.operation==='update'&&c.status==='applied').map(c=>c.text),
    onCheckpoint:async checkpoint=>{await ensure();await update(j=>{j.checkpoint=structuredClone(checkpoint);});},
    onEvent:async event=>{await ensure();if(event.type==='TEXT_MESSAGE_CONTENT'){draft=(draft+String(event.delta??'')).slice(-12000);await update(j=>{j.draft=draft;});await activity('writing','Writing the response');}if(event.type==='TEXT_MESSAGE_END'){if(draft){await update(j=>{j.draft=draft;});draft='';}await activity('working','Preparing the next step');}if(event.type==='TOOL_CALL_START'||event.type==='TOOL_CALL_RESULT'||event.type==='RUN_STARTED'){const tool=typeof event.toolCallName==='string'?event.toolCallName:undefined;await activity(event.type==='TOOL_CALL_START'?(/^(web_search|web_fetch|read_|get_|list_|search_|browse|fetch_|inspect_)/.test(tool??'')?'reading':'tool'):'working',event.type==='TOOL_CALL_START'?`Using · ${tool??'tool'}`:'Preparing the next step');await update(j=>{j.events.push({at:now(),type:event.type,tool});j.events=j.events.slice(-40);});}}});
   await ensure();await update(j=>{j.result=result;j.status=result.question||result.actions?.length?'needs-you':'done';for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';});
  }catch(error){const budgetExpired=controller.signal.reason?.[BUDGET_EXHAUSTED]===true;await change(device,st=>{const j=st.jobs.find(x=>x.id===job.id);if(j&&j.worker===instance&&ACTIVE.has(j.status)){j.status=controller.signal.aborted&&!budgetExpired?'stopped':'failed';j.updatedAt=now();for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';j.error=budgetExpired?'The bot reached its time budget. Use Retry to continue saved progress. Review any saved changes first.':controller.signal.aborted?STOPPED_MESSAGE:error?.kind?String(error.message).slice(0,500):'The bot could not finish. Check its tools and connection. Use Retry to continue saved progress.';}}).catch(()=>{});
  }finally{clearTimeout(timer);clearInterval(heartbeat);workers.delete(key);}
 }
 return {list,save,remove,run,stop,control,activeCount:()=>workers.size+reservedSlots};
}
