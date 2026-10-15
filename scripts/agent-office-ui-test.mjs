import assert from 'node:assert/strict';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createRelay} from '../server.js';
import {GeminiError} from '../lib/gemini.js';
const pw=process.env.ECHO_BROWSER_DEPENDENCIES?await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES,'playwright/index.mjs')).href):await import('playwright');
let release,turn=0;
const gemini={model:'gemini-3.8-flash',fallbackModels:['gemini-3.5-flash-lite'],embed:async()=>Array(512).fill(0),generate:async(body,{modelId})=>{if(modelId==='gemini-3.8-flash')throw new GeminiError('server','fixture high demand');turn++;if(turn===1){await new Promise(r=>release=r);return {candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_today',args:{}}}]}}]};}return {candidates:[{content:{role:'model',parts:[{text:JSON.stringify(body.contents)}]}}]};}};
const relay=createRelay({secret:'isolated-office-ui-fixture-'.repeat(4),gemini,fetchJson:async()=>({})}),server=http.createServer(relay.handler);
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;await mkdir('/tmp/echo-office-ui',{recursive:true});
const engine=process.env.ECHO_OFFICE_BROWSER||'chromium';const browser=await pw[engine].launch({headless:true,...(engine==='webkit'&&process.env.ECHO_WEBKIT_EXECUTABLE?{executablePath:process.env.ECHO_WEBKIT_EXECUTABLE}:{})});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 const refresh=async()=>{await page.locator('.office-workspace-menu summary').click();await page.locator('.office-workspace-menu').getByRole('button',{name:'Refresh',exact:true}).click();};
 await page.goto(url);await page.locator('#get-started').click();await page.locator('[data-tab="bots"]').click();await page.locator('#bots-member option').first().waitFor({state:'attached'});
 await page.waitForFunction(()=>document.querySelector('.office-canvas').dataset.seatedAgents==='6');
 assert.equal(await page.locator('.office-inspector').isVisible(),false);
 assert.equal(await page.locator('.office-agent-select').count(),0);
 assert.equal(await page.locator('.office-workspace-menu .office-run-select').count(),1,'Task switching remains available in workspace options');
 assert.ok(await page.locator('.office-controls').evaluate(n=>n.getBoundingClientRect().height<=62),'Phone launch bar stays on one row');
 assert.equal(await page.locator('.office-desk-label:not([hidden])').count(),6);
 await page.screenshot({path:'/tmp/echo-office-ui/phone-overview.png'});
 const hit=await page.locator('.office-canvas').evaluate(c=>{const r=c.getBoundingClientRect();return JSON.parse(c.dataset.agentHotspots).map(p=>({...p,x:p.x+r.left,y:p.y+r.top})).find(p=>p.visible&&p.id==='analyse'&&document.elementFromPoint(p.x,p.y)===c);});
 assert.ok(hit,'Analyse head is exposed on the actual 3D canvas');
 await page.touchscreen.tap(hit.x,hit.y);await page.waitForFunction(()=>document.querySelector('.office-canvas').dataset.cameraFocus==='analyse');assert.equal(await page.locator('.office-inspector h3').innerText(),'Analyse','Touch raycast selects the real character');
 assert.equal(await page.getByRole('button',{name:'Zoom in',exact:true}).evaluate(b=>b.getBoundingClientRect().height),44);
 const radius=Number(await page.locator('.office-canvas').getAttribute('data-camera-radius'));await page.getByRole('button',{name:'Zoom in',exact:true}).click();await page.waitForFunction(r=>Number(document.querySelector('.office-canvas').dataset.cameraRadius)<r,radius);
 const box=await page.locator('.office-canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+10,{steps:5});await page.mouse.up();await page.waitForFunction(()=>Number(document.querySelector('.office-canvas').dataset.cameraYaw)<-.65);assert.equal(await page.locator('.office-inspector h3').innerText(),'Analyse','Dragging never selects another agent');
 await page.locator('.office-canvas').focus();await page.keyboard.press('Home');await page.waitForFunction(()=>document.querySelector('.office-canvas').dataset.cameraMode==='overview');assert.equal(await page.locator('.office-desk-label:not([hidden])').count(),6);
 await page.waitForTimeout(1800);
 const pinch=await page.locator('.office-canvas').evaluate(c=>{const r=c.getBoundingClientRect();for(let y=r.top+r.height*.6;y<r.bottom-65;y+=20)for(let x=r.left+65;x<r.right-65;x+=20)if([x-40,x,x+40].every(v=>document.elementFromPoint(v,y)===c))return {x,y};});assert.ok(pinch,'Pinch starts on the 3D canvas, not an overlaid control');
 const pinchRadius=Number(await page.locator('.office-canvas').getAttribute('data-camera-radius'));
 if(engine==='chromium'){const session=await context.newCDPSession(page),points=spread=>[-1,1].map((n,i)=>({x:pinch.x+n*spread,y:pinch.y,id:i+1}));await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points(20)});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points(40)});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();}
 else await page.locator('.office-canvas').evaluate((c,p)=>{for(const [type,spread] of [['pointerdown',20],['pointermove',40],['pointerup',40]])for(const [i,n] of [[1,-1],[2,1]])c.dispatchEvent(new PointerEvent(type,{pointerId:i,button:0,pointerType:'touch',clientX:p.x+n*spread,clientY:p.y,bubbles:true,cancelable:true}));},pinch);
 await page.waitForFunction(r=>Number(document.querySelector('.office-canvas').dataset.cameraRadius)<r,pinchRadius);assert.equal(await page.locator('.office-inspector').isVisible(),false,'Pinch never selects an agent');
 await page.getByRole('button',{name:'Show full office',exact:true}).click();
 await page.getByRole('button',{name:'Assign task',exact:true}).click();await page.locator('#bots-member').selectOption('research');await page.locator('#bots-goal').fill('Compare options');await page.locator('#bots-run button[type=submit]').click();await page.locator('.office-desk-label[data-agent=research]').click();await page.locator('#agent-office').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>Number(document.querySelector('.office-canvas').dataset.workingScreens)===1);assert.equal(await page.locator('#bots-assignment').evaluate(d=>d.open),false);assert.equal(await page.locator('.office-inspector h3').innerText(),'Research');assert.ok(await page.locator('.office-canvas').evaluate(c=>Number(c.dataset.faceLightIntensity)>0));
 await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'Pause motion',exact:true}).click();
 await page.waitForTimeout(1800);
 await page.evaluate(()=>document.querySelector('#v-bots .scroll').scrollTop=0);await page.screenshot({path:'/tmp/echo-office-ui/phone-working.png'});
 const nav=await page.locator('#tabbar').boundingBox(),buttons=await page.locator('.office-action-buttons').boundingBox();assert.ok(buttons.y+buttons.height<=nav.y,'Update and revise fit above phone navigation');
 assert.equal(await page.locator('#tabbar [data-tab="bots"]').innerText(),'Agents');
 for(const selector of ['#bots-target','#v-bots .top .back','.office-controls>.office-primary','.office-menu>summary','.office-action-buttons .office-button:not([hidden])','.office-desk-label:not([hidden])']){assert.ok(await page.locator(selector).evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44)),`${selector} has 44px touch targets`);}
 assert.equal(await page.locator('#bots-target').evaluate(n=>getComputedStyle(n).appearance),'none');
 assert.ok(await page.locator('.office-action-buttons .office-button:not([hidden])').evaluateAll(nodes=>nodes.every(n=>parseFloat(getComputedStyle(n).fontSize)>=13&&n.scrollWidth<=n.clientWidth)), 'Inspector actions have readable, unclipped labels');
 await page.setViewportSize({width:320,height:844});
 assert.ok(await page.locator('.office-action-buttons .office-button:not([hidden])').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth)), 'Active controls remain unclipped on the smallest supported Phone');
 assert.ok(await page.locator('.office-controls').evaluate(n=>n.scrollWidth<=n.clientWidth&&n.getBoundingClientRect().height<=62),'Phone toolbar remains one row at 320px');
 await page.setViewportSize({width:390,height:844});
 await page.locator('.office-workspace-menu summary').click();await page.locator('.office-workspace-menu button').first().focus();await page.keyboard.press('Escape');assert.equal(await page.locator('.office-workspace-menu').evaluate(d=>d.open),false);assert.equal(await page.locator('.office-workspace-menu summary').evaluate(n=>n===document.activeElement),true);
 assert.equal(await page.locator('.office-echo-tile').evaluate(n=>n.tagName),'DIV');
 await page.getByRole('button',{name:'Close inspector',exact:true}).click();assert.equal(await page.locator('.office-inspector').isVisible(),false);
 await page.locator('.office-desk-label[data-agent=research]').click();await refresh();assert.equal(await page.locator('.office-inspector h3').innerText(),'Research');
 await page.locator('.office-update-input').fill('Use yearly pricing');await refresh();assert.equal(await page.locator('.office-update-input').inputValue(),'Use yearly pricing');
 await page.getByRole('button',{name:'Zoom out',exact:true}).click();assert.equal(await page.locator('.office-update-input').inputValue(),'Use yearly pricing','Camera controls preserve agent instructions');
 const update=page.waitForResponse(r=>r.url().endsWith('/cloud/bots')&&r.request().postDataJSON()?.action==='control');await page.getByRole('button',{name:'Send update',exact:true}).click();const accepted=await(await update).json();assert.equal(accepted.command.status,'queued');release();
 await refresh();await page.waitForFunction(()=>document.querySelector('.office-command')?.textContent.includes('Applied'));await page.waitForFunction(()=>document.querySelector('.office-output')?.textContent.includes('Use yearly pricing'));assert.match(await page.locator('.office-output').innerText(),/Use yearly pricing/);
 assert.match(await page.locator('.office-output [data-model-notice]').innerText(),/gemini-3\.5-flash-lite/,'The actual agent inspector discloses its fallback brain');
 await page.locator('#agent-office').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.office-canvas').dataset.workingScreens==='0');
 await page.getByRole('button',{name:'Follow up',exact:true}).first().click();assert.equal(await page.locator('#bots-assignment').evaluate(d=>d.open),true);await page.locator('#bots-goal').fill('Explain the verified options');await page.locator('#bots-run button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.office-goal')?.textContent==='Explain the verified options');
 // A completed follow-up can legitimately redraw once. Observe reduced motion
 // after its state has settled, not while completion is still arriving.
 await page.waitForFunction(()=>document.querySelector('.office-inspector').dataset.ended==='true'&&document.querySelector('.office-canvas').dataset.workingScreens==='0');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>{const frame=document.querySelector('.office-canvas').dataset.frames,now=performance.now(),quiet=window.__officeFrameQuiet;if(!quiet||quiet.frame!==frame){window.__officeFrameQuiet={frame,at:now};return false;}return now-quiet.at>=500;});
 const frames=await page.locator('.office-canvas').getAttribute('data-frames');await page.waitForTimeout(200);assert.equal(await page.locator('.office-canvas').getAttribute('data-frames'),frames);
 await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'2D view',exact:true}).click();assert.equal(await page.locator('#agent-office').getAttribute('data-mode'),'2d');assert.equal(await page.locator('.office-desk-label[hidden]').count(),0);assert.equal(await page.getByRole('group',{name:'3D view controls',exact:true}).count(),0);await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'3D office',exact:true}).click();
 await page.locator('#bots-target').selectOption('mac');await page.locator('#bots-status').getByText('Your Mac is offline.',{exact:false}).waitFor();assert.equal(await page.locator('#agent-office').getAttribute('data-connected'),'false');await page.locator('#bots-target').selectOption('phone');await page.locator('#bots-member option').first().waitFor({state:'attached'});
 for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:844});await page.evaluate(()=>document.querySelector('#v-bots .scroll').scrollTop=0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Office fits ${width}`);assert.ok(await page.locator('#v-bots .scroll').evaluate(n=>n.scrollHeight<=n.clientHeight+1),'Office does not require scrolling');if(width===390||width===1280)await page.screenshot({path:`/tmp/echo-office-ui/phone-${width}.png`});}
 assert.deepEqual(errors,[]);console.log('PASS actual Phone bot run → lit working screen → exact task update queued/applied → output, stopped lighting, illustrated-office provenance, reduced motion, fallback, target isolation and responsive office.');await context.close();
}finally{release?.();await browser.close();server.closeAllConnections();server.close();}
