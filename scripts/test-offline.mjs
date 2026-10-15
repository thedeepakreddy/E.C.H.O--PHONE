import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const guard=fileURLToPath(new URL('./test-network-guard.mjs',import.meta.url));
export const offlineEnvironment=(env=process.env)=>({...env,NODE_OPTIONS:`${env.NODE_OPTIONS??''} --import ${JSON.stringify(guard)}`.trim()});
export const selectOffline=(files,filters=[])=>files.filter(name=>/^[^/\\]+\.test\.mjs$/.test(name)&&(!filters.length||filters.some(filter=>name.includes(filter)))).sort();
export function runnerOptions(args,defaultTimeout=120000){
 const filters=[];let list=false,timeoutMs=defaultTimeout;
 for(const arg of args){
  if(arg==='--list')list=true;
  else if(arg.startsWith('--timeout-ms='))timeoutMs=Number(arg.slice(13));
  else if(arg.startsWith('-'))throw Error(`Unsupported option ${arg}. Phone live/device acceptance is manual; use --list or a fixture filter.`);
  else filters.push(arg);
 }
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw Error('Timeout must be 1–600000 ms.');
 return {filters,list,timeoutMs};
}

/** Only this child's process group is terminated; output and runtime are bounded. */
export function runCommand(command,args,{cwd=ROOT,env=process.env,timeoutMs=120000,signal}={}){
 if(signal?.aborted)return Promise.resolve({code:1,out:'Test run cancelled',ms:0,cancelled:true});
 return new Promise(resolveRun=>{
  const started=Date.now(),child=spawn(command,args,{cwd,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let out='',failure='',settled=false,escalation,cancelled=false;
  const kill=value=>{if(!child.pid||settled)return;try{process.kill(process.platform==='win32'?child.pid:-child.pid,value);}catch(error){if(error.code!=='ESRCH')failure||=error.message;}};
  const cancel=reason=>{failure||=reason;kill('SIGTERM');escalation??=setTimeout(()=>kill('SIGKILL'),300);};
  const aborted=()=>{cancelled=true;cancel('Test run cancelled');};
  const signals=['SIGINT','SIGTERM','SIGHUP'];for(const name of signals)process.once(name,aborted);
  signal?.addEventListener('abort',aborted,{once:true});
  const timer=setTimeout(()=>cancel(`Test exceeded ${timeoutMs} ms`),timeoutMs);
  const append=text=>{out=(out+text).slice(-256000);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',append);child.stderr.on('data',append);
  child.on('error',error=>{failure=error.message;});
  child.on('exit',()=>kill('SIGKILL'));
  child.on('close',code=>{
   settled=true;clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener('abort',aborted);
   for(const name of signals)process.removeListener(name,aborted);
   resolveRun({code:failure?1:code??1,out:failure?`${out}\n${failure}`:out,ms:Date.now()-started,cancelled});
  });
 });
}

export async function offlineMain(args=process.argv.slice(2)){
 const options=runnerOptions(args),files=selectOffline(readdirSync(new URL('../test/',import.meta.url)),options.filters);
 if(!files.length)throw Error('No offline tests match the requested filters.');
 if(options.list){console.log(files.map(name=>`test/${name}`).join('\n'));return 0;}
 const result=await runCommand(process.execPath,['--test',...files.map(name=>`test/${name}`)],{env:offlineEnvironment(),timeoutMs:options.timeoutMs});
 process.stdout.write(result.out);return result.code;
}
export const isMain=url=>Boolean(process.argv[1])&&resolve(process.argv[1])===fileURLToPath(url);
if(isMain(import.meta.url))offlineMain().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
