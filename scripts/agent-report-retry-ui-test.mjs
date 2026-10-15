// Integration regression: the final-report Retry UI already exists. No RED claim.
import assert from 'node:assert/strict';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createRelay} from '../server.js';

const pw=process.env.ECHO_BROWSER_DEPENDENCIES
  ?await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES,'playwright/index.mjs')).href)
  :await import('playwright');
const roles=['research','analyse','plan','write','review','verify'];
const names=['Research','Analyse','Plan','Write','Review','Verify'];
const at='2026-10-14T12:00:00.000Z',missionId='fixture-final-report-mission',attempt=3;
const specialists=roles.map((id,index)=>({id,profile:id,name:names[index],status:'completed',attempt:2,
  goal:`Saved ${id} report`,commands:[],dependsOn:[],
  result:{status:'completed',summary:`Verified ${id} findings`,artifacts:[{kind:'text',label:`${names[index]} report`,value:`Original saved ${id} evidence`}],verificationRefs:[`fixture:${id}`],blockers:[]}}));
const initial={durable:true,bots:[{id:'team',name:'Echo team',team:true,role:'Six specialists and a final compiler',revision:1,defaultAgentIds:roles},
  ...roles.map((id,index)=>({id,name:names[index],role:`${names[index]} specialist`,mode:'assist',revision:1}))],
  jobs:[{id:missionId,botId:'team',botName:'Echo team',goal:'Compile the saved specialist reports',status:'failed',live:false,updatedAt:at,
    reportRetry:{taskId:'lead',attempt},steps:[...specialists,{id:'lead',profile:'lead',name:'Echo',coordinator:true,status:'failed',attempt,
      goal:'Combine completed reports',commands:[],dependsOn:roles,error:'Fixture compiler connection failure'}],
    result:{status:'failed',summary:'Final report compiler failed',artifacts:[],verificationRefs:[],blockers:['Fixture compiler connection failure']}}]};
let providerCalls=0;
const noProvider=async()=>{providerCalls++;throw Error('This UI fixture must never call a model provider');};
const relay=createRelay({secret:'isolated-report-retry-ui-fixture-'.repeat(4),
  gemini:{model:'inert-ui-fixture',embed:noProvider,generate:noProvider},fetchJson:async()=>({}),
  pushFetch:async()=>{throw Error('This fixture must never send a push');}});
const server=http.createServer(relay.handler),engine=process.env.ECHO_OFFICE_BROWSER||'chromium';
let browser;
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await pw[engine].launch({headless:true,...(engine==='webkit'&&process.env.ECHO_WEBKIT_EXECUTABLE?{executablePath:process.env.ECHO_WEBKIT_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const externalRequests=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===origin)return route.continue();
    externalRequests.push(route.request().url());return route.abort('blockedbyclient');
  });
  await context.addInitScript(({initial,missionId,attempt})=>{
    const committed=structuredClone(initial),requests=[];
    let initializer,published=false,commits=0,initializations=0,statusReads=0;
    window.__reportRetryFixture={requests,get committed(){return structuredClone(committed);},
      get commits(){return commits;},get initializations(){return initializations;},get statusReads(){return statusReads;}};
    Object.defineProperty(window,'initEchoBots',{configurable:true,
      get(){return initializer;},
      set(realInitializer){initializer=options=>{
        initializations++;
        return realInitializer({...options,macReady:()=>true,api:async(path,request)=>{
          if(path==='/status'){
            statusReads++;
            // A lost acknowledgement can coincide with stale cached status.
            return {bots:structuredClone(published?committed:initial)};
          }
          if(path!=='/action')throw Error(`Unexpected fixture API path: ${path}`);
          const body=structuredClone(request?.json);requests.push(body);
          const expected={type:'control-bot',missionId,taskId:'lead',attempt,operation:'retry',requestId:body?.requestId};
          if(!body||JSON.stringify(Object.keys(body).sort())!==JSON.stringify(Object.keys(expected).sort())
            ||Object.entries(expected).some(([key,value])=>body[key]!==value)
            ||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))throw Error('Unexpected final-report control request');
          if(commits===0){
            const job=committed.jobs[0];job.status='running';job.live=true;job.updatedAt='2026-10-14T12:00:01.000Z';
            Object.assign(job.steps.find(step=>step.id==='lead'),{status:'working',attempt:attempt+1});
            delete job.reportRetry;commits++;
            throw Error('Fixture lost acknowledgment after compiler-only commit');
          }
          if(JSON.stringify(body)!==JSON.stringify(requests[0]))throw Error('Lost-reply retry changed the command identity');
          published=true;return {ok:true,message:'Final report retry accepted.'};
        }});
      };},
    });
  },{initial,missionId,attempt});
  const page=await context.newPage(),pageErrors=[];
  page.setDefaultTimeout(30000);page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin);
  await page.locator('#get-started').click();
  await page.locator('[data-tab="bots"]').click();
  await page.locator('#bots-member option').first().waitFor({state:'attached'});
  await page.locator('#bots-target').selectOption('mac');
  await page.waitForFunction(()=>document.querySelector('#agent-office')?.dataset.connected==='true'
    &&document.querySelector('.office-run-select')?.value==='fixture-final-report-mission');
  assert.equal(await page.locator('#bots-target').inputValue(),'mac');
  assert.equal(await page.locator('.office-inspector').isVisible(),false);
  assert.equal(await page.locator('.office-desk-label[data-agent="lead"]').count(),0,'Compiler is not a visible specialist desk');
  assert.deepEqual(await page.locator('.office-desk-label').evaluateAll(nodes=>nodes.map(node=>node.dataset.agent).sort()),[...roles].sort());
  assert.equal(await page.locator('.office-desk-label[data-agent="verify"]').isVisible(),true);
  assert.equal(await page.locator('.office-desk-label[data-state="completed"]').count(),6);

  const menu=page.locator('.office-workspace-menu'),retry=menu.getByRole('button',{name:'Retry final report',exact:true,includeHidden:true});
  await menu.locator('summary').click();await retry.waitFor();
  const style=await retry.evaluate(button=>{
    const own=getComputedStyle(button),glass=getComputedStyle(button.parentElement);
    return {tag:button.tagName,height:button.getBoundingClientRect().height,glass:button.classList.contains('glass'),
      pill:button.classList.contains('pill'),parentGlass:button.parentElement.classList.contains('glass'),fontSize:parseFloat(own.fontSize),
      backdrop:glass.backdropFilter||glass.webkitBackdropFilter,background:glass.backgroundColor,clipped:button.scrollWidth>button.clientWidth};
  });
  assert.equal(style.tag,'BUTTON');assert.equal(style.height,44);assert(style.glass&&style.pill&&style.parentGlass,'Retry uses Phone-native glass capsules');
  assert.match(style.backdrop,/blur\(/);assert.notEqual(style.background,'rgba(0, 0, 0, 0)');assert(style.fontSize>=13&&!style.clipped);
  assert.equal(await retry.isEnabled(),true);
  await retry.click();
  await page.waitForFunction(()=>window.__reportRetryFixture.requests.length===1
    &&document.querySelector('.office-scene-status')?.textContent.includes('Fixture lost acknowledgment'));
  const lost=await page.evaluate(()=>({requests:window.__reportRetryFixture.requests,committed:window.__reportRetryFixture.committed,commits:window.__reportRetryFixture.commits}));
  assert.equal(lost.commits,1);assert.equal(lost.committed.jobs[0].steps.find(step=>step.id==='lead').attempt,attempt+1);
  assert.deepEqual(lost.committed.jobs[0].steps.filter(step=>step.id!=='lead'),specialists,'First accepted command preserves all completed specialists');
  await menu.locator('summary').click();await retry.waitFor();assert.equal(await retry.isEnabled(),true);
  await retry.click();
  await page.waitForFunction(()=>window.__reportRetryFixture.requests.length===2
    &&document.querySelector('.office-scene-status')?.textContent==='Final report retry accepted.');
  // Open the menu: hidden must be the actual button state, not a closed details menu.
  await menu.locator('summary').click();
  assert.equal(await retry.isVisible(),false);assert.equal(await retry.evaluate(button=>button.hidden),true);
  const final=await page.evaluate(()=>({requests:window.__reportRetryFixture.requests,committed:window.__reportRetryFixture.committed,
    commits:window.__reportRetryFixture.commits,initializations:window.__reportRetryFixture.initializations,statusReads:window.__reportRetryFixture.statusReads}));
  const requestId=final.requests[0].requestId;
  assert.match(requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const expected={type:'control-bot',missionId,taskId:'lead',attempt,operation:'retry',requestId};
  assert.deepEqual(final.requests,[expected,expected],'Lost reply retries the exact mission/task/attempt and UUID, without instructions');
  assert.equal(final.commits,1);assert.equal(final.initializations,1);assert(final.statusReads>=3);
  assert.deepEqual(final.committed.jobs[0].steps.filter(step=>step.id!=='lead'),specialists);
  assert.equal(final.committed.jobs[0].steps.find(step=>step.id==='lead').status,'working');
  assert.equal(final.committed.jobs[0].reportRetry,undefined);
  assert.equal(await page.locator('.office-desk-label[data-state="completed"]').count(),6);
  assert.equal(await page.locator('.office-desk-label[data-agent="lead"]').count(),0);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);assert.equal(providerCalls,0);
  console.log(`PASS ${engine}: Phone→Mac final-report Retry integration, native 44px glass, six completed roles including Verify, no compiler desk, exact control-bot identity, lost-reply UUID reuse, compiler-only commit and accepted-button hiding; no provider calls or page errors`);
  await context.close();
}finally{
  await browser?.close();server.closeAllConnections();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
}
