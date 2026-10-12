import * as T from './vendor/three.module.min.js';
const assets=new URL('./office-assets/',import.meta.url);
/* Authored scenery only. These murals and city lights never assert task state. */
export async function createEchoEnvironment(scene,resources){
 const {materials,geometries,textures}=resources,loader=new T.TextureLoader();
 const [city,paint]=await Promise.all(['cyberpunk-city-v1.png','echo-panel-wall.jpg'].map(name=>loader.loadAsync(new URL(name,assets).href)));
 for(const texture of [city,paint]){texture.colorSpace=T.SRGBColorSpace;texture.anisotropy=4;textures.push(texture);}
 const dark=new T.MeshStandardMaterial({color:0x102631,roughness:.65,metalness:.24}),rim=new T.MeshStandardMaterial({color:0x447986,roughness:.36,metalness:.7}),neon=new T.MeshStandardMaterial({color:0x74edf5,emissive:0x44c5d0,emissiveIntensity:.7,roughness:.4});materials.push(dark,rim,neon);
 function box(size,pos,mat){const geo=new T.BoxGeometry(...size);geometries.push(geo);const mesh=new T.Mesh(geo,mat);mesh.position.set(...pos);mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);return mesh;}
 function plane(size,pos,mat,rotation=0){const geo=new T.PlaneGeometry(...size);geometries.push(geo);const mesh=new T.Mesh(geo,mat);mesh.position.set(...pos);mesh.rotation.y=rotation;scene.add(mesh);return mesh;}
 const panorama=new T.MeshBasicMaterial({map:city,toneMapped:false,fog:false});materials.push(panorama);
 plane([32,13.72],[0,4,-15],panorama);
 // A nearby dimensional facade establishes depth between glass and panorama.
 const tower=box([1.7,7,1.1],[-7.8,1.4,-7.1],dark);tower.castShadow=false;
 const winGeo=new T.PlaneGeometry(.18,.11),windowMat=new T.MeshBasicMaterial({color:0xcda981,toneMapped:false});geometries.push(winGeo);materials.push(windowMat);const windows=new T.InstancedMesh(winGeo,windowMat,100),matrix=new T.Matrix4();let n=0;
 for(let row=0;row<20;row++)for(let col=0;col<5;col++){matrix.makeTranslation(-8.48+col*.31,-1.7+row*.32,-6.545);windows.setMatrixAt(n++,matrix);}scene.add(windows);
 box([.018,6.9,.018],[-6.98,1.4,-6.53],neon);
 // The original Echo panel art is painted on real inset wall panels.
 for(const side of [-1,1]){const wallTexture=paint.clone();wallTexture.wrapS=T.RepeatWrapping;wallTexture.repeat.set(7.6/3.12,1);wallTexture.needsUpdate=true;textures.push(wallTexture);const wallMat=new T.MeshStandardMaterial({map:wallTexture,color:0x536f7a,roughness:.88,emissive:0x1c4149,emissiveMap:wallTexture,emissiveIntensity:.16});materials.push(wallMat);
  plane([7.6,3.12],[side*6.899,1.96,-1.9],wallMat,-side*Math.PI/2);
  box([.028,.028,7.7],[side*6.85,.40,-1.9],rim);box([.018,.012,7.7],[side*6.83,3.49,-1.9],neon);
 }
 // Real sill and reveal edges keep the exterior visibly outside the office.
 box([14,.055,.32],[0,.665,-3.9],rim);box([14,.055,.24],[0,3.215,-3.9],rim);
 for(const x of [-7,-5,-3,-1,1,3,5,7])box([.024,2.52,.22],[x,1.93,-3.93],rim);
 const sign=document.createElement('canvas');sign.width=1024;sign.height=160;const ctx=sign.getContext('2d');ctx.fillStyle='#10242c';ctx.fillRect(0,0,1024,160);ctx.strokeStyle='#70eaf0';ctx.lineWidth=6;for(const r of [31,43]){ctx.beginPath();ctx.arc(77,80,r,0,Math.PI*2);ctx.stroke();}ctx.fillStyle='#edfbff';ctx.font='500 45px system-ui';ctx.fillText('ECHO  AGENT OFFICE',150,98);
 const signTexture=new T.CanvasTexture(sign);signTexture.colorSpace=T.SRGBColorSpace;textures.push(signTexture);const signMat=new T.MeshStandardMaterial({map:signTexture,emissiveMap:signTexture,emissive:0x9dcdd1,emissiveIntensity:.24,roughness:.4});materials.push(signMat);plane([2.6,.3],[2.7,3.4,-3.895],signMat);
 // Suspended ceiling fixtures provide a stable baseline; monitor light is separate.
 for(const x of [-2,1.5]){box([1.45,.07,.18],[x,3.46,.2],dark);box([1.32,.012,.13],[x,3.415,.2],neon);for(const dx of [-.55,.55])box([.012,.16,.012],[x+dx,3.56,.2],rim);}
 const ceiling=new T.DirectionalLight(0xffe3ca,1.65);ceiling.position.set(-2,3.42,.2);ceiling.target.position.set(0,.8,.2);ceiling.castShadow=true;ceiling.shadow.mapSize.set(1024,1024);Object.assign(ceiling.shadow.camera,{left:-6,right:6,top:6,bottom:-6});ceiling.shadow.bias=-.0005;ceiling.shadow.normalBias=.018;ceiling.shadow.radius=3;scene.add(ceiling,ceiling.target);
 const windowFill=new T.DirectionalLight(0x74bfdb,.8);windowFill.position.set(1,2.6,-4);windowFill.target.position.set(0,1,.5);scene.add(windowFill,windowFill.target);
 return {identity:'echo-cyberpunk-office-v1',city:'cyberpunk-city-v1.png',wall:'echo-panel-wall.jpg',fixtures:[{id:'ceiling-key',color:0xffe3ca,intensity:1.65,position:[-2,3.42,.2]},{id:'city-window-fill',color:0x74bfdb,intensity:.8,position:[1,2.6,-4]}]};
}
