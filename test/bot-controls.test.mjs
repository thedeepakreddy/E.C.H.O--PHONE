import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBots,botState} from '../lib/bots.js';
const until=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');};
test('updates are isolated, deduplicated and acknowledged only at an agent boundary',async()=>{
 const states=new Map();let release,take;
 const engine=createBots({withState:async(d,f)=>{if(!states.has(d))states.set(d,botState());return f(states.get(d));},execute:async({takeUpdates})=>{take=takeUpdates;await new Promise(r=>release=r);return {reply:'Done'};}});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Read sources'});await until(()=>take);
 const command={id,botId:'research',attempt:1,operation:'update',text:'Use annual pricing',requestId:randomUUID()};
 await assert.rejects(engine.control('other',command),/no longer/);await assert.rejects(engine.control('owner',{...command,botId:'plan'}),/no longer/);
 assert.equal((await engine.control('owner',command)).command.status,'queued');assert.equal((await engine.control('owner',command)).repeated,true);
 await assert.rejects(engine.control('owner',{...command,text:'Different'}),/another instruction/);
 assert.deepEqual(await take(),['Use annual pricing']);assert.equal((await engine.list('owner')).jobs[0].commands[0].status,'applied');assert.deepEqual(await take(),[]);
 release();await until(()=>engine.activeCount()===0);await assert.rejects(engine.control('owner',{...command,requestId:randomUUID()}),/already ended/);
});
test('stopping a specific task fences queued updates and subsequent effects',async()=>{
 let release,ready=false,effects=0;const state=botState();
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async({ensure})=>{ready=true;await new Promise(r=>release=r);await ensure();effects++;return {};}});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'write',revision:1,goal:'Draft'});await until(()=>ready);
 await engine.control('owner',{id,botId:'write',attempt:1,operation:'update',text:'Keep it short',requestId:randomUUID()});
 const stop={id,botId:'write',attempt:1,operation:'stop',requestId:randomUUID()};await engine.control('owner',stop);assert.equal((await engine.control('owner',stop)).repeated,true);
 release();await until(()=>engine.activeCount()===0);assert.equal(effects,0);assert.equal(state.jobs[0].commands[0].status,'not-applied');
});
test('revise fences the old attempt, starts one linked follow-up, and uses a fresh run identity',async()=>{
 const state=botState(),calls=[];const releases=[];
 const engine=createBots({withState:async(_d,f)=>f(state),execute:async p=>{calls.push(p);await new Promise(r=>releases.push(r));await p.ensure();return {reply:'Revised result'};}});
 const id=randomUUID();await engine.run('owner',{requestId:id,botId:'research',revision:1,goal:'Research options'},{requestId:id});await until(()=>calls.length===1);
 const revision={id,botId:'research',attempt:1,operation:'revise',text:'Compare yearly prices',requestId:randomUUID()};const r=await engine.control('owner',revision);await until(()=>calls.length===2);
 assert.equal(r.newRunId,revision.requestId);assert.equal(calls[1].context.requestId,revision.requestId);assert.match(calls[1].goal,/Compare yearly prices/);assert.equal(state.jobs[0].status,'stopped');assert.equal((await engine.control('owner',revision)).newRunId,r.newRunId);assert.equal(calls.length,2);assert.equal(calls[0].signal.aborted,true);
 releases.forEach(r=>r());await until(()=>engine.activeCount()===0);assert.equal(state.jobs[0].result,undefined);assert.equal(state.jobs[1].result.reply,'Revised result');
});
