/* Photographic artwork with live overlays: not skeletal 3D or an execution feed. */
export async function createOfficeScene(canvas, labels, hooks) {
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');
 const artwork=new Image();artwork.src=hooks.assetURL;await artwork.decode();
 const slots=[
  {profile:'plan',x:.057,y:.258,w:.22,h:.122,face:[.17,.46],hand:[.095,.535,.115,.055],screen:[.13,.65]},
  {profile:'research',x:.303,y:.262,w:.18,h:.133,face:[.393,.523],hand:[.335,.713,.125,.072],screen:[.25,.63]},
  {profile:'write',x:.574,y:.277,w:.16,h:.154,face:[.622,.45],hand:[.58,.705,.09,.06],screen:[.62,.63]},
  {profile:'review',x:.772,y:.277,w:.228,h:.18,face:[.807,.48],hand:[.81,.665,.09,.06],screen:[.88,.58]},
 ];
 let agents=[],selected='lead',connected=false,dirty=true,disposed=false,frame=0,last=0,raf,signature='';
 const isWorking=a=>connected&&['working','running'].includes(a?.status);
 function assigned(){const unused=agents.filter(a=>a.id!=='lead'),bound=slots.map(s=>{const i=unused.findIndex(a=>(a.profile||a.id)===s.profile);return i<0?null:unused.splice(i,1)[0];});for(let i=0;i<bound.length;i++)if(!bound[i])bound[i]=unused.shift()||null;return bound;}
 function glow(x,y,r,alpha,w,h){const grad=ctx.createRadialGradient(x*w,y*h,0,x*w,y*h,r*w);grad.addColorStop(0,'rgba(105,239,255,'+alpha+')');grad.addColorStop(1,'rgba(105,239,255,0)');ctx.fillStyle=grad;ctx.fillRect((x-r)*w,(y-r)*h,r*w*2,r*w*2);}
 function draw(now){
  const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
  const dpr=Math.min(devicePixelRatio||1,1.5),cw=Math.round(w*dpr),ch=Math.round(h*dpr);if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.drawImage(artwork,0,0,w,h);
  const bound=assigned(),reduced=hooks.reduced();let count=0;
  slots.forEach((s,i)=>{const a=bound[i];if(isWorking(a)){
    count++;const pulse=reduced?1:.96+Math.sin(now*.0018+i)*.04;ctx.save();ctx.globalCompositeOperation='screen';glow(...s.face,.085,.24*pulse,w,h);glow(...s.screen,.13,.12*pulse,w,h);ctx.restore();
    if(!reduced){const [x,y,rw,rh]=s.hand,shift=Math.sin(now*.006+i*1.7)*.65;ctx.save();ctx.beginPath();ctx.rect(x*w,y*h,rw*w,rh*h);ctx.clip();ctx.drawImage(artwork,0,shift,w,h);ctx.restore();}
   }
   ctx.fillStyle='rgba(7,23,31,.97)';ctx.beginPath();ctx.roundRect(s.x*w,s.y*h,s.w*w,s.h*h,12);ctx.fill();if(!a){ctx.fillStyle='#b6ccd3';ctx.font='12px system-ui';ctx.fillText('Unassigned desk',s.x*w+10,s.y*h+25);}
  });
  for(const el of labels.children){const i=bound.findIndex(a=>a?.id===el.dataset.agent);el.hidden=i<0;if(i<0)continue;const s=slots[i];el.style.left=s.x*100+'%';el.style.top=s.y*100+'%';el.style.width=s.w*100+'%';el.style.height=s.h*100+'%';}
  canvas.dataset.frames=String(++frame);canvas.dataset.workingScreens=String(count);canvas.dataset.faceLightIntensity=String(count*.24);canvas.dataset.visualization='photographic-artwork';canvas.dataset.selected=selected;
 }
 const resize=new ResizeObserver(()=>{dirty=true;});resize.observe(canvas);
 const visibility=()=>{dirty=true;};document.addEventListener('visibilitychange',visibility);
 function tick(now){if(disposed)return;const work=agents.some(isWorking);if(hooks.visible()&&(dirty||work&&!hooks.reduced())&&now-last>=(innerWidth<780?50:33)){draw(now);dirty=false;last=now;}raf=requestAnimationFrame(tick);}raf=requestAnimationFrame(tick);
 return {update(next,id,online){const value=JSON.stringify([next.map(a=>[a.id,a.profile,a.status]),id,online]);agents=next;selected=id;connected=online;if(value!==signature){signature=value;dirty=true;}},redraw(){dirty=true;},reset(){dirty=true;},dispose(){disposed=true;cancelAnimationFrame(raf);resize.disconnect();document.removeEventListener('visibilitychange',visibility);}};
}
