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
const bad=m=>Object.assign(new Error(m),{input:true});
export const botState=()=>({version:1,bots:structuredClone(DEFAULT_BOTS),jobs:[]});
const view=st=>({bots:st.bots,jobs:st.jobs.slice(-30).reverse().map(({worker,leaseUntil,context,history,...j})=>j)});
export function createBots({withState,execute,now=Date.now,newId=randomUUID,access=async()=>true,maxActive=4}) {
 const instance=randomUUID(),workers=new Map();
 async function change(device,fn,readOnly=false){let dirty=false;return withState(device,async st=>{if(!st.bots||!st.jobs)dirty=true;st.bots??=structuredClone(DEFAULT_BOTS);st.jobs??=[];
  for(const j of st.jobs)if(ACTIVE.has(j.status)&&j.leaseUntil<=now()){dirty=true;j.status='interrupted';j.error='Echo restarted or this run lost its connection. Review saved progress before starting a new run.';j.updatedAt=now();}
  return fn(st);
 },{save:()=>!readOnly||dirty});}
 const list=device=>change(device,st=>view(st),true);
 async function save(device,b){return change(device,st=>{
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>40||typeof b.role!=='string'||!b.role.trim()||b.role.length>2000||!BOT_MODES.includes(b.mode))throw bad('Give the bot a name, a role in up to 2,000 characters, and a supported capability.');
  const old=b.id?st.bots.find(x=>x.id===b.id):null;if(b.id&&!old)throw bad('This bot no longer exists.');if(old&&(!old.custom||old.revision!==b.revision))throw bad('This bot changed or is built in. Refresh first.');
  if(!old&&st.bots.filter(x=>x.custom).length>=6)throw bad('You can create up to six personal bots.');
  if(old&&st.jobs.some(j=>j.botId===old.id&&ACTIVE.has(j.status)))throw bad('Stop or finish this bot’s run before editing its role.');
  const bot={id:old?.id??`bot-${newId()}`,name:b.name.trim(),role:b.role.trim(),mode:b.mode,custom:true,revision:(old?.revision??0)+1};if(old)st.bots[st.bots.indexOf(old)]=bot;else st.bots.push(bot);return bot;
 });}
 async function remove(device,b){return change(device,st=>{const bot=st.bots.find(x=>x.id===b.id);if(!bot?.custom||bot.revision!==b.revision)throw bad('This bot changed or cannot be removed.');if(st.jobs.some(j=>j.botId===bot.id&&ACTIVE.has(j.status)))throw bad('Stop or finish its active run first.');st.bots=st.bots.filter(x=>x.id!==bot.id);return {ok:true};});}
 async function stop(device,id){const result=await change(device,st=>{const j=st.jobs.find(x=>x.id===id);if(!j)throw bad('This run no longer exists.');if(ACTIVE.has(j.status)){j.status='stopped';j.updatedAt=now();j.error='Stopped. An action already in progress may finish; no further actions will start.';}return view({bots:[],jobs:[j]}).jobs[0];});workers.get(`${device}:${id}`)?.abort();return result;}
 async function run(device,b,context={}) {
  if(!UUID.test(b.requestId??'')||!ID.test(b.botId??'')||typeof b.goal!=='string'||!b.goal.trim()||b.goal.length>4000)throw bad('Choose a bot and write its task in up to 4,000 characters.');
  const claim=await change(device,st=>{
   const previous=st.jobs.find(j=>j.id===b.requestId);if(previous){if(previous.botId!==b.botId||previous.goal!==b.goal.trim())throw bad('This request ID belongs to a different task.');return {job:previous,repeated:true};}
   const bot=st.bots.find(x=>x.id===b.botId);if(!bot||bot.revision!==b.revision)throw bad('This bot changed. Refresh before running it.');
   if(st.jobs.some(j=>ACTIVE.has(j.status)))throw bad('A bot is already working for you. Wait or stop it first.');if(workers.size>=maxActive)throw bad('Echo is busy with other bot tasks. Try again shortly.');
   const parent=b.parentId?st.jobs.find(j=>j.id===b.parentId&&j.botId===bot.id):null;if(b.parentId&&!parent)throw bad('The previous run no longer exists for this bot.');
   const history=parent?[{role:'user',text:parent.goal},{role:'echo',text:`${parent.result?.reply??parent.error??'No completed result.'}\nPrevious status: ${parent.status}. External action buttons were only prepared; do not assume they were executed.`}]:[];
   const job={id:b.requestId,botId:bot.id,botName:bot.name,botRevision:bot.revision,goal:b.goal.trim(),status:'queued',createdAt:now(),updatedAt:now(),worker:instance,leaseUntil:now()+180000,events:[],history,context};st.jobs=[...st.jobs.slice(-29),job];return {job,bot:structuredClone(bot),repeated:false};
  });
  if(!claim.repeated){const controller=new AbortController();workers.set(`${device}:${claim.job.id}`,controller);void perform(device,claim.job,claim.bot,controller).catch(()=>{});}
  return {id:claim.job.id,status:claim.job.status,repeated:claim.repeated};
 }
 async function perform(device,job,bot,controller){const key=`${device}:${job.id}`;let timer,heartbeat;
  const update=fn=>change(device,st=>{const live=st.jobs.find(j=>j.id===job.id);if(!live||live.worker!==instance||!ACTIVE.has(live.status)){controller.abort();throw bad('This run stopped.');}if(controller.signal.aborted)throw bad('This run stopped.');live.updatedAt=now();live.leaseUntil=now()+180000;return fn(live);});
  const ensure=async()=>{if(controller.signal.aborted)throw bad('This run stopped.');await access(device);await update(()=>{});};
  try{await ensure();await update(j=>{j.status='running';});timer=setTimeout(()=>controller.abort(new Error('Time budget exhausted')),240000);timer.unref?.();
   heartbeat=setInterval(()=>{void update(()=>{}).catch(()=>controller.abort());},20000);heartbeat.unref?.();
   let draft='';
   const result=await execute({bot,goal:job.goal,history:job.history,context:job.context,signal:controller.signal,ensure,
    onEvent:async event=>{await ensure();if(event.type==='TEXT_MESSAGE_CONTENT')draft=(draft+String(event.delta??'')).slice(-12000);if(event.type==='TEXT_MESSAGE_END'&&draft){await update(j=>{j.draft=draft;});draft='';}if(event.type==='TOOL_CALL_START'||event.type==='TOOL_CALL_RESULT'||event.type==='RUN_STARTED')await update(j=>{j.events.push({at:now(),type:event.type,tool:typeof event.toolCallName==='string'?event.toolCallName:undefined});j.events=j.events.slice(-40);});}});
   await ensure();await update(j=>{j.result=result;j.status=result.question||result.actions?.length?'needs-you':'done';});
  }catch(error){await change(device,st=>{const j=st.jobs.find(x=>x.id===job.id);if(j&&j.worker===instance&&ACTIVE.has(j.status)){j.status=controller.signal.aborted?'stopped':'failed';j.updatedAt=now();j.error=controller.signal.aborted?'The run stopped or reached its time budget. Review any saved changes before retrying.':error?.kind?String(error.message).slice(0,500):'The bot could not finish. Check its tools and connection, then start a new run.';}}).catch(()=>{});
  }finally{clearTimeout(timer);clearInterval(heartbeat);workers.delete(key);}
 }
 return {list,save,remove,run,stop,activeCount:()=>workers.size};
}
