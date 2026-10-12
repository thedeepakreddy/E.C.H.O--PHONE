/* Camera navigation is presentation-only: no run, task, or command state. */
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;
export function createOfficeCamera(){
 let mode='overview',focusId='',zoom=1,yaw=0,pitch=.55,overviewRadius=7,aspect=1,focuses=new Map();
 function overview(){mode='overview';focusId='';zoom=1;yaw=0;pitch=.55;}
 const baseRadius=()=>mode==='agent'?Math.max(1.85,.6/(Math.tan(39*Math.PI/360)*Math.min(aspect,1))):overviewRadius;
 return {
  configure(radius,ratio,anchors){overviewRadius=Math.max(4,positive(radius,7));aspect=Math.max(.1,positive(ratio,1));focuses=new Map((anchors||[]).filter(a=>a?.id&&a.position?.length===3&&a.position.every(Number.isFinite)).map(a=>[a.id,[...a.position]]));if(mode==='agent'&&!focuses.has(focusId))overview();},
  focus(id){if(!focuses.has(id))return false;mode='agent';focusId=id;zoom=1;yaw=-.65;pitch=.2;return true;},
  overview,
  orbit(dx,dy){if(!Number.isFinite(dx)||!Number.isFinite(dy))return;yaw=clamp(yaw+dx,-1.05,1.05);pitch=clamp(pitch+dy,.1,.85);},
  zoom(factor){if(!Number.isFinite(factor)||factor<=0)return;const base=baseRadius();zoom=clamp(zoom*factor,Math.max(mode==='agent'?.65:.55,1.5/base),Math.min(mode==='agent'?2.5:1.75,25/base));},
  view(){const anchor=focuses.get(focusId),target=mode==='agent'&&anchor?[anchor[0]+.05,1.04,anchor[2]+.2]:[0,.85,0];const radius=clamp(baseRadius()*zoom,1.5,25),flat=radius*Math.cos(pitch);return {mode,focusId,radius,yaw,pitch,zoom,target,position:[target[0]+flat*Math.sin(yaw),target[1]+radius*Math.sin(pitch),target[2]+flat*Math.cos(yaw)]};}
 };
}

export function bindOfficeNavigation(canvas,hooks){
 const pointers=new Map(),listeners=[],view=canvas.ownerDocument?.defaultView;
 let multiple=false,dragged=false;
 const listen=(target,type,fn,options)=>{target?.addEventListener(type,fn,options);listeners.push(()=>target?.removeEventListener(type,fn,options));};
 const active=()=>hooks.enabled?.()!==false;
 const changed=()=>hooks.changed?.();
 const point=e=>({x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY});
 const distance=()=>{const [a,b]=[...pointers.values()];return b?Math.hypot(a.x-b.x,a.y-b.y):0;};
 const clear=()=>{for(const id of pointers.keys()){try{if(canvas.hasPointerCapture?.(id))canvas.releasePointerCapture(id);}catch{}}pointers.clear();multiple=dragged=false;canvas.classList.remove('is-navigating');};
 listen(canvas,'pointerdown',e=>{if(!active()||e.button!==0)return;if(!pointers.size)multiple=dragged=false;pointers.set(e.pointerId,point(e));if(pointers.size>1)multiple=true;canvas.focus({preventScroll:true});try{canvas.setPointerCapture(e.pointerId);}catch{}canvas.classList.add('is-navigating');e.preventDefault();});
 listen(canvas,'pointermove',e=>{const p=pointers.get(e.pointerId);if(!p)return;if(!active()){clear();return;}const before=distance(),dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
  if(Math.hypot(p.x-p.startX,p.y-p.startY)>6)dragged=true;
  if(pointers.size>1){const after=distance();if(before>8&&after>8)hooks.zoom(before/after);}
  else if(dragged){const rect=canvas.getBoundingClientRect();hooks.orbit(-dx/Math.max(1,rect.width)*2.4,dy/Math.max(1,rect.height)*1.8);}
  changed();e.preventDefault();
 });
 function finish(e,cancelled){const p=pointers.get(e.pointerId);if(!p)return;const select=!cancelled&&active()&&!multiple&&!dragged&&Math.hypot(e.clientX-p.startX,e.clientY-p.startY)<=6;pointers.delete(e.pointerId);try{if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);}catch{}if(!pointers.size){canvas.classList.remove('is-navigating');multiple=dragged=false;}if(select)hooks.pick(e.clientX,e.clientY);e.preventDefault();}
 listen(canvas,'pointerup',e=>finish(e,false));listen(canvas,'pointercancel',e=>finish(e,true));
 listen(canvas,'lostpointercapture',e=>{pointers.delete(e.pointerId);if(!pointers.size){canvas.classList.remove('is-navigating');multiple=dragged=false;}});
 listen(canvas,'wheel',e=>{if(!active())return;const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1);hooks.zoom(Math.exp(clamp(pixels,-600,600)*.0015));changed();e.preventDefault();},{passive:false});
 listen(canvas,'keydown',e=>{if(!active()||e.altKey||e.ctrlKey||e.metaKey)return;let handled=true;switch(e.key){case '+':case '=':hooks.zoom(.85);break;case '-':case '_':hooks.zoom(1/.85);break;case 'ArrowLeft':hooks.orbit(-.12,0);break;case 'ArrowRight':hooks.orbit(.12,0);break;case 'ArrowUp':hooks.orbit(0,-.1);break;case 'ArrowDown':hooks.orbit(0,.1);break;case 'Home':hooks.overview();break;case 'Enter':hooks.inspect?.();break;default:handled=false;}if(handled){changed();e.preventDefault();e.stopPropagation();}});
 listen(view,'blur',clear);
 return {clear,dispose(){clear();listeners.forEach(remove=>remove());}};
}
