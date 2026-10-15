import {readFileSync} from 'node:fs';
import {isMain,offlineEnvironment,runCommand,runnerOptions} from './test-offline.mjs';

// These launch disposable browsers against injected local relay fixtures only.
export const UI_TESTS={
 'test:ui:bots':'scripts/bots-ui-test.mjs',
 'test:ui:office':'scripts/agent-office-ui-test.mjs',
 'test:ui:retry':'scripts/agent-retry-ui-test.mjs',
 'test:ui:reportretry':'scripts/agent-report-retry-ui-test.mjs',
 'test:ui:trackpad':'scripts/trackpad-cancel-ui-test.mjs',
 'test:ui:markdown':'scripts/markdown-ui-test.mjs',
};
export const selectUI=(scripts,filters=[])=>Object.keys(UI_TESTS).filter(name=>scripts[name]===`node ${UI_TESTS[name]}`&&(!filters.length||filters.some(filter=>name.includes(filter))));
export function validateUI(scripts){
 for(const [name,file] of Object.entries(UI_TESTS))if(scripts[name]!==`node ${file}`)throw Error(`UI fixture command changed: ${name}. Review its verification boundary before running.`);
 for(const name of Object.keys(scripts))if(name.startsWith('test:ui:')&&!(name in UI_TESTS))throw Error(`Unclassified UI fixture: ${name}. Declare its isolated fixture boundary first.`);
}

export async function uiMain(args=process.argv.slice(2),execute=runCommand){
 const options=runnerOptions(args,180000),scripts=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).scripts;
 validateUI(scripts);
 const names=selectUI(scripts,options.filters);
 if(!names.length)throw Error('No UI fixtures match the requested filters.');
 if(options.list){console.log(names.map(name=>`${name} — ${UI_TESTS[name]}`).join('\n'));return 0;}
 let passed=0;
 for(const name of names){
  console.log(`Running ${name} (isolated browser fixture)`);
  const result=await execute(process.execPath,[UI_TESTS[name]],{env:offlineEnvironment(),timeoutMs:options.timeoutMs});
  process.stdout.write(result.out+(result.out&&!result.out.endsWith('\n')?'\n':''));
  if(result.code===0)passed++;else console.error(`${name} failed (exit ${result.code}).`);
  if(result.cancelled)break;
 }
 console.log(`${passed}/${names.length} UI fixtures passed`);return passed===names.length?0:1;
}
if(isMain(import.meta.url))uiMain().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
