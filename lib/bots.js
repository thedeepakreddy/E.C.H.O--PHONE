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
const USER_STOPPED=Symbol('bot user stop'),LEASE_LOST=Symbol('bot lease lost');
const STOPPED_MESSAGE='Stopped. An action already in progress may finish; no further actions will start. Review any saved changes before Follow up.';
const TOOL_IDENTITY=['botId','runId','requestId','attempt','toolCallId','toolAttemptId'];
const TOOL_OUTCOMES=new Set(['success','failed','denied','uncertain','cancelled','waiting']);
const sameToolAttempt=(a,b)=>TOOL_IDENTITY.every(field=>a[field]===b[field])&&a.tool===b.tool;
const WRITE_TOOLS=new Set(['save_memory','update_commitment','remind_me','capture_commitment','organize_conversation','run_bot']);
const unresolvedWrite=events=>{
 const pending=[];
 for(const event of events??[]){
  if(event.type==='TOOL_CALL_START'&&WRITE_TOOLS.has(event.tool))pending.push(event);
  if(event.type!=='TOOL_CALL_RESULT'||['uncertain','cancelled'].includes(event.status))continue;
  const index=pending.findIndex(start=>{
   const identified=TOOL_IDENTITY.some(field=>start[field]!==undefined||event[field]!==undefined);
   // Legacy history pairs one receipt with one start, never every same-name call.
   return identified?TOOL_IDENTITY.every(field=>start[field]!==undefined&&event[field]!==undefined)&&sameToolAttempt(start,event):start.tool===event.tool;
  });
  if(index!==-1)pending.splice(index,1);
 }
 return pending.length>0;
};
const bad=m=>Object.assign(new Error(m),{input:true});
const userStop=()=>Object.assign(bad('This run stopped.'),{[USER_STOPPED]:true});
const leaseLost=()=>Object.assign(bad('This run stopped because its lease was lost. Review saved progress before Retry.'),{[LEASE_LOST]:true});
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
   if(!exact&&unresolvedWrite(parent.events))throw bad('An earlier action may already have happened and has no saved outcome. Retry is blocked; check saved changes before starting a new task.');
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
  if(!claim.repeated){workers.get(`${device}:${b.id}`)?.abort(leaseLost());start(device,claim.job,claim.bot,claim.reserved);}
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
   if(b.operation==='revise'){
    const bot=st.bots.find(x=>x.id===j.botId);if(!bot)throw bad('This bot no longer exists.');
    // Validate before stopping the parent; an uncertain effect cannot be made
    // safe merely by aborting its worker or changing the instruction.
    continuationProgress(j,bot,{kind:'revise',text:b.text.trim()});
   }
   const c={id:b.requestId,operation:b.operation,text:b.text?.trim()??'',attempt:j.attempt??1,status:b.operation==='stop'?'applied':'queued',createdAt:now()};j.commands.push(c);j.updatedAt=now();
   if(b.operation==='stop'||b.operation==='revise'){j.status='stopped';j.error=STOPPED_MESSAGE;for(const q of j.commands)if(q.status==='queued')q.status='not-applied';}
   return {command:c,...(b.operation==='revise'?{revised:{botId:j.botId,revision:j.botRevision,goal:`${j.goal}\n\nRevised instruction: ${c.text}`,parentId:j.id},context:j.context}:{} )};
  });
  if(b.operation==='stop'||b.operation==='revise')workers.get(`${device}:${b.id}`)?.abort(userStop());
  if(b.operation==='revise'){
   let next;try{next=await run(device,{...command.revised,requestId:b.requestId},{...command.context,requestId:b.requestId},{revisionText:command.command.text});}catch(error){await change(device,st=>{const c=st.jobs.find(j=>j.id===b.id)?.commands?.find(c=>c.id===b.requestId);if(c)c.status='not-applied';});throw error;}
   await change(device,st=>{const j=st.jobs.find(j=>j.id===b.id),c=j?.commands?.find(c=>c.id===b.requestId);if(c){c.status='applied';c.appliedAt=now();}});
   return {ok:true,message:next.message,newRunId:next.id,command:{...command.command,status:'applied'}};
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
 async function stop(device,id){const result=await change(device,st=>{const j=st.jobs.find(x=>x.id===id);if(!j)throw bad('This run no longer exists.');if(ACTIVE.has(j.status)){j.status='stopped';j.updatedAt=now();j.error=STOPPED_MESSAGE;for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';}return view({bots:[],jobs:[j]}).jobs[0];});workers.get(`${device}:${id}`)?.abort(userStop());return result;}
 function continuationProgress(parent,bot,continuation){
  if(parent.botRevision!==bot.revision||(parent.botConfig&&JSON.stringify(parent.botConfig)!==JSON.stringify(bot)))throw bad('This bot’s revision or tool grants changed. Review saved progress before starting a new task.');
  if(parent.checkpoint?.inFlight?.mutating)throw bad(`The ${parent.checkpoint.inFlight.name} action may already have happened. Continuation is blocked to avoid doing it twice. Check saved changes before starting a new task.`);
  const exact=parent.checkpoint?.version===1;
  if(!exact&&unresolvedWrite(parent.events))throw bad('An earlier action may already have happened and has no saved outcome. Continuation is blocked; check saved changes before starting a new task.');
  return {checkpoint:exact?{...structuredClone(parent.checkpoint),continuation}:undefined,
   resumeFallback:!exact||parent.resumeFallback||parent.checkpoint?.fallback,
   commands:structuredClone((parent.commands??[]).filter(c=>c.operation==='update'&&c.status==='applied')),
   events:structuredClone(parent.events??[]),draft:parent.draft,
   history:exact?structuredClone(parent.history??[]):[...(parent.history??[]),{role:'user',text:parent.goal},
    {role:'echo',text:`Continuation from saved progress, not an exact provider resume. Question: ${parent.result?.question??'None saved.'}\nPartial output: ${parent.draft??parent.result?.reply??'None saved.'}\nSaved activity: ${JSON.stringify(parent.events??[])}\nDo not repeat completed changes. Writes are blocked because their saved outcomes are unavailable.`}]};
 }
 async function run(device,b,context={}, {revisionText}={}) {
  if(!UUID.test(b.requestId??'')||!ID.test(b.botId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000)throw bad('Choose a bot and write its task in up to 4,000 characters.');
  const claim=await claimJob(device,(st,reserve)=>{
   if(st.retryReceipts?.some(r=>r.requestId===b.requestId))throw bad('This request ID belongs to another instruction.');
   const previous=st.jobs.find(j=>j.id===b.requestId);if(previous){if(previous.botId!==b.botId||previous.goal!==b.goal.trim())throw bad('This request ID belongs to a different task.');return {job:previous,repeated:true};}
   const bot=st.bots.find(x=>x.id===b.botId);if(!bot||bot.revision!==b.revision)throw bad('This bot changed. Refresh before running it.');
   if(st.jobs.some(j=>ACTIVE.has(j.status)))throw bad('A bot is already working for you. Wait or stop it first.');reserve();
   const parent=b.parentId?st.jobs.find(j=>j.id===b.parentId&&j.botId===bot.id):null;if(b.parentId&&!parent)throw bad('The previous run no longer exists for this bot.');
   const continuation=parent&&(revisionText?{kind:'revise',text:revisionText}:parent.result?.question?{kind:'answer',text:b.goal.trim()}:null);
   const progress=continuation?continuationProgress(parent,bot,continuation):{};
   const history=parent?[{role:'user',text:parent.goal},{role:'echo',text:`${parent.result?.reply??parent.error??'No completed result.'}\nPrevious status: ${parent.status}. External action buttons were only prepared; do not assume they were executed.`}]:[];
   const job={id:b.requestId,...(parent?{parentId:parent.id}:{}),botId:bot.id,botName:bot.name,botRevision:bot.revision,botConfig:structuredClone(bot),goal:b.goal.trim(),attempt:1,commands:[],status:'queued',createdAt:now(),updatedAt:now(),worker:instance,leaseUntil:now()+180000,events:[],history,context,...progress};st.jobs=[...st.jobs.slice(1-MAX_JOBS),job];return {job,bot:structuredClone(bot),repeated:false};
  });
  if(!claim.repeated)start(device,claim.job,claim.bot,claim.reserved);
  return {id:claim.job.id,status:claim.job.status,repeated:claim.repeated,...(revisionText?{message:claim.job.resumeFallback?'Revised task accepted with saved progress. A full checkpoint is unavailable; writes are blocked to avoid repeating previous changes.':'Revised task accepted. Saved progress and completed tool results are retained; unexecuted calls will be reconsidered using your revision.'}:{})};
 }
 async function perform(device,job,bot,controller){const key=`${device}:${job.id}`,jobAttempt=job.attempt??1;let timer,heartbeat;
  const update=async fn=>{
   try{
    const result=await change(device,st=>{const live=st.jobs.find(j=>j.id===job.id);if(!live||live.worker!==instance||live.botId!==bot.id||(live.attempt??1)!==jobAttempt||!ACTIVE.has(live.status)){controller.abort(live?.status==='stopped'?userStop():leaseLost());throw controller.signal.reason;}if(controller.signal.aborted)throw controller.signal.reason;live.updatedAt=now();live.leaseUntil=now()+180000;return fn(live);});
    if(controller.signal.aborted)throw controller.signal.reason;
    return result;
   }catch(error){controller.abort(error);throw controller.signal.reason;}
  };
  const ensure=async()=>{try{if(controller.signal.aborted)throw controller.signal.reason;if(await access(device)===false)throw bad('This account cannot run bots.');await update(()=>{});}catch(error){controller.abort(error);throw controller.signal.reason;}};
  try{await ensure();await update(j=>{j.status='running';});timer=setTimeout(()=>controller.abort(Object.assign(new Error('Time budget exhausted'),{[BUDGET_EXHAUSTED]:true})),timeoutMs);timer.unref?.();
   heartbeat=setInterval(()=>{void update(()=>{}).catch(error=>controller.abort(error));},20000);heartbeat.unref?.();
   let draft='',lastActivityKind='',lastActivityAt=0;
   // Per-worker identities are never restored as active from a previous run.
   const attempts=new Map(),activeTool=()=>[...attempts.values()].filter(a=>a.state==='active').at(-1);
   const activity=async(kind,text)=>update(j=>{if(activeTool())return;const at=now();if(kind===lastActivityKind&&at-lastActivityAt<1500)return;lastActivityKind=kind;lastActivityAt=at;j.activity={kind,text,at};});
   const toolEvent=event=>update(j=>{
    if(event.botId!==bot.id||event.runId!==job.id||event.requestId!==job.id||event.attempt!==jobAttempt||
      ![event.toolCallId,event.toolAttemptId,event.toolCallName].every(v=>typeof v==='string'&&v.length>0))return;
    const identity=Object.fromEntries(TOOL_IDENTITY.map(field=>[field,event[field]]));identity.tool=event.toolCallName;
    const prior=attempts.get(event.toolAttemptId);
    if(event.type==='TOOL_CALL_START'){
     if(prior)return;
     attempts.set(event.toolAttemptId,{...identity,state:'active'});
    }else{
     if(!prior||!sameToolAttempt(prior,identity))return;
     if(event.type==='TOOL_CALL_END'){
      if(prior.state!=='active'||!TOOL_OUTCOMES.has(event.status))return;
      prior.state='ended';prior.status=event.status;
     }else{
      // RESULT is the post-checkpoint receipt, not an ownership-free idle signal.
      if(prior.state!=='ended'||prior.receipted||event.status!==prior.status)return;
      prior.receipted=true;
     }
    }
    const at=now();j.events.push({...identity,type:event.type,at,...(event.status?{status:event.status}:{}),...(typeof event.parentMessageId==='string'?{parentMessageId:event.parentMessageId}:{})});j.events=j.events.slice(-40);
    if(event.type==='TOOL_CALL_RESULT')return;
    const active=activeTool();
    if(active){const {state,status,receipted,...owner}=active;const kind=/^(web_search|web_fetch|read_|get_|list_|search_|browse|fetch_|inspect_)/.test(active.tool)?'reading':'tool';j.activity={...owner,kind,text:`Using · ${active.tool}`,at};}
    else j.activity={kind:'working',text:'Preparing the next step',at};
    lastActivityKind=j.activity.kind;lastActivityAt=at;
   });
   const takeUpdates=async({withIds=false}={})=>{await ensure();return update(j=>{const q=(j.commands??[]).filter(c=>c.operation==='update'&&c.status==='queued');for(const c of q){c.status='applied';c.appliedAt=now();}return q.map(c=>withIds?{id:c.id,text:c.text}:c.text);});};
   const result=await execute({bot,goal:job.goal,history:job.history,context:{...job.context,device,requestId:job.id,attempt:jobAttempt},signal:controller.signal,ensure,takeUpdates,checkpoint:structuredClone(job.checkpoint),resumeFallback:job.resumeFallback,partialDraft:job.parentId?job.draft:undefined,
    appliedUpdates:(job.commands??[]).filter(c=>c.operation==='update'&&c.status==='applied').map(c=>({id:c.id,text:c.text})),
    onCheckpoint:async checkpoint=>{await ensure();await update(j=>{j.checkpoint=structuredClone(checkpoint);});},
    onEvent:async event=>{
     await ensure();
     if(['TOOL_CALL_START','TOOL_CALL_END','TOOL_CALL_RESULT'].includes(event.type)){await toolEvent(event);return;}
     // OpenBot model rounds use child run IDs; tool attempts use the root job ID.
     if((event.botId!==undefined&&event.botId!==bot.id)||(event.threadId!==undefined&&event.threadId!==bot.id)||
       (event.requestId!==undefined&&event.requestId!==job.id)||(event.attempt!==undefined&&event.attempt!==jobAttempt)||
       (event.runId!==undefined&&event.runId!==job.id&&!new RegExp(`^${job.id}-[0-9]+$`).test(event.runId)))return;
     if(event.type==='TEXT_MESSAGE_CONTENT'){draft=(draft+String(event.delta??'')).slice(-12000);await update(j=>{j.draft=draft;});await activity('writing','Writing the response');}
     if(event.type==='TEXT_MESSAGE_END'){if(draft){await update(j=>{j.draft=draft;});draft='';}await activity('working','Preparing the next step');}
     if(event.type==='RUN_STARTED'){await activity('working','Preparing the next step');await update(j=>{j.events.push({at:now(),type:event.type,...(event.threadId?{threadId:event.threadId}:{}),...(event.runId?{runId:event.runId}:{})});j.events=j.events.slice(-40);});}
    }});
   await ensure();await update(j=>{j.result=result;j.status=result.question||result.actions?.length?'needs-you':'done';for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';});
  }catch(error){const reason=controller.signal.reason,budgetExpired=reason?.[BUDGET_EXHAUSTED]===true,stopped=reason?.[USER_STOPPED]===true,interrupted=reason?.[LEASE_LOST]===true;await change(device,st=>{const j=st.jobs.find(x=>x.id===job.id);if(j&&j.worker===instance&&j.botId===bot.id&&(j.attempt??1)===jobAttempt&&ACTIVE.has(j.status)){j.status=stopped?'stopped':interrupted?'interrupted':'failed';j.updatedAt=now();for(const c of j.commands??[])if(c.status==='queued')c.status='not-applied';j.error=budgetExpired?'The bot reached its time budget. Use Retry to continue saved progress. Review any saved changes first.':stopped?STOPPED_MESSAGE:interrupted?'The bot lost its lease. Review saved progress before Retry.':error?.kind?String(error.message).slice(0,500):'The bot could not finish. Check its tools and connection. Use Retry to continue saved progress.';}}).catch(()=>{});
  }finally{clearTimeout(timer);clearInterval(heartbeat);workers.delete(key);}
 }
 return {list,save,remove,run,stop,control,activeCount:()=>workers.size+reservedSlots};
}
