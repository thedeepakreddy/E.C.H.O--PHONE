import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('mouse and keyboard show the actual busy reason without repeated-toast spam',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const match=source.match(/function reportMacInputError\(err\) \{[\s\S]*?\n  \}/);
 assert.ok(match,'The human controls have a shared error reporter');
 let time=0;const messages=[];
 const reporter=vm.runInNewContext(`(${match[0]})`,{performance:{now:()=>time},lastMacInputErrorAt:-Infinity,lastMacInputErrorMessage:'',toast:(message,error)=>messages.push({message,error})});
 reporter(new Error('Echo owns the desktop. Stop Echo before using Phone controls.'));
 time=100;reporter(new Error('Echo owns the desktop. Stop Echo before using Phone controls.'));
 assert.equal(messages.length,1);assert.match(messages[0].message,/Stop Echo/);assert.equal(messages[0].error,true);
 reporter(new Error('Mac is offline'));assert.equal(messages.length,2,'A different problem is not hidden');
 time=2000;reporter(new Error('Mac is offline'));assert.equal(messages.length,3);
 assert.match(source,/const mouse = [^\n]*\.catch\(reportMacInputError\)/);
 assert.match(source,/api\("\/keys", \{ json: \{ key: b\.dataset\.key \} \}\)\.catch\(reportMacInputError\)/);
});
