/* Echo's office is a projection of runner state. It never owns execution. */
(() => {
 'use strict';
 const scriptURL=document.currentScript.src;
 const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=String(text);return n;};
 const label=s=>({working:'Working',running:'Working',pending:'Waiting',queued:'Queued',completed:'Done',done:'Done',cancelled:'Stopped','needs-you':'Needs you',interrupted:'Interrupted',failed:'Failed',blocked:'Blocked',ready:'Ready',idle:'Ready'}[s]||s||'Ready');
 const working=s=>['working','running'].includes(s);
 const active=s=>['working','running','pending','queued'].includes(s);
 const displayName=a=>a.id==='lead'?'Echo':a.name;
 window.EchoAgentOffice={mount(root,options){
  root.classList.add('agent-office');
  let data={bots:[],jobs:[]},target=options.target||'mac',connected=true,runId='',selected='lead',identity='',mode='3d',paused=false,busy=false,scene=null,loadingScene=false,disposed=false,inView=false;
  const drafts=new Map(),requests=new Map();
  const title=node('h2','','Agent workspace'),heading=node('div','office-heading'),description=node('p','office-muted','Echo coordinates your specialists and brings their reports together.');
  const controls=node('div','office-controls'),runLabel=node('label','office-run-label','Task'),runSelect=node('select','office-run-select');runSelect.setAttribute('aria-label','Select task in the agent workspace');runLabel.append(runSelect);
  const assign=node('button','office-button office-primary','Assign task'),manage=node('button','office-button','Manage agents');assign.type=manage.type='button';controls.append(runLabel,assign,manage);heading.append(title,description,controls);
  const layout=node('div','office-layout'),stage=node('section','office-stage'),canvas=node('canvas','office-canvas');canvas.setAttribute('aria-label','Office visualization; select an agent using its desk label or the roster');canvas.setAttribute('role','img');
  const backdrop=node('div','office-daylight'),labels=node('div','office-labels'),echoTile=node('button','office-echo-tile'),echoCanvas=node('canvas','office-echo-canvas'),echoCopy=node('span','office-echo-copy');echoTile.type='button';echoTile.setAttribute('aria-label','Inspect Echo, your coordinator');echoCanvas.setAttribute('aria-hidden','true');echoCopy.append(node('strong','','Echo'),node('small','','Your coordinator'));echoTile.append(echoCanvas,echoCopy);
  const stageTools=node('div','office-stage-tools'),d3=node('button','office-button','3D'),d2=node('button','office-button','2D'),motion=node('button','office-button','Pause motion'),reset=node('button','office-button','Reset view'),sceneStatus=node('span','office-scene-status','Loading office…');
  for(const b of [d3,d2,motion,reset])b.type='button';d3.setAttribute('aria-pressed','true');d2.setAttribute('aria-pressed','false');stageTools.append(d3,d2,motion,reset);stage.append(backdrop,canvas,labels,echoTile,sceneStatus,stageTools);
  const inspector=node('section','office-inspector'),name=node('h3','','Echo'),state=node('p','office-state'),scope=node('p','office-muted'),goal=node('p','office-goal'),activity=node('div','office-activity'),output=node('div','office-output'),form=node('form','office-update-form'),updateLabel=node('label','','Update this agent'),input=node('textarea','office-update-input');
  const inputId=(root.id||'agent-office')+'-instruction';input.id=inputId;input.rows=3;input.maxLength=4000;updateLabel.htmlFor=inputId;input.placeholder='Give a clear update or revised instruction…';
  const hint=node('p','office-muted'),actions=node('div','office-action-buttons'),send=node('button','office-button office-primary','Send update'),revise=node('button','office-button','Interrupt & revise'),stop=node('button','office-button office-danger','Stop agent'),follow=node('button','office-button','Follow up'),stopTeam=node('button','office-button office-danger','Stop team'),feedback=node('p','office-feedback');feedback.setAttribute('role','status');
  send.type='submit';for(const b of [revise,stop,follow,stopTeam])b.type='button';actions.append(send,revise,stop,follow,stopTeam);form.append(updateLabel,input,hint,actions,feedback);inspector.append(name,state,scope,goal,activity,output,form);layout.append(stage,inspector);
  const roster=node('div','office-roster');roster.setAttribute('aria-label','Select an agent');root.append(heading,layout,roster);
  const echo=window.EchoHumanoid?.mount(echoCanvas);
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  function currentRun(){return data.jobs.find(j=>j.id===runId);}
  function members(){const j=currentRun();const steps=j?.steps?.length?j.steps:[...(j?[{id:j.botId,profile:j.botId,name:j.botName,status:j.status,attempt:j.attempt??1,commands:j.commands??[],activity:j.events?.length?{text:(j.events.at(-1).tool?'Using · '+j.events.at(-1).tool.replace(/_/g,' '):'Working'),at:j.events.at(-1).at}:undefined,result:j.result,updateSupported:true}]:[])];
   const ids=new Set(steps.map(s=>s.id));const all=[...steps,...data.bots.filter(b=>!b.team&&!ids.has(b.id)).map(b=>({id:b.id,profile:b.id,name:b.name,status:'ready'}))];
   if(!all.some(a=>a.id==='lead'))all.unshift({id:'lead',profile:'lead',name:'Echo',status:j?.steps?.length?'pending':'idle',coordinator:true});
   return all.map(a=>({...a,id:a.id||a.profile||a.name?.toLowerCase(),name:displayName(a)}));
  }
  function agent(){return members().find(a=>a.id===selected);}
  function key(){const a=agent();return JSON.stringify([target,runId,selected,a?.attempt??1]);}
  function live(){const j=currentRun();return connected&&j?.live!==false&&['running','queued'].includes(j?.status);}
  function choose(id){drafts.set(identity,input.value);selected=id;paint();scene?.focus(id);}
  function paint(){
   if(disposed)return;
   const j=currentRun(),all=members();if(!all.some(a=>a.id===selected))selected='lead';const a=agent(),next=key();
   if(identity!==next){drafts.set(identity,input.value);identity=next;input.value=drafts.get(next)||'';feedback.textContent='';}
   const signature=JSON.stringify(data.jobs.map(j=>[j.id,j.goal]));if(runSelect.dataset.signature!==signature){runSelect.replaceChildren();for(const j of data.jobs){const o=node('option','',j.goal);o.value=j.id;runSelect.append(o);}if(!data.jobs.length)runSelect.append(node('option','','No tasks yet'));runSelect.dataset.signature=signature;}runSelect.value=runId;
   runSelect.disabled=busy||!data.jobs.length;assign.disabled=busy||!connected;manage.hidden=!options.manage;assign.textContent='Assign task';
   name.textContent=a?.name||'Echo';state.textContent=connected?label(a?.status):'Offline · last known state';state.dataset.state=a?.status||'idle';scope.textContent=(target==='mac'?'Your Mac':'This phone')+(j?' · '+new Date(j.updatedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'');
   goal.textContent=j?.goal||'Give Echo a task, then select a specialist to follow its work.';activity.replaceChildren();
   if(a?.id==='lead')activity.append(node('p','',j?.steps?.length?'Echo combines the team’s completed reports. You can also direct each specialist.':'Echo oversees this workspace. Select the assigned specialist to send an update or interrupt it.'));
   if(a?.dependsOn?.length){const waiting=a.dependsOn.filter(id=>j.steps.find(s=>s.id===id)?.status!=='completed');if(waiting.length)activity.append(node('p','office-muted','Waiting for '+waiting.map(id=>all.find(a=>a.id===id)?.name||id).join(', ')));}
   if(a?.activity)activity.append(node('p','',a.activity.text),node('small','office-muted','Last activity · '+new Date(a.activity.at).toLocaleTimeString()));
   for(const c of (a?.commands||[]).slice(-3))activity.append(node('p','office-command',`${c.operation==='update'?'Update':c.operation==='revise'?'Revision':'Stop'} · ${c.status==='not-applied'?'Not applied; task ended':c.status==='applied'?'Applied':'Queued'} · ${c.text||'Agent stopped'}`));
   const result=a?.result||(selected==='lead'?j?.result:null);const summary=result?.reply||result?.summary||result?.question||'';if(output.dataset.text!==summary){output.replaceChildren();if(summary)output.append(window.EchoMarkdown?window.EchoMarkdown.render(summary):node('p','',summary));output.dataset.text=summary;}
   const present=!!j&&(j.steps?.length?j.steps.some(s=>s.id===selected):j.botId===selected),controllable=present&&live()&&active(a?.status);
   updateLabel.textContent='Update '+(a?.name||'Echo');form.hidden=!present;input.disabled=busy||!connected;
   send.hidden=revise.hidden=stop.hidden=!controllable;send.disabled=busy||a?.updateSupported===false;revise.disabled=stop.disabled=busy;
   follow.hidden=!present||active(a?.status);follow.textContent=j?.steps?.length>1?'Follow up team':'Follow up';follow.disabled=busy||!connected||live();stopTeam.hidden=!live()||!j?.steps?.length;stopTeam.disabled=busy;
   hint.textContent=controllable?(a?.updateSupported===false?'This provider supports Interrupt & revise. Live updates are unavailable.':target==='phone'?'Updates apply at the next agent turn. Revising stops this run and starts a linked follow-up.':'Updates apply at the next agent turn. Revising restarts only this specialist; waiting reports use its new result.'):'Select an active specialist to update it, or follow up on a finished task.';
   const rosterSignature=JSON.stringify(all.map(a=>[a.id,a.name,a.status,a.id===selected]));if(roster.dataset.signature!==rosterSignature){const focused=document.activeElement?.dataset.agent;roster.replaceChildren();labels.replaceChildren();all.forEach(a=>{const b=node('button','office-roster-agent');b.type='button';b.dataset.agent=a.id;b.setAttribute('aria-pressed',String(a.id===selected));b.append(node('strong','',a.name),node('small','',label(a.status)));b.onclick=()=>choose(a.id);roster.append(b);if(a.id!=='lead'){const l=node('button','office-desk-label');l.type='button';l.dataset.agent=a.id;l.dataset.state=a.status;l.setAttribute('aria-pressed',String(a.id===selected));l.append(node('strong','',a.name),node('small','',label(a.status)));l.onclick=()=>choose(a.id);labels.append(l);}});roster.dataset.signature=rosterSignature;if(focused)Array.from(roster.children).find(b=>b.dataset.agent===focused)?.focus({preventScroll:true});}
   root.dataset.connected=String(connected);root.dataset.mode=mode;
   scene?.update(all,selected,connected);positionFallback();echo?.draw(performance.now(),working(all.find(a=>a.id==='lead')?.status)?'thinking':'idle');
   if(mode==='3d'&&!scene)void loadScene();
  }
  function positionFallback(){if(mode==='3d'&&scene)return;Array.from(labels.children).forEach((l,i)=>{l.hidden=false;l.style.left=(20+(i%3)*29)+'%';l.style.top=(32+Math.floor(i/3)*28)+'%';});}
  async function loadScene(){if(loadingScene||disposed)return;loadingScene=true;try{const m=await import(new URL('agent-office-scene.js',scriptURL).href);if(disposed)return;scene=await m.createOfficeScene(canvas,labels,{select:choose,echoCanvas,echo,visible:()=>inView&&options.visible?.()!==false&&!document.hidden&&mode==='3d',reduced:()=>reduced.matches||paused});sceneStatus.textContent='Live state · animated visualization';scene.update(members(),selected,connected);}catch(e){mode='2d';sceneStatus.textContent='3D unavailable · 2D view remains connected';d3.setAttribute('aria-pressed','false');d2.setAttribute('aria-pressed','true');root.dataset.mode=mode;positionFallback();}finally{loadingScene=false;}}
  async function command(operation){if(busy)return;const a=agent(),j=currentRun(),text=input.value.trim();if(!a||!j||!live()||!active(a.status))return;if(operation!=='stop'&&!text){feedback.textContent='Enter instructions for '+a.name+'.';input.focus();return;}
   const bound={target,runId:j.id,taskId:a.id,profile:a.profile||a.id,attempt:a.attempt??1,operation,text:operation==='stop'?undefined:text};const requestKey=JSON.stringify(bound);if(!requests.has(requestKey))requests.set(requestKey,crypto.randomUUID());bound.requestId=requests.get(requestKey);
   const original=identity;busy=true;feedback.textContent=operation==='update'?'Sending update…':'Interrupting agent…';paint();
   try{const r=await options.control(bound);if(r?.ok===false)throw Error(r.message||'This instruction was not accepted.');requests.delete(requestKey);if(identity===original){feedback.textContent=r.message||'Command accepted.';if(operation!=='stop'){input.value='';drafts.delete(original);}}if(r.newRunId&&target===bound.target)runId=r.newRunId;await options.refresh?.();}
   catch(e){if(identity===original)feedback.textContent=e.message||'Could not reach Echo. Your instructions are preserved; retry uses the same command ID.';}
   finally{busy=false;paint();}
  }
  form.onsubmit=e=>{e.preventDefault();void command('update');};revise.onclick=()=>void command('revise');stop.onclick=()=>void command('stop');
  follow.onclick=()=>options.follow?.(currentRun(),agent(),input.value);stopTeam.onclick=async()=>{if(busy||!live())return;const j=currentRun(),t=target;busy=true;paint();try{await options.stopTeam?.(j,t);await options.refresh?.();}catch(e){feedback.textContent=e.message;}finally{busy=false;paint();}};
  assign.onclick=()=>options.assign?.(agent()?.id);manage.onclick=()=>options.manage?.();echoTile.onclick=()=>choose('lead');runSelect.onchange=()=>{drafts.set(identity,input.value);runId=runSelect.value;selected='lead';paint();};input.oninput=()=>drafts.set(identity,input.value);
  const switchMode=m=>{mode=m;d3.setAttribute('aria-pressed',String(m==='3d'));d2.setAttribute('aria-pressed',String(m==='2d'));paint();scene?.redraw();};d3.onclick=()=>switchMode('3d');d2.onclick=()=>switchMode('2d');motion.onclick=()=>{paused=!paused;motion.textContent=paused?'Resume motion':'Pause motion';motion.setAttribute('aria-pressed',String(paused));scene?.redraw();};reset.onclick=()=>scene?.reset();
  const observer=new IntersectionObserver(es=>{inView=es[0].isIntersecting;if(inView){echo?.resize();scene?.redraw();}},{threshold:.01});observer.observe(root);
  const resize=new ResizeObserver(()=>{echo?.resize();scene?.redraw();});resize.observe(stage);
  function dispose(){disposed=true;observer.disconnect();resize.disconnect();scene?.dispose();echo?.dispose();}
  window.addEventListener('pagehide',()=>{scene?.redraw();});
  paint();
  return {update(next,connection={}){const changed=connection.target&&connection.target!==target;if(changed){drafts.set(identity,input.value);runId='';selected='lead';}target=connection.target||target;connected=connection.connected!==false;data=next||{bots:[],jobs:[]};if(!data.jobs.some(j=>j.id===runId))runId=(data.jobs.find(j=>j.live!==false&&['running','queued'].includes(j.status))||data.jobs[0])?.id||'';paint();},setConnection(value){connected=value;paint();},sync(){scene?.redraw();},dispose};
 }};
})();
