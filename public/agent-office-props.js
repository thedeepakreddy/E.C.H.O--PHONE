import * as T from './vendor/three.module.min.js';
const root=new URL('./office-assets/props/',import.meta.url);
async function file(url,json=false){const r=await fetch(url);if(!r.ok)throw Error('Office prop unavailable');return json?r.json():r.arrayBuffer();}
export async function loadOfficeMaterials(wood,floor){
 const loader=new T.TextureLoader(),maps=[];
 for(const [mat,id,repeats] of [[wood,'wood_table_001',1],[floor,'wood_planks_grey',5]]){
  const [diff,normal,rough]=await Promise.all(['diff','nor_gl',id==='wood_planks_grey'?'arm':'rough'].map(type=>loader.loadAsync(new URL(`${id}/textures/${id}_${type}_1k.jpg`,root).href)));
  for(const map of [diff,normal,rough]){map.wrapS=map.wrapT=T.RepeatWrapping;map.repeat.set(repeats,repeats);map.anisotropy=4;maps.push(map);}diff.colorSpace=T.SRGBColorSpace;
  mat.color.set(0xffffff);mat.map=diff;mat.normalMap=normal;mat.normalScale.set(.22,.22);mat.roughnessMap=rough;mat.needsUpdate=true;
 }return maps;
}
/* Restricted loader for our pinned, static CC0 glTF. No remote URLs, scripts,
 * extensions, animations, compression or arbitrary user models are accepted. */
export async function loadOfficePlant(){
 const url=new URL('potted_plant_02/potted_plant_02.gltf',root),gltf=await file(url,true);
 if(gltf.asset.version!=='2.0'||gltf.extensionsRequired?.length)throw Error('Unsupported static office prop');
 const local=uri=>{const path=new URL(uri,url);if(path.origin!==url.origin||!path.href.startsWith(new URL('.',url).href))throw Error('Nonlocal office prop');return path;};
 const buffers=await Promise.all(gltf.buffers.map(b=>file(local(b.uri)))),textures=await Promise.all(gltf.images.map(img=>new T.TextureLoader().loadAsync(local(img.uri).href)));
 textures.forEach(t=>{t.flipY=false;t.anisotropy=4;});
 const map=spec=>spec?textures[gltf.textures[spec.index].source]:null;
 const materials=gltf.materials.map(m=>{const p=m.pbrMetallicRoughness??{},diff=map(p.baseColorTexture);if(diff)diff.colorSpace=T.SRGBColorSpace;return new T.MeshStandardMaterial({map:diff,normalMap:map(m.normalTexture),roughnessMap:map(p.metallicRoughnessTexture),roughness:p.roughnessFactor??1,metalness:p.metallicFactor??0,side:m.doubleSided?T.DoubleSide:T.FrontSide,alphaTest:m.alphaMode==='MASK'?m.alphaCutoff??.5:0});});
 function accessor(id){const a=gltf.accessors[id],view=gltf.bufferViews[a.bufferView],Ctor={5126:Float32Array,5125:Uint32Array,5123:Uint16Array}[a.componentType],n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];if(!Ctor||!n||view.byteStride)throw Error('Unsupported pinned prop accessor');return {array:new Ctor(buffers[view.buffer],(view.byteOffset??0)+(a.byteOffset??0),a.count*n).slice(),n};}
 const group=new T.Group(),geometries=[];
 gltf.nodes.forEach(node=>{if(node.mesh===undefined)return;const part=new T.Group();if(node.translation)part.position.fromArray(node.translation);if(node.rotation)part.quaternion.fromArray(node.rotation);if(node.scale)part.scale.fromArray(node.scale);for(const p of gltf.meshes[node.mesh].primitives){const geo=new T.BufferGeometry();for(const [key,name] of [['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv']])if(p.attributes[key]!==undefined){const a=accessor(p.attributes[key]);geo.setAttribute(name,new T.BufferAttribute(a.array,a.n));}const index=accessor(p.indices);geo.setIndex(new T.BufferAttribute(index.array,1));geometries.push(geo);const mesh=new T.Mesh(geo,materials[p.material]);mesh.castShadow=true;mesh.receiveShadow=true;part.add(mesh);}group.add(part);});
 return {group,textures,materials,geometries};
}
