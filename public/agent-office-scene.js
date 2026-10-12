import * as T from './vendor/three.module.min.js';
import {loadCharacterSource,createCharacter} from './agent-office-avatar.js';
import {createBehaviorTracker,behaviorFor} from './agent-office-behavior.js';
import {loadOfficeMaterials,loadOfficePlant} from './agent-office-props.js';
import {createEchoEnvironment} from './agent-office-environment.js';
import {createOfficeCamera,bindOfficeNavigation} from './agent-office-navigation.js';
export async function createOfficeScene(canvas,labels,hooks){
 const renderer=new T.WebGLRenderer({canvas,antialias:true,powerPreference:'low-power'});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
 const scene=new T.Scene();scene.background=new T.Color(0x07141c);scene.fog=new T.Fog(0x07141c,12,30);
 const camera=new T.PerspectiveCamera(39,1,.05,50),cameraTarget=new T.Vector3(0,1.12,0),tracker=createBehaviorTracker(),materials=[],geometries=[],textures=[];
 const material=(color,roughness=.75,metalness=0)=>{const m=new T.MeshStandardMaterial({color,roughness,metalness});materials.push(m);return m;};
 const wood=material(0x8e6c4a),black=material(0x171c20),metal=material(0x354448,.38,.65),wall=material(0x233a43),floor=material(0x6f6961),chair=material(0x262d31),paper=material(0xe0ddd5);
 function box(parent,dim,pos,mat){const g=new T.BoxGeometry(...dim);geometries.push(g);const o=new T.Mesh(g,mat);o.position.set(...pos);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 function cylinder(parent,r1,r2,height,pos,mat){const g=new T.CylinderGeometry(r1,r2,height,12);geometries.push(g);const o=new T.Mesh(g,mat);o.position.set(...pos);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 scene.add(new T.HemisphereLight(0xb2dce3,0x3b3430,1.3));
 // Window apertures are bounded by physical shell segments, not a photograph.
 box(scene,[14,.16,14],[0,-.08,-1],floor);const ceiling=box(scene,[14,.2,8],[0,3.65,-2],wall);box(scene,[14,.65,.18],[0,.325,-4],wall);box(scene,[14,.35,.18],[0,3.4,-4],wall);
 for(let x=-7;x<=7;x+=2){box(scene,[.08,2.8,.16],[x,1.95,-4],metal);box(scene,[.04,2.8,.06],[x+1,1.95,-4],metal);}box(scene,[14,.07,.12],[0,2.0,-4],metal);
 const glass=new T.MeshPhysicalMaterial({color:0xbddae1,transparent:true,opacity:.065,roughness:.05,depthWrite:false});materials.push(glass);box(scene,[14,2.65,.02],[0,1.96,-4.03],glass);box(scene,[.18,3.6,8],[-7,1.8,-1],wall);box(scene,[.18,3.6,8],[7,1.8,-1],wall);
 const environment=await createEchoEnvironment(scene,{materials,geometries,textures});
 const plantSource=await loadOfficePlant();textures.push(...plantSource.textures);materials.push(...plantSource.materials);geometries.push(...plantSource.geometries);textures.push(...await loadOfficeMaterials(wood,floor));
 for(const [x,z,height] of [[-3,-1.5,1.4],[3.5,-2,1.7],[.4,-3,1.35]]){const p=plantSource.group.clone(true),bounds=new T.Box3().setFromObject(p),size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());p.scale.setScalar(height/size.y);p.position.set(x-center.x*p.scale.x,-bounds.min.y*p.scale.y,z-center.z*p.scale.z);scene.add(p);}
 const data=await loadCharacterSource(),slots=[],seats=[];
 function createSeat(s,index){
  const desk=new T.Group();desk.position.set(s.x,0,s.z);scene.add(desk);
  box(desk,[1.45,.055,.82],[0,.735,.47],wood);for(const x of [-.61,.61])for(const z of [.12,.81])box(desk,[.035,.71,.035],[x,.355,z],metal);
  box(desk,[.47,.055,.45],[0,.43,-.14],chair);box(desk,[.47,.47,.045],[0,.69,-.37],chair).rotation.x=-.1;cylinder(desk,.025,.035,.42,[0,.21,-.14],metal);for(let i=0;i<5;i++){const leg=box(desk,[.035,.025,.32],[Math.sin(i*1.256)*.14,.04,-.14+Math.cos(i*1.256)*.14],metal);leg.rotation.y=i*1.256;}
  const monitor=box(desk,[.6,.33,.028],[.5,.99,.28],black);monitor.rotation.y=1.5;box(desk,[.04,.19,.04],[.5,.86,.28],metal);box(desk,[.26,.018,.15],[.5,.772,.28],metal);
  box(desk,[.38,.018,.13],[0,.78,.4],black);const keyGeo=new T.BoxGeometry(.023,.007,.018);geometries.push(keyGeo);const keys=new T.InstancedMesh(keyGeo,metal,48),keyMatrix=new T.Matrix4();for(let r=0;r<4;r++)for(let c=0;c<12;c++){keyMatrix.makeTranslation(-.17+c*.03,.793,.353+r*.028);keys.setMatrixAt(r*12+c,keyMatrix);}keys.receiveShadow=true;desk.add(keys);
  const mouse=box(desk,[.055,.025,.09],[-.29,.792,.44],black);box(desk,[.14,.004,.2],[-.29,.768,.44],chair);box(desk,[.17,.012,.23],[.48,.772,.35],paper);cylinder(desk,.04,.035,.085,[.52,.815,.7],black);
  const content=document.createElement('canvas');content.width=512;content.height=320;const texture=new T.CanvasTexture(content);texture.colorSpace=T.SRGBColorSpace;textures.push(texture);
  const surface=new T.Mesh(new T.PlaneGeometry(.563,.3),new T.MeshStandardMaterial({map:texture,emissiveMap:texture,emissive:0xffffff,emissiveIntensity:.32,roughness:.6}));geometries.push(surface.geometry);materials.push(surface.material);surface.rotation.y=Math.PI;surface.position.set(0,0,-.017);monitor.add(surface);
  // The monitor emits light toward the face; a separate spill illuminates hands.
  const faceLight=new T.SpotLight(0xb7e7ff,0,1.6,Math.PI/3,.6,2);faceLight.position.set(.46,1.01,.25);const faceTarget=new T.Object3D();faceTarget.position.set(0,1.17,-.02);desk.add(faceLight,faceTarget);faceLight.target=faceTarget;
  const handLight=new T.PointLight(0xa6dfff,0,.65,2);handLight.position.set(0,.94,.57);desk.add(handLight);
  const avatar=createCharacter(data,{female:s.female,glasses:s.glasses,shirt:index===2?0xbac4cc:0xb7bec1});avatar.group.position.z=-.1;desk.add(avatar.group);
  return {s,desk,avatar,content,texture,surface,faceLight,handLight,mouse,labelAnchor:new T.Vector3(s.x,1.54,s.z-.1),signature:'',intensity:0};
 }
 let agents=[],selected='lead',connected=false,disposed=false,dirty=true,frame=0,last=0,clock=0,raf,width=0,height=0,signature='',transitionUntil=0,cameraUntil=0,pendingFocus='';
 const navigation=createOfficeCamera(),raycaster=new T.Raycaster(),pointer=new T.Vector2();
 const cameraChanged=()=>{dirty=true;cameraUntil=performance.now()+1600;};
 function pick(x,y){if(disposed||!hooks.visible())return;const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;pointer.set((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1);scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);raycaster.setFromCamera(pointer,camera);
  const meshes=[];scene.traverseVisible(o=>{if(o.isMesh)meshes.push(o);});const hit=raycaster.intersectObjects(meshes,false)[0];if(!hit)return;let object=hit.object;while(object&&!object.userData.officeAgent)object=object.parent;const id=object?.userData.officeAgent;if(id&&agents.some(a=>a.id===id))hooks.select(id);
 }
 const gestures=bindOfficeNavigation(canvas,{enabled:()=>!disposed&&hooks.visible(),orbit:(x,y)=>navigation.orbit(x,y),zoom:f=>navigation.zoom(f),pick,changed:cameraChanged,overview:()=>hooks.overview(),inspect:()=>hooks.select(selected)});
 function bound(){return seats.map(s=>agents.find(a=>a.id===s.s.id)||null);}
 function reconcileSeats(){for(const a of agents){if(seats.some(s=>s.s.id===a.id))continue;const index=seats.length,s={id:a.id,profile:a.profile||a.id,x:0,z:0,female:['research','review','echo-assistant'].includes(a.profile||a.id),glasses:(a.profile||a.id)==='research'};slots.push(s);const seat=createSeat(s,index);seat.desk.userData.officeAgent=a.id;seats.push(seat);}}
 function screenContent(seat,agent,phase,time){
  const result=agent?.result?.reply||agent?.result?.summary||agent?.draft;
  const text=JSON.stringify([agent?.executionKey,phase,agent?.activity?.text,agent?.task,agent?.result?.question,result,Math.floor(time*2)]);if(text===seat.signature)return;seat.signature=text;
  const ctx=seat.content.getContext('2d');ctx.fillStyle='#0c1d28';ctx.fillRect(0,0,512,320);ctx.fillStyle='#294450';ctx.fillRect(0,0,512,42);ctx.fillStyle='#e0f4f7';ctx.font='22px system-ui';ctx.fillText('ECHO  /  '+(agent?.name??'Ready'),20,29);
  const heading={queued:'TASK QUEUED',dependency:'WAITING', 'needs-input':'YOUR INPUT NEEDED',stopped:result?'SAVED PROGRESS':'STOPPED',completed:'OUTPUT AVAILABLE',acknowledge:'UPDATE APPLIED',reading:'READING SOURCE',writing:'WRITING RESPONSE',working:'WORKING',offline:'OFFLINE',idle:'READY'}[phase];
  ctx.fillStyle='#72eaf2';ctx.font='600 32px system-ui';ctx.fillText(heading??'READY',20,86,470);
  ctx.fillStyle='#17313d';ctx.beginPath();ctx.roundRect(16,108,480,166,12);ctx.fill();ctx.fillStyle='#e0edf0';ctx.font='22px system-ui';
  const copy=phase==='dependency'?'Waiting for '+(agent?.waitingFor??[]).join(', '):agent?.result?.question||(['completed','stopped'].includes(phase)?result:undefined)||agent?.activity?.text||agent?.task||'Awaiting a task';
  let y=139,line='';for(const word of copy.split(/\s+/)){if(ctx.measureText(line+word).width>446){ctx.fillText(line,30,y);line='';y+=29;}line+=word+' ';if(y>247)break;}ctx.fillText(line,30,y,446);
  if(phase==='writing'&&Math.floor(time*2)%2===0){ctx.fillStyle='#72eaf2';ctx.fillRect(Math.min(468,30+ctx.measureText(line).width),y-20,2,24);}
  ctx.fillStyle='#a3c7d1';ctx.font='16px system-ui';ctx.fillText('REPORTED ACTIVITY · NOT A LIVE SCREEN',20,304);seat.texture.needsUpdate=true;
 }
 function draw(now){
  const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;const dt=Math.min((now-last)/1000||.033,.08);clock+=hooks.reduced()?0:dt;
  if(w!==width||h!==height){width=w;height=h;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  const all=bound(),mobile=w<500,occupiedSeats=seats.filter((s,i)=>all[i]),columns=mobile?2:3,rows=Math.ceil(occupiedSeats.length/columns);
  occupiedSeats.forEach((seat,i)=>{seat.s.x=(i%columns-(columns-1)/2)*1.8;seat.s.z=(Math.floor(i/columns)-(rows-1)/2)*1.8;seat.desk.position.set(seat.s.x,0,seat.s.z);seat.labelAnchor.set(seat.s.x,1.58,seat.s.z-.1);});
  // Fit the entire actual roster, never just a selected desk. The stage itself
  // reserves the inspector's measured space, so no agent sits behind controls.
  const halfWidth=columns*.9+.2,halfDepth=Math.max(1,rows*.9),tan=Math.tan(T.MathUtils.degToRad(camera.fov/2)),distance=Math.max(halfWidth/(tan*camera.aspect),halfDepth/tan,4.6)*1.12;
  navigation.configure(distance,camera.aspect,occupiedSeats.map(s=>({id:s.s.id,position:[s.s.x,0,s.s.z]})));if(pendingFocus){navigation.focus(pendingFocus);pendingFocus='';}
  const view=navigation.view(),detail=view.mode==='agent',target=new T.Vector3(...view.target),desired=new T.Vector3(...view.position);
  const transition=frame&&!hooks.reduced()?1-Math.exp(-dt*4):1;camera.position.lerp(desired,transition);cameraTarget.lerp(target,transition);camera.lookAt(cameraTarget);ceiling.visible=camera.position.y<3.5;
  let lights=0,faceIntensity=0,handIntensity=0;const phases={};
  seats.forEach((seat,i)=>{const a=all[i];seat.desk.visible=!!a;if(!a)return;const phase=tracker.update(a,connected,now),motion=seat.avatar.pose(phase,clock+i*.61,dt,hooks.reduced());phases[a.id]=phase;
   const reported=behaviorFor(a,connected),desired=['working','reading','writing'].includes(reported)?1:0;seat.intensity+=(desired-seat.intensity)*(hooks.reduced()?1:1-Math.exp(-dt*9));if(!connected||!desired&&seat.intensity<.01)seat.intensity=0;
   seat.faceLight.intensity=seat.intensity*.6;seat.handLight.intensity=seat.intensity*.1;seat.surface.material.emissiveIntensity=.18+seat.intensity*.48;faceIntensity+=seat.faceLight.intensity;handIntensity+=seat.handLight.intensity;if(desired)lights++;
   seat.mouse.position.z=.44+(motion.scrolling?Math.sin(clock*2.6)*.005:0);screenContent(seat,a,phase,clock);
  });
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
  const occupied=[];
  for(const el of [...labels.children].sort((a,b)=>Number(b.dataset.agent===selected)-Number(a.dataset.agent===selected))){const i=all.findIndex(a=>a?.id===el.dataset.agent);el.hidden=i<0||detail&&el.dataset.agent!==selected;if(el.hidden)continue;const p=seats[i].labelAnchor.clone().project(camera);const lw=mobile?Math.min(132,(w-24)/2):136,lh=54,x=Math.max(6,Math.min(w-lw-6,(p.x*.5+.5)*w-lw/2));let y=Math.max(8,Math.min(h-lh-8,(-p.y*.5+.5)*h-lh));for(let retry=0;retry<occupied.length+1&&occupied.some(r=>x<r.x+lw&&x+lw>r.x&&y<r.y+lh&&y+lh>r.y);retry++)y=y>lh+13?y-lh-5:Math.min(h-lh-8,y+lh+5);occupied.push({x,y});el.style.left=x+'px';el.style.top=y+'px';el.style.width=lw+'px';el.style.height='auto';el.dataset.behavior=phases[el.dataset.agent];el.title=all[i].waitingFor?.length?'Waiting for '+all[i].waitingFor.join(', '):all[i].result?.question||all[i].task||all[i].name;const small=el.querySelector('small');if(small)small.textContent=all[i].waitingFor?.length?'Waiting for '+all[i].waitingFor.join(', '):({reading:'Reading',writing:'Writing',acknowledge:'Update applied','needs-input':'Needs you',stopped:'Saved state',completed:'Output ready'}[phases[el.dataset.agent]]||small.textContent);}
  if(detail){const label=[...labels.children].find(el=>el.dataset.agent===selected);if(label){label.style.left=Math.max(6,w-parseFloat(label.style.width)-8)+'px';label.style.top='8px';}}
  renderer.render(scene,camera);canvas.dataset.cameraMode=view.mode;canvas.dataset.cameraFocus=view.focusId;canvas.dataset.cameraRadius=view.radius.toFixed(3);canvas.dataset.cameraYaw=view.yaw.toFixed(3);canvas.dataset.cameraPitch=view.pitch.toFixed(3);
  canvas.dataset.agentHotspots=JSON.stringify(occupiedSeats.map(s=>{const p=s.avatar.bones.head.localToWorld(new T.Vector3(0,.05,.08)).project(camera);return {id:s.s.id,x:(p.x*.5+.5)*w,y:(-.5*p.y+.5)*h,visible:Math.abs(p.x)<1&&Math.abs(p.y)<1&&p.z>-1&&p.z<1};}));
  canvas.dataset.seatedAgents=String(occupiedSeats.length);canvas.dataset.frames=String(++frame);canvas.dataset.workingScreens=String(lights);canvas.dataset.faceLightIntensity=faceIntensity.toFixed(3);canvas.dataset.handLightIntensity=handIntensity.toFixed(3);canvas.dataset.visualization='skeletal-3d';canvas.dataset.environment=environment.identity;canvas.dataset.cityBackdrop='cyberpunk';canvas.dataset.wallArtwork='echo-panel';canvas.dataset.behaviors=JSON.stringify(phases);canvas.dataset.selected=selected;canvas.dataset.triangles=String(renderer.info.render.triangles);canvas.dataset.drawCalls=String(renderer.info.render.calls);
 }
 const resize=new ResizeObserver(()=>{dirty=true;});resize.observe(canvas);const visibility=()=>{dirty=true;};document.addEventListener('visibilitychange',visibility);
 function tick(now){if(disposed)return;const animate=now<cameraUntil||connected&&(now<transitionUntil||agents.some(a=>['working','running'].includes(a.status)));if(hooks.visible()&&(dirty||animate&&!hooks.reduced())&&now-last>=(innerWidth<780?50:33)){draw(now);dirty=false;last=now;}else if(!hooks.visible()){last=now;gestures.clear();}raf=requestAnimationFrame(tick);}raf=requestAnimationFrame(tick);
 return {update(next,id,online){const value=JSON.stringify([next,id,online]);agents=next.filter(a=>a.id!=='lead'&&a.profile!=='lead'&&!a.coordinator);reconcileSeats();selected=id;connected=online;if(value!==signature){signature=value;dirty=true;transitionUntil=performance.now()+1600;}},focus(id){if(!agents.some(a=>a.id===id))return;pendingFocus=id;cameraChanged();},overview(){pendingFocus='';navigation.overview();gestures.clear();cameraChanged();},zoom(factor){navigation.zoom(factor);cameraChanged();},redraw(){dirty=true;transitionUntil=performance.now()+1600;},reset(){tracker.clear();pendingFocus='';navigation.overview();gestures.clear();cameraChanged();},dispose(){disposed=true;cancelAnimationFrame(raf);gestures.dispose();resize.disconnect();document.removeEventListener('visibilitychange',visibility);seats.forEach(s=>s.avatar.dispose());geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());renderer.dispose();}};
}
