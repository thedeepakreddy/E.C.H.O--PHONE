/* Locally bundled Three.js. This scene only visualizes the authoritative runner. */
import * as T from './vendor/three.module.min.js';

export function createOfficeScene(canvas, labels, hooks) {
 const renderer=new T.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(38,1,.1,90),room=new T.Group();scene.add(room);
 const materials=[],geometries=[],textures=[],people=new Map(),picks=[];
 let disposed=false,frame=0,last=0,dirty=true,selected='lead',connected=true,angle=.48,zoom=1,focusId=null;
 const mat=(color,roughness=.6,metalness=0)=>{const m=new T.MeshStandardMaterial({color,roughness,metalness});materials.push(m);return m;};
 const graphite=mat('#263c47',.45,.3),wood=mat('#ba9570'),floor=mat('#c1c6c2'),wall=mat('#d6deda'),cream=mat('#eeeae0'),metal=mat('#71848c',.24,.75),leaf=mat('#397760');
 const mesh=(g,m,p,x=0,y=0,z=0)=>{geometries.push(g);const o=new T.Mesh(g,m);o.castShadow=true;o.receiveShadow=true;o.position.set(x,y,z);p.add(o);return o;};
 const box=(p,m,w,h,d,x,y,z)=>mesh(new T.BoxGeometry(w,h,d),m,p,x,y,z);
 const ell=(p,m,x,y,z,sx,sy,sz)=>{const o=mesh(new T.SphereGeometry(1,24,16),m,p,x,y,z);o.scale.set(sx,sy,sz);return o;};
 const tube=(p,m,a,b,r)=>{const delta=new T.Vector3().subVectors(b,a);const o=mesh(new T.CylinderGeometry(r,r,delta.length(),12),m,p);o.position.copy(a).add(b).multiplyScalar(.5);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());return o;};
 const v=(x,y,z)=>new T.Vector3(x,y,z);
 scene.add(new T.HemisphereLight('#d9f7ff','#656658',1.1));
 const sun=new T.DirectionalLight('#fff0d9',2.1);sun.position.set(-6,8,-4);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-10,right:10,top:9,bottom:-9});sun.shadow.bias=-.001;scene.add(sun);
 const rim=new T.DirectionalLight('#77cddf',1);rim.position.set(4,4,5);scene.add(rim);
 box(room,floor,15,.18,10,0,-.12,0);box(room,wall,15,4,.16,0,1.9,-4.5);box(room,wall,.15,4,10,-7.5,1.9,0);
 // Framed windows, city silhouettes, acoustic slats and a pale oak floor.
 const glass=mat('#95c2cf',.18,.2);glass.transparent=true;glass.opacity=.5;
 for(let i=0;i<5;i++){box(room,glass,2.25,2.5,.05,-5.9+i*2.85,2.4,-4.35);for(const dx of [-1.18,1.18])box(room,metal,.045,2.6,.06,-5.9+i*2.85+dx,2.4,-4.29);box(room,metal,2.4,.04,.08,-5.9+i*2.85,1.1,-4.25);}
 for(let i=0;i<29;i++)box(room,wood,.012,.005,10,-7+i*.5,-.021,0);
 for(let i=0;i<22;i++)box(room,graphite,.045,2.6,.06,-3.5+i*.32,2.4,-4.18);
 function plant(x,z){mesh(new T.CylinderGeometry(.25,.2,.44,24),cream,room,x,.22,z);for(let i=0;i<9;i++){const a=i*2.4,b=v(x+Math.cos(a)*.35,.8+(i%3)*.16,z+Math.sin(a)*.35);tube(room,leaf,v(x,.4,z),b,.015);const l=ell(room,leaf,b.x,b.y,b.z,.1,.3,.08);l.rotation.z=Math.sin(a)*.6;}}
 plant(-6.8,-3.4);plant(6.6,-3.4);plant(-6.8,3.6);plant(6.7,3.3);
 // Echo remains Echo's original detailed humanoid, projected above the coordinator podium.
 const podium=new T.Group();podium.position.set(0,0,-3.2);room.add(podium);mesh(new T.CylinderGeometry(.67,.72,.32,48),graphite,podium,0,.16,0);
 const glow=mat('#40d6e9',.2,.3);glow.emissive=new T.Color('#27b3d9');glow.emissiveIntensity=.8;mesh(new T.TorusGeometry(.62,.02,10,60),glow,podium,0,.33,0).rotation.x=-Math.PI/2;
 const echoTexture=new T.CanvasTexture(hooks.echoCanvas);textures.push(echoTexture);const echoMaterial=new T.MeshBasicMaterial({map:echoTexture,transparent:true,depthWrite:false,side:T.DoubleSide});materials.push(echoMaterial);const holo=mesh(new T.PlaneGeometry(1.35,1.75),echoMaterial,podium,0,1.23,0);holo.userData.agent='lead';picks.push(holo);
 function screenTexture(){const c=document.createElement('canvas');c.width=256;c.height=160;const tex=new T.CanvasTexture(c);textures.push(tex);return {canvas:c,tex};}
 function drawScreen(person){const c=person.display.canvas,g=c.getContext('2d'),working=connected&&['working','running'].includes(person.state.status);g.fillStyle=working?'#092a36':'#13222b';g.fillRect(0,0,256,160);g.fillStyle=working?'#99e5ee':'#708a94';g.font='16px system-ui';g.fillText(person.state.name.slice(0,22),16,28);g.fillStyle=working?'#56d1df':'#3d535b';for(let i=0;i<6;i++)g.fillRect(16,48+i*14,80+((i*37)%150),4);g.fillStyle='#c8e7e9';g.font='12px system-ui';g.fillText(working?'Working · live task':connected?'Ready / waiting':'Offline',16,148);person.display.tex.needsUpdate=true;person.screen.material.emissiveIntensity=working?1.45:.12;person.light.intensity=working?1.2:0;person.working=working;}
 function createPerson(id,i){
  const group=new T.Group(),desk=new T.Group();group.position.set((i%3-1)*4.35,0,-.65+Math.floor(i/3)*3.1);group.rotation.y=Math.PI+.12;room.add(group);group.add(desk);
  box(desk,wood,2.85,.1,1.3,0,.96,0);for(const x of [-1.2,1.2])for(const z of [-.48,.48])box(desk,graphite,.055,.93,.055,x,.45,z);
  // Monitor points toward the seated person and visibly illuminates their actual face.
  box(desk,graphite,1.1,.50,.07,0,1.32,-.33);box(desk,metal,.06,.22,.05,0,1.08,-.33);box(desk,graphite,.5,.025,.28,0,1.022,-.33);
  const display=screenTexture(),screenMat=mat('#ffffff',.35,.1);screenMat.map=display.tex;screenMat.emissiveMap=display.tex;screenMat.emissive=new T.Color('#b7f8ff');const screen=mesh(new T.PlaneGeometry(1.03,.43),screenMat,desk,0,1.32,-.29);
  const light=new T.PointLight('#a8efff',0,2.8,2);light.position.set(0,1.30,-.05);group.add(light);
  box(desk,graphite,.67,.018,.23,0,1.025,.35);for(let row=0;row<4;row++)for(let col=0;col<11;col++)box(desk,metal,.042,.008,.039,-.29+col*.056,1.04,.27+row*.048);
  ell(desk,graphite,.58,1.048,.36,.075,.025,.11);mesh(new T.CylinderGeometry(.055,.045,.14,18),cream,desk,-.84,1.08,.2);
  box(desk,cream,.37,.018,.44,.99,1.026,.26);
  const chair=new T.Group();chair.position.set(0,0,.98);group.add(chair);box(chair,graphite,.63,.09,.58,0,.55,0);const back=ell(chair,graphite,0,.97,.23,.34,.38,.08);back.rotation.x=-.08;tube(chair,metal,v(0,.08,0),v(0,.54,0),.055);for(let k=0;k<5;k++){const a=k*Math.PI*2/5;const end=v(Math.sin(a)*.38,.09,Math.cos(a)*.38);tube(chair,metal,v(0,.13,0),end,.025);ell(chair,graphite,end.x,.055,end.z,.065,.055,.04);}
  const avatar=new T.Group();avatar.position.set(0,0,.79);group.add(avatar);
  const skins=['#d0a18a','#8d6250','#dbb598','#a77960','#bd8b73','#95634f'],skin=mat(skins[i%skins.length],.83),hair=mat(['#332721','#3d302c','#242b30'][i%3],.9),shirt=mat(['#496b82','#697a6e','#a18c72','#626b89','#847180','#506f73'][i%6],.9),trousers=mat('#313d4a',.95),eyes=mat('#27272b');
  const torso=new T.Group();torso.position.set(0,1.02,0);avatar.add(torso);ell(torso,shirt,0,-.08,0,.24,.35,.135);ell(torso,shirt,0,-.37,0,.22,.10,.14);
  tube(torso,skin,v(0,.23,0),v(0,.43,0),.07);const head=new T.Group();head.position.set(0,.55,-.012);torso.add(head);ell(head,skin,0,0,0,.13,.18,.14);ell(head,skin,0,-.10,-.025,.094,.075,.092);
  const cap=mesh(new T.SphereGeometry(1,24,12,0,Math.PI*2,0,Math.PI*.56),hair,head,0,.037,.004);cap.scale.set(.138,.157,.145);
  // Facial structure is deliberately modeled; no cube heads or floating name-only avatars.
  for(const side of [-1,1]){ell(head,skin,side*.128,-.02,0,.025,.043,.033);ell(head,cream,side*.05,.017,-.122,.035,.012,.016);ell(head,eyes,side*.05,.017,-.135,.008,.008,.004);tube(head,hair,v(side*.022,.043,-.132),v(side*.078,.049,-.119),.006);}
  ell(head,skin,0,-.03,-.139,.019,.043,.027);tube(head,mat('#925e54',.9),v(-.032,-.09,-.121),v(.032,-.09,-.121),.003);
  const hands=[];for(const side of [-1,1]){tube(avatar,trousers,v(side*.14,.60,0),v(side*.16,.59,-.35),.09);tube(avatar,trousers,v(side*.16,.59,-.35),v(side*.16,.12,-.35),.067);ell(avatar,graphite,side*.16,.08,-.40,.08,.055,.16);
   tube(torso,shirt,v(side*.21,.12,0),v(side*.30,-.15,-.15),.077);tube(torso,shirt,v(side*.30,-.15,-.15),v(side*.20,0,-.39),.052);
   const hand=new T.Group();hand.position.set(side*.20,1.025,-.38);avatar.add(hand);ell(hand,skin,0,0,0,.055,.025,.068);const fingers=[];for(let f=0;f<4;f++){const finger=new T.Group();finger.position.set((f-1.5)*.022,0,-.045);hand.add(finger);tube(finger,skin,v(0,0,0),v(0,-.007,-.058+(f===0?.012:0)),.008);fingers.push(finger);}tube(hand,skin,v(side*.043,0,0),v(side*.07,-.015,-.039),.012);hands.push({hand,fingers});}
  const halo=mesh(new T.TorusGeometry(.48,.012,8,48),glow,group,0,.012,.85);halo.rotation.x=-Math.PI/2;halo.visible=false;
  avatar.traverse(o=>{if(o.isMesh){o.userData.agent=id;picks.push(o);}});
  const p={id,group,avatar,torso,head,hands,light,screen,display,halo,working:false,state:{name:id,status:'idle'},phase:i*1.9};people.set(id,p);return p;
 }
 function placeCamera(){const focused=people.get(focusId);if(focused){const p=focused.group.position;camera.position.set(p.x+Math.sin(angle)*4,p.y+3.1,p.z+Math.cos(angle)*4);camera.lookAt(p.x,1.05,p.z);}else{const scale=canvas.clientWidth<500?1.5:1,radius=17*zoom*scale;camera.position.set(Math.sin(angle)*radius,11.3*zoom*scale,Math.cos(angle)*radius);camera.lookAt(0,.55,.3);}}
 placeCamera();
 function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;if(w&&h){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();placeCamera();}}
 function draw(now){resize();const reduced=hooks.reduced(),t=reduced?0:now*.001;for(const p of people.values()){
   const work=p.working,a=p.phase;p.torso.rotation.x=work?-.055:0;p.torso.rotation.z=reduced?0:Math.sin(t*.7+a)*.009;
   p.head.rotation.x=work?.12:0;p.head.rotation.y=work?(reduced?0:Math.sin(t*.6+a)*.045):.10;
   for(let k=0;k<p.hands.length;k++){const {hand,fingers}=p.hands[k];hand.position.y=1.025+(work&&!reduced?Math.sin(t*5.4+a+k)*.009:0);for(let f=0;f<fingers.length;f++)fingers[f].rotation.x=work&&!reduced?Math.max(0,Math.sin(t*(6+f)+a+k))*-.20:0;}
   p.halo.visible=p.id===selected;
  }
  hooks.echo?.draw(now,connected&&['working','running'].includes(holo.userData.status)?'thinking':'idle');echoTexture.needsUpdate=true;holo.quaternion.copy(camera.quaternion);
  renderer.render(scene,camera);for(const el of labels.children){const p=people.get(el.dataset.agent);if(!p)continue;const position=p.group.position.clone().add(v(0,2.13,.15)).project(camera);el.style.left=(position.x*.5+.5)*100+'%';el.style.top=(-position.y*.5+.5)*100+'%';el.hidden=position.z>1||Math.abs(position.x)>.95||Math.abs(position.y)>.95;}
  canvas.dataset.frames=String(++frame);canvas.dataset.workingScreens=String([...people.values()].filter(p=>p.light.intensity>0).length);canvas.dataset.faceLightIntensity=String([...people.values()].reduce((n,p)=>n+p.light.intensity,0));
 }
 function tick(now){if(disposed)return;const visible=hooks.visible(),limit=innerWidth<780?50:33;if(visible&&(dirty||!hooks.reduced())&&now-last>=limit){draw(now);dirty=false;last=now;}raf=requestAnimationFrame(tick);}
 let raf=requestAnimationFrame(tick);
 let pointer=null;const down=e=>{if(e.pointerType!=='mouse')return;pointer={x:e.clientX,y:e.clientY,angle,moved:false};},move=e=>{if(!pointer)return;const dx=e.clientX-pointer.x;pointer.moved||=Math.abs(dx)>5;angle=pointer.angle+dx*.005;dirty=true;},up=e=>{if(!pointer)return;if(!pointer.moved){const r=canvas.getBoundingClientRect(),ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);const hit=ray.intersectObjects(picks)[0];if(hit)hooks.select(hit.object.userData.agent);}pointer=null;};
 const moveCamera=e=>{move(e);placeCamera();};canvas.addEventListener('pointerdown',down);window.addEventListener('pointermove',moveCamera);window.addEventListener('pointerup',up);
 const visibility=()=>{dirty=true;};document.addEventListener('visibilitychange',visibility);
 return {update(agents,id,online){selected=id;connected=online;const ids=new Set(agents.filter(a=>a.id!=='lead').map(a=>a.id));for(const [id,p]of people)if(!ids.has(id)){room.remove(p.group);people.delete(id);for(let i=picks.length-1;i>=0;i--)if(picks[i].userData.agent===id)picks.splice(i,1);}agents.filter(a=>a.id!=='lead').forEach((a,i)=>{const p=people.get(a.id)||createPerson(a.id,i);p.state=a;drawScreen(p);});holo.userData.status=agents.find(a=>a.id==='lead')?.status||'idle';hooks.echo?.draw(performance.now(),['working','running'].includes(holo.userData.status)?'thinking':'idle');dirty=true;},focus(id){focusId=people.has(id)?id:null;placeCamera();dirty=true;},redraw(){dirty=true;},reset(){focusId=null;angle=.48;zoom=1;placeCamera();dirty=true;},dispose(){disposed=true;cancelAnimationFrame(raf);canvas.removeEventListener('pointerdown',down);window.removeEventListener('pointermove',moveCamera);window.removeEventListener('pointerup',up);document.removeEventListener('visibilitychange',visibility);geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());renderer.dispose();}};
}
