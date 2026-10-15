import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {offlineEnvironment,runCommand,runnerOptions,selectOffline} from '../scripts/test-offline.mjs';

const scripts=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).scripts;
test('default, offline and CI scripts use the guarded Phone runner and preserve existing names',()=>{
 for(const name of ['test','test:offline','ci:offline'])assert.equal(scripts[name],'node scripts/test-offline.mjs');
 assert.equal(scripts['test:ui'],'node scripts/test-ui.mjs');
 for(const name of ['bots','office','retry','markdown','reportretry','trackpad','cloudrecovery'])assert.equal(typeof scripts[`test:ui:${name}`],'string');
 assert.equal(scripts.start,'node server.js');
 assert.equal(scripts['test:live'],undefined);assert.equal(scripts['test:device'],undefined);
});

test('UI selection is an explicit browser-fixture allowlist, never live or physical-device acceptance',async()=>{
 const {UI_TESTS,selectUI}=await import('../scripts/test-ui.mjs');
 const names=['bots','office','retry','reportretry','trackpad','markdown','cloudrecovery'].map(name=>`test:ui:${name}`);
 const mixed={...scripts,'test:ui:iphone':'native phone','test:ui:mac':'native Mac','test:live':'provider','test:device':'physical device'};
 assert.deepEqual(selectUI(mixed),names);
 assert.deepEqual(selectUI(mixed,['retry']),['test:ui:retry','test:ui:reportretry']);
 for(const name of names)assert.equal(scripts[name],`node ${UI_TESTS[name]}`);
 assert.deepEqual(selectUI({...scripts,'test:ui:bots':'node physical-device.mjs'},['bots']),[]);
});
test('UI registry drift fails loudly instead of silently losing fixture coverage',async()=>{
 const {validateUI}=await import('../scripts/test-ui.mjs');
 assert.equal(typeof validateUI,'function');
 assert.doesNotThrow(()=>validateUI(scripts));
 assert.throws(()=>validateUI({...scripts,'test:ui:bots':'node other.mjs'}),/UI fixture command changed/);
 assert.throws(()=>validateUI({...scripts,'test:ui:unclassified':'node hidden.mjs'}),/Unclassified UI fixture/);
});

test('offline discovery selects only existing test-file shapes and supports bounded strict options',()=>{
 assert.deepEqual(selectOffline(['phone.test.mjs','bots-ui-test.mjs','package.json','../escape.test.mjs','nested/device.test.mjs','voice.test.mjs']),['phone.test.mjs','voice.test.mjs']);
 assert.deepEqual(selectOffline(['voice.test.mjs','phone.test.mjs'],['phone']),['phone.test.mjs']);
 assert.deepEqual(runnerOptions(['--list','--timeout-ms=25','office']),{list:true,timeoutMs:25,filters:['office']});
 for(const option of ['--live','--device','--unknown','--timeout-ms=NaN','--timeout-ms=0','--timeout-ms=600001'])assert.throws(()=>runnerOptions([option]));
});

test('both CLIs list and filter without launching tests, and fail on zero matches',async()=>{
 for(const [script,filter,expected] of [['test-offline.mjs','verification-groups','test/verification-groups.test.mjs'],['test-ui.mjs','office','test:ui:office']]){
  const path=fileURLToPath(new URL(`../scripts/${script}`,import.meta.url));
  const listed=await runCommand(process.execPath,[path,'--list',filter]);
  assert.equal(listed.code,0,listed.out);assert.match(listed.out,new RegExp(expected.replaceAll('.','\\.')));
  assert.doesNotMatch(listed.out,/Running |tests [0-9]|fixtures passed/);
  const absent=await runCommand(process.execPath,[path,'--list','no-such-phone-fixture']);
  assert.notEqual(absent.code,0);assert.match(absent.out,/No .* match/);assert.doesNotMatch(absent.out,/0\/0/);
 }
});

test('the copied guard blocks remote fetch, Request, HTTP and HTTPS before access, including inherited grandchildren',async()=>{
 const code=`
  const assert=require('node:assert/strict');
  (async()=>{
   await assert.rejects(fetch('https://provider.invalid/api'),/blocked remote/);
   await assert.rejects(fetch(new Request('https://provider.invalid/api')),/blocked remote/);
   for(const name of ['node:http','node:https']){
    const http=require(name),url=name.endsWith('https')?'https://provider.invalid':'http://provider.invalid';
    assert.throws(()=>http.get(url),/blocked remote/);
    assert.throws(()=>http.request({hostname:'provider.invalid'}),/blocked remote/);
    assert.throws(()=>http.request('http://localhost',{hostname:'provider.invalid'}),/blocked remote/);
   }
   const {get}=await import('node:https');assert.throws(()=>get('https://provider.invalid'),/blocked remote/);
   const nested=require('node:child_process').spawnSync(process.execPath,['-e',"fetch('https://provider.invalid').then(()=>process.exit(9),e=>{if(!/blocked remote/.test(e.message))process.exit(8)})"],{encoding:'utf8'});
   assert.equal(nested.status,0,nested.stderr);console.log('guard inherited and verified');
  })().catch(error=>{console.error(error);process.exitCode=1});`;
 const env=offlineEnvironment({...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --no-warnings`});
 assert.match(env.NODE_OPTIONS,/--no-warnings/);assert.match(env.NODE_OPTIONS,/test-network-guard/);
 const result=await runCommand(process.execPath,['-e',code],{env});
 assert.equal(result.code,0,result.out);assert.match(result.out,/guard inherited and verified/);
});

test('guard prevents automatic local-to-remote redirects while preserving manual local fixtures',async()=>{
 const guard=new URL('../scripts/test-network-guard.mjs?redirect-fixture',import.meta.url).href;
 const code=`import assert from 'node:assert/strict';const policies=[];
  globalThis.fetch=async(_input,options)=>{policies.push(options.redirect);return new Response(null,{status:302,headers:{location:'https://provider.invalid'}});};
  await import(${JSON.stringify(guard)});
  await fetch('http://localhost/redirect');await fetch('http://localhost/redirect',{redirect:'manual'});
  await fetch(new Request('http://localhost/redirect',{redirect:'follow'}));
  assert.deepEqual(policies,['error','manual','error']);
  await assert.rejects(fetch('https://provider.invalid'),/blocked remote/);assert.equal(policies.length,3);`;
 const result=await runCommand(process.execPath,['--input-type=module','-e',code]);
 assert.equal(result.code,0,result.out);
});

test('owned commands retain output, nonzero exit codes and spawn errors',async()=>{
 const good=await runCommand(process.execPath,['-e','process.stdout.write("out");process.stderr.write("err")']);
 assert.equal(good.code,0);assert.match(good.out,/out/);assert.match(good.out,/err/);
 assert.equal((await runCommand(process.execPath,['-e','process.exit(7)'])).code,7);
 const absent=await runCommand('/no-such-phone-fixture',[]);assert.equal(absent.code,1);assert.match(absent.out,/ENOENT/);
});

test('deadline failure terminates an owned child even when it ignores SIGTERM',async()=>{
 const result=await runCommand(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{timeoutMs:100});
 assert.equal(result.code,1);assert.match(result.out,/exceeded 100 ms/);assert(result.ms<3000);
});

test('the actual offline CLI propagates its child deadline failure',async()=>{
 const path=fileURLToPath(new URL('../scripts/test-offline.mjs',import.meta.url));
 const result=await runCommand(process.execPath,[path,'--timeout-ms=1','phone-command-reliability'],{timeoutMs:3000});
 assert.equal(result.code,1);assert.match(result.out,/exceeded 1 ms/);
});

test('output budgets keep the tail and descendants cannot retain pipes after parent exit',async()=>{
 const large=await runCommand(process.execPath,['-e','process.stdout.write("x".repeat(1000000)+"TAIL")']);
 assert.equal(large.code,0);assert(large.out.length<=256000);assert(large.out.endsWith('TAIL'));
 const descendant=await runCommand(process.execPath,['-e','require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});process.exit(0)'],{timeoutMs:2000});
 assert.equal(descendant.code,0,descendant.out);assert(descendant.ms<1500);
});

test('cancellation does not launch pre-cancelled work and terminates an owned active child',async()=>{
 const controller=new AbortController();
 const pending=runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
 setTimeout(()=>controller.abort(),30);
 const cancelled=await pending;assert.equal(cancelled.code,1);assert.equal(cancelled.cancelled,true);
 assert.equal((await runCommand('/must-not-launch',[],{signal:controller.signal})).ms,0);
});

test('UI aggregate propagates real inert child exits and deadlines without launching browsers',async()=>{
 const {uiMain}=await import('../scripts/test-ui.mjs');
 for(const [fixture,timeoutMs,code] of [['office',500,'process.exit(7)'],['trackpad',50,'setInterval(()=>{},1000)']]){
  let calls=0;
  const result=await uiMain([fixture,`--timeout-ms=${timeoutMs}`],async(command,args,options)=>{
   calls++;assert.equal(command,process.execPath);assert.equal(args.length,1);assert.match(options.env.NODE_OPTIONS,/test-network-guard/);
   assert.equal(options.timeoutMs,timeoutMs);return runCommand(command,['-e',code],options);
  });
  assert.equal(result,1);assert.equal(calls,1);
 }
 let calls=0;assert.equal(await uiMain(['retry'],async()=>{calls++;return {code:1,out:'Inert cancellation fixture\n',cancelled:true};}),1);
 assert.equal(calls,1,'Cancellation cannot launch the next browser fixture');
});
