import assert from 'node:assert/strict';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createRelay} from '../server.js';
const pw=process.env.ECHO_BROWSER_DEPENDENCIES?await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES,'playwright/index.mjs')).href):await import('playwright');
let release,turn=0;
const gemini={model:'fixture',embed:async()=>Array(512).fill(0),generate:async body=>{turn++;if(turn===1){await new Promise(r=>release=r);return {candidates:[{content:{role:'model',parts:[{functionCall:{name:'get_today',args:{}}}]}}]};}return {candidates:[{content:{role:'model',parts:[{text:JSON.stringify(body.contents)}]}}]};}};
const relay=createRelay({secret:'isolated-office-ui-fixture-'.repeat(4),gemini,fetchJson:async()=>({})}),server=http.createServer(relay.handler);
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;await mkdir('/tmp/echo-office-ui',{recursive:true});
const browser=await pw.chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const refresh=async()=>{await page.locator('.office-workspace-menu summary').click();await page.locator('.office-workspace-menu').getByRole('button',{name:'Refresh',exact:true}).click();};
 await page.goto(url);await page.locator('#get-started').click();await page.locator('[data-tab="bots"]').click();await page.locator('#bots-member option').first().waitFor({state:'attached'});
 await page.getByRole('button',{name:'Assign task',exact:true}).click();await page.locator('#bots-member').selectOption('research');await page.locator('#bots-goal').fill('Compare options');await page.locator('#bots-run button[type=submit]').click();await page.locator('.office-roster-agent[data-agent=research]').click();await page.locator('#agent-office').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>Number(document.querySelector('.office-canvas').dataset.workingScreens)===1);assert.equal(await page.locator('#bots-assignment').evaluate(d=>d.open),false);assert.equal(await page.locator('.office-inspector h3').innerText(),'Research');assert.ok(await page.locator('.office-canvas').evaluate(c=>Number(c.dataset.faceLightIntensity)>0));
 await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'Pause motion',exact:true}).click();
 await page.evaluate(()=>document.querySelector('#v-bots .scroll').scrollTop=0);await page.screenshot({path:'/tmp/echo-office-ui/phone-working.png'});
 const nav=await page.locator('#tabbar').boundingBox(),buttons=await page.locator('.office-action-buttons').boundingBox();assert.ok(buttons.y+buttons.height<=nav.y,'Update and revise fit above phone navigation');
 await page.locator('.office-echo-tile').click();await refresh();assert.equal(await page.locator('.office-inspector h3').innerText(),'Echo');await page.locator('.office-agent-select').selectOption('research');
 await page.locator('.office-update-input').fill('Use yearly pricing');await refresh();assert.equal(await page.locator('.office-update-input').inputValue(),'Use yearly pricing');
 const update=page.waitForResponse(r=>r.url().endsWith('/cloud/bots')&&r.request().postDataJSON()?.action==='control');await page.getByRole('button',{name:'Send update',exact:true}).click();const accepted=await(await update).json();assert.equal(accepted.command.status,'queued');release();
 await refresh();await page.waitForFunction(()=>document.querySelector('.office-command')?.textContent.includes('Applied'));assert.match(await page.locator('.office-output').innerText(),/Use yearly pricing/);
 await page.locator('#agent-office').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.office-canvas').dataset.workingScreens==='0');
 await page.getByRole('button',{name:'Follow up',exact:true}).first().click();assert.equal(await page.locator('#bots-assignment').evaluate(d=>d.open),true);await page.locator('#bots-goal').fill('Explain the verified options');await page.locator('#bots-run button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.office-goal')?.textContent==='Explain the verified options');
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);const frames=await page.locator('.office-canvas').getAttribute('data-frames');await page.waitForTimeout(200);assert.equal(await page.locator('.office-canvas').getAttribute('data-frames'),frames);
 await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'2D view',exact:true}).click();assert.equal(await page.locator('#agent-office').getAttribute('data-mode'),'2d');assert.equal(await page.locator('.office-desk-label[hidden]').count(),0);await page.locator('.office-workspace-menu summary').click();await page.getByRole('button',{name:'Office view',exact:true}).click();
 await page.locator('#bots-target').selectOption('mac');await page.locator('#bots-status').getByText('Your Mac is offline.',{exact:false}).waitFor();assert.equal(await page.locator('#agent-office').getAttribute('data-connected'),'false');await page.locator('#bots-target').selectOption('phone');await page.locator('#bots-member option').first().waitFor({state:'attached'});
 for(const width of [320,390,430,1280]){await page.setViewportSize({width,height:844});await page.evaluate(()=>document.querySelector('#v-bots .scroll').scrollTop=0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Office fits ${width}`);if(width===390||width===1280)await page.screenshot({path:`/tmp/echo-office-ui/phone-${width}.png`});}
 assert.deepEqual(errors,[]);console.log('PASS actual Phone bot run → lit working screen → exact task update queued/applied → output, stopped lighting, illustrated-office provenance, reduced motion, fallback, target isolation and responsive office.');await context.close();
}finally{release?.();await browser.close();server.closeAllConnections();server.close();}
