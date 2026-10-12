import assert from 'node:assert/strict';
import {createOfficeCamera,bindOfficeNavigation} from '../public/agent-office-navigation.js';
const camera=createOfficeCamera(),anchors=[{id:'research',position:[-1.8,0,.9]},{id:'plan',position:[0,0,-.9]}];
camera.configure(7,1.6,anchors);
assert.equal(camera.focus('echo'),false);
assert.equal(camera.focus('research'),true);
assert.equal(camera.view().focusId,'research');
camera.zoom(.01);assert.equal(camera.view().radius,1.5);camera.zoom(1/.85);assert.ok(camera.view().radius>1.5,'Zoom out responds immediately at the near limit');
camera.zoom(100);assert.equal(camera.view().zoom,2.5);
camera.orbit(100,-100);assert.equal(camera.view().yaw,1.05);assert.equal(camera.view().pitch,.1);
camera.orbit(-100,100);assert.equal(camera.view().yaw,-1.05);assert.equal(camera.view().pitch,.85);
const before=camera.view();camera.zoom(NaN);camera.orbit(Infinity,0);assert.deepEqual(camera.view(),before);
camera.configure(9,.5,anchors);assert.equal(camera.view().focusId,'research');assert.equal(camera.view().yaw,before.yaw);
camera.configure(9,.5,[]);assert.equal(camera.view().mode,'overview');
camera.zoom(.01);assert.equal(camera.view().zoom,.55);camera.zoom(100);assert.equal(camera.view().zoom,1.75);
camera.overview();assert.equal(camera.view().zoom,1);assert.equal(camera.view().yaw,0);
camera.configure(Infinity,NaN,[{id:'bad',position:[NaN,0,0]}]);assert.equal(camera.focus('bad'),false);assert.ok(camera.view().position.every(Number.isFinite));
class Canvas extends EventTarget {
 constructor(){super();this.captures=new Set();this.ownerDocument={defaultView:new EventTarget()};this.classList={add(){},remove(){}};this.clientHeight=400;}
 focus(){} getBoundingClientRect(){return {width:600,height:400};}
 setPointerCapture(id){this.captures.add(id);}hasPointerCapture(id){return this.captures.has(id);}releasePointerCapture(id){this.captures.delete(id);}
}
const canvas=new Canvas(),calls=[];let enabled=true;
const navigation=bindOfficeNavigation(canvas,{enabled:()=>enabled,...Object.fromEntries(['pick','orbit','zoom','changed','overview','inspect'].map(name=>[name,(...args)=>calls.push([name,...args])]))});
const send=(type,props={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,{button:0,pointerId:1,clientX:100,clientY:100,...props});canvas.dispatchEvent(e);return e;};
send('pointerdown');send('pointerup');assert.deepEqual(calls.filter(c=>c[0]==='pick'),[['pick',100,100]]);
calls.length=0;send('pointerdown');send('pointermove',{clientX:200});send('pointerup',{clientX:200});assert.ok(calls.some(c=>c[0]==='orbit'));assert.ok(!calls.some(c=>c[0]==='pick'));
calls.length=0;send('pointerdown');send('pointerdown',{pointerId:2,clientX:200});send('pointermove',{pointerId:2,clientX:240});send('pointerup',{pointerId:2,clientX:240});send('pointerup');assert.ok(calls.some(c=>c[0]==='zoom'));assert.ok(!calls.some(c=>c[0]==='pick'));
calls.length=0;send('pointerdown');send('pointercancel');send('pointerdown');send('lostpointercapture');send('pointerup');assert.ok(!calls.some(c=>c[0]==='pick'));
calls.length=0;assert.equal(send('wheel',{deltaY:99999,deltaMode:0}).defaultPrevented,true);assert.ok(calls.find(c=>c[0]==='zoom')[1]<3);
for(const key of ['+','-','ArrowLeft','ArrowDown','Home','Enter'])assert.equal(send('keydown',{key}).defaultPrevented,true);
assert.equal(send('keydown',{key:'Escape'}).defaultPrevented,false);
calls.length=0;enabled=false;send('pointerdown');send('pointerup');send('wheel',{deltaY:10});send('keydown',{key:'+'});assert.deepEqual(calls,[]);
enabled=true;send('pointerdown');navigation.clear();assert.equal(canvas.captures.size,0);calls.length=0;navigation.dispose();send('wheel',{deltaY:10});send('pointerdown');send('pointerup');assert.deepEqual(calls,[]);
console.log('PASS camera focus, resize preservation, bounds, safe invalid inputs, drag/tap separation, pinch, cancellation, keyboard, offline-independent enablement and listener cleanup.');
