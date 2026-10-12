import * as T from './vendor/three.module.min.js';
const assets=new URL('./office-assets/humans/',import.meta.url);
const v=(x=0,y=0,z=0)=>new T.Vector3(x,y,z);
function obj(text){
 const positions=[],uv=[],faces=[];let group='';
 for(const line of text.split('\n')){const a=line.trim().split(/\s+/);if(a[0]==='v')positions.push(a.slice(1,4).map(Number));else if(a[0]==='vt')uv.push(a.slice(1,3).map(Number));else if(a[0]==='g')group=a[1];else if(a[0]==='f'){const f=a.slice(1).map(s=>s.split('/').map(n=>Number(n)-1));for(let i=1;i<f.length-1;i++)faces.push({group,verts:[f[0],f[i],f[i+1]]});}}
 return {positions,uv,faces};
}
function clothing(text){let section='',map=[],deleted=new Set(),scale=[];for(const l of text.split('\n')){const a=l.trim().split(/\s+/);if(/^[xyz]_scale$/.test(a[0]))scale['xyz'.indexOf(a[0][0])]=a.slice(1).map(Number);if(a[0]==='verts'){section='verts';continue;}if(a[0]==='delete_verts'){section='delete';continue;}if(!/^\d/.test(l.trim()))continue;if(section==='verts')map.push(a.map(Number));else if(section==='delete'){for(let i=0;i<a.length;i++){const n=Number(a[i]);if(a[i+1]==='-'){for(let k=n;k<=Number(a[i+2]);k++)deleted.add(k);i+=2;}else deleted.add(n);}}}return {map,deleted,scale};}
function fit(mesh,mapping,base){const factor=[0,1,2].map(i=>{const s=mapping.scale[i];return s?Math.abs(base.positions[s[0]][i]-base.positions[s[1]][i])/s[2]:1;});mesh.positions=mesh.positions.map((p,i)=>{const row=mapping.map[i];if(!row)return p;if(row.length===1)return [...base.positions[row[0]]];return [0,1,2].map(axis=>row.slice(0,3).reduce((n,vi,k)=>n+base.positions[vi][axis]*row[k+3],0)+(row[axis+6]??0)*factor[axis]);});return mesh;}
async function text(name){const r=await fetch(new URL(name,assets));if(!r.ok)throw Error('Character asset unavailable');return r.text();}
let source;
export async function loadCharacterSource(){
 if(!source)source=(async()=>{
  const names=['base.obj','default.mhskel','default_weights.mhw','female_elegantsuit01.obj','female_elegantsuit01.mhclo','male_casualsuit01.obj','male_casualsuit01.mhclo','ponytail01.obj','short01.obj','high-poly.obj','ponytail01.mhclo','short01.mhclo','high-poly.mhclo','shoes01.obj','shoes01.mhclo'];
  const data=await Promise.all(names.map(text)),base=obj(data[0]),rig=JSON.parse(data[1]),weights=JSON.parse(data[2]).weights;
  const entries=base.positions.map(()=>[]),boneNames=Object.keys(rig.bones);boneNames.forEach((name,i)=>{for(const [index,w] of weights[name]??[])entries[index]?.push([i,w]);});
  const joint=name=>rig.joints[name].reduce((p,i)=>p.add(v(...base.positions[i])),v()).divideScalar(rig.joints[name].length).multiplyScalar(.1);
  const texture=async name=>{const map=await new T.TextureLoader().loadAsync(new URL(name,assets).href);map.colorSpace=T.SRGBColorSpace;map.anisotropy=4;return map;};
  const [skin,femaleSuit,maleSuit,longHair,shortHair,eyes]=await Promise.all(['young_lightskinned_female_diffuse3.png','female_casualsuit01_diffuse.png','male_casualsuit01_diffuse.png','ponytail01_diffuse.png','short01_diffuse.png','brown_eye.png'].map(texture));
  const female=clothing(data[4]),male=clothing(data[6]),shoes=clothing(data[14]);
  return {base,rig,entries,boneNames,joint,skin,eyes,shoes:fit(obj(data[13]),shoes,base),shoeDeleted:shoes.deleted,female:{mesh:fit(obj(data[3]),female,base),...female,suit:femaleSuit,hair:fit(obj(data[7]),clothing(data[10]),base),hairMap:longHair},male:{mesh:fit(obj(data[5]),male,base),...male,suit:maleSuit,hair:fit(obj(data[8]),clothing(data[11]),base),hairMap:shortHair},eyeMesh:fit(obj(data[9]),clothing(data[12]),base)};
 })();return source;
}
function geometry(mesh,weights,accept=()=>true){
 const pos=[],uv=[],indices=[],skinIndex=[],skinWeight=[],lookup=new Map();
 for(const f of mesh.faces){if(!accept(f))continue;for(const [vi,ti] of f.verts){const key=vi+'/'+ti;let index=lookup.get(key);if(index===undefined){index=lookup.size;lookup.set(key,index);pos.push(...mesh.positions[vi].map(n=>n*.1));uv.push(...(mesh.uv[ti]??[0,0]));const pairs=(weights(vi)??[]).filter(p=>p[1]>0).sort((a,b)=>b[1]-a[1]).slice(0,4);const total=pairs.reduce((s,p)=>s+p[1],0)||1;for(let k=0;k<4;k++){skinIndex.push(pairs[k]?.[0]??0);skinWeight.push((pairs[k]?.[1]??(k===0&&!pairs.length?1:0))/total);}}indices.push(index);}}
 const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setAttribute('skinIndex',new T.Uint16BufferAttribute(skinIndex,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(skinWeight,4));g.setIndex(indices);g.computeVertexNormals();return g;
}
export function createCharacter(data,{female=true,shirt=0xffffff,glasses=false}={}){
 const group=new T.Group(),style=female?data.female:data.male,bones={},headIndex=data.boneNames.indexOf('head');
 for(const name of data.boneNames){const b=new T.Bone();b.name=name;const spec=data.rig.bones[name];b.position.copy(data.joint(spec.head));if(spec.parent)b.position.sub(data.joint(data.rig.bones[spec.parent].head));bones[name]=b;}
 for(const name of data.boneNames){const p=data.rig.bones[name].parent;(p?bones[p]:group).add(bones[name]);}
 group.updateMatrixWorld(true);const skeleton=new T.Skeleton(data.boneNames.map(n=>bones[n]));
 const nearestCache=new Map();
 const nearest=point=>{const key=point.join(',');if(nearestCache.has(key))return nearestCache.get(key);let best=Infinity,index=0;data.base.positions.forEach((p,i)=>{if(!data.entries[i]?.length)return;const d=p.reduce((s,x,k)=>s+(x-point[k])**2,0);if(d<best){best=d;index=i;}});nearestCache.set(key,index);return index;};
 const add=(g,m)=>{const mesh=new T.SkinnedMesh(g,m);mesh.bind(skeleton);mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;group.add(mesh);return mesh;};
 add(geometry(data.base,i=>data.entries[i],f=>f.group==='body'&&!f.verts.some(([i])=>style.deleted.has(i)||data.shoeDeleted.has(i))),new T.MeshStandardMaterial({map:data.skin,roughness:.68}));
 const clothesWeights=i=>{const row=style.map[i];if(!row)return data.entries[nearest(style.mesh.positions[i])];const sum=new Map();for(let k=0;k<3;k++){const list=data.entries[row[k]]?.length?data.entries[row[k]]:data.entries[nearest(data.base.positions[row[k]])];for(const [bone,w] of list)sum.set(bone,(sum.get(bone)??0)+w*row[k+3]);}return [...sum];};
 add(geometry(style.mesh,clothesWeights),new T.MeshStandardMaterial({map:female?null:style.suit,color:female?0x20292d:shirt,roughness:.9,side:T.DoubleSide}));
 add(geometry(style.hair,()=>[[headIndex,1]]),new T.MeshStandardMaterial({map:style.hairMap,roughness:.9,alphaTest:.45,side:T.DoubleSide}));
 add(geometry(data.eyeMesh,i=>[[data.boneNames.indexOf(data.eyeMesh.positions[i][0]>0?'eye.L':'eye.R'),1]]),new T.MeshStandardMaterial({map:data.eyes,roughness:.48}));
 add(geometry(data.shoes,i=>[[data.boneNames.indexOf(data.shoes.positions[i][0]>0?'foot.L':'foot.R'),1]]),new T.MeshStandardMaterial({color:0x1c2429,roughness:.6}));
 if(glasses){const metal=new T.MeshStandardMaterial({color:0x191c20,roughness:.38});for(const x of [-.046,.046]){const frame=new T.Mesh(new T.TorusGeometry(.033,.002,5,24),metal);frame.scale.set(1,.78,1);frame.position.set(x,.053,.122);bones.head.add(frame);}const bridge=new T.Mesh(new T.BoxGeometry(.027,.003,.003),metal);bridge.position.set(0,.054,.12);bones.head.add(bridge);}
 const rest=new Map(data.boneNames.map(n=>[n,bones[n].quaternion.clone()]));let phase='idle',blend=0,look=0,lean=0,legPose=null;
 function setRotation(name,x=0,y=0,z=0){bones[name]?.quaternion.setFromEuler(new T.Euler(x,y,z));}
 function reach(side,target,leg=false){const tip=bones[(leg?'foot.':'wrist.')+side],chain=(leg?['lowerleg01.','upperleg01.']:['lowerarm01.','upperarm01.','shoulder01.']).map(p=>bones[p+side]).filter(Boolean);for(let iter=0;iter<6;iter++)for(const bone of chain){group.updateMatrixWorld(true);const origin=bone.getWorldPosition(v()),a=tip.getWorldPosition(v()).sub(origin).normalize(),b=group.localToWorld(target.clone()).sub(origin).normalize();const delta=new T.Quaternion().setFromUnitVectors(a,b),parent=bone.parent.getWorldQuaternion(new T.Quaternion());bone.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));}}
 function pose(next,time,dt,reduced){
  phase=next;const engaged=['reading','writing','working'].includes(next),attend=['needs-input','acknowledge'].includes(next),k=reduced?1:1-Math.exp(-dt*5);
  blend+=(Number(engaged)-blend)*k;look+=((attend?-.4:engaged?.52:0)-look)*k;lean+=((next==='completed'?-.12:engaged?.1:0)-lean)*k;
  for(const [name,q] of rest)bones[name].quaternion.copy(q);
  setRotation('upperleg01.L',-1.23,0,-.12);setRotation('upperleg01.R',-1.23,0,.12);setRotation('lowerleg01.L',1.34);setRotation('lowerleg01.R',1.34);
  if(legPose)for(const [name,q] of legPose)bones[name].quaternion.copy(q);else{for(const [side,x] of [['L',.14],['R',-.14]]){reach(side,v(x,-.33,.44),true);const foot=bones['foot.'+side];foot.quaternion.copy(foot.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(group.getWorldQuaternion(new T.Quaternion())));}legPose=['upperleg01.L','upperleg01.R','lowerleg01.L','lowerleg01.R','foot.L','foot.R'].map(name=>[name,bones[name].quaternion.clone()]);}
  const breath=reduced||next==='offline'?0:Math.sin(time*1.35)*.006,scan=next==='reading'&&!reduced?Math.sin(time*.7)*.012:0;setRotation('spine05',lean+breath);setRotation('neck01',blend*.10);setRotation('head',blend*.04,look+scan,attend?.025:0);
  setRotation('eye.L',0,scan*.4);setRotation('eye.R',0,scan*.4);
  const cycle=(time%5.4),typing=next==='writing'&&cycle<3.7&&!reduced,stroke=typing?Math.sin(time*17)*.008:0;
  const scrolling=next==='reading'&&!reduced&&time%6.8<1.35,scroll=scrolling?Math.sin(time*2.6)*.003:0,mouse=next==='reading';
  reach('L',v(.14,.25+blend*.14+stroke,.23+blend*.18));reach('R',v(-.14-blend*(mouse?.15:0),.25+blend*.14-stroke+scroll,.23+blend*(mouse?.22:.18)));
  setRotation('wrist.L',-.22,0,.12);setRotation('wrist.R',-.22,0,-.12);
  for(const side of ['L','R'])for(let finger=2;finger<=5;finger++){const tap=typing?Math.max(0,Math.sin(time*17+finger+(side==='L'?0:2)))*.12:0;setRotation(`finger${finger}-1.${side}`,tap+.12);setRotation(`finger${finger}-2.${side}`,.17);}
  group.updateMatrixWorld(true);return {engaged,typing,scrolling,phase,blend};
 }
 // The mesh's authored origin is the pelvis. Keep its seat supported at 0.48 m.
 group.position.y=.43;
 return {group,bones,pose,get phase(){return phase;},dispose(){group.traverse(o=>{if(o.isMesh){o.geometry.dispose();o.material.dispose();}});skeleton.dispose();}};
}
