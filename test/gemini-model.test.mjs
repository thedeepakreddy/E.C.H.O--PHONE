import test from 'node:test';
import assert from 'node:assert/strict';
import {createGemini} from '../lib/gemini.js';
import {createCloud} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

function fixture(options={}) {
 const requests=[];
 const gemini=createGemini({apiKey:'fixture-not-a-key',...options,fetchImpl:async(url,init)=>{
  requests.push({url,body:JSON.parse(init.body)});
  return Response.json({candidates:[{content:{role:'model',parts:[{text:'Fixture answer.'}]}}]});
 }});
 return {gemini,requests};
}

test('Phone defaults to stable Gemini 3.8 Flash with low thinking for responsive tool loops',async()=>{
 const {gemini,requests}=fixture();
 assert.equal(gemini.model,'gemini-3.8-flash');
 const body={contents:[{role:'user',parts:[{text:'Hello'}]}],generationConfig:{maxOutputTokens:1200}};
 await gemini.generate(body);
 assert.match(requests[0].url,/\/models\/gemini-3\.8-flash:generateContent$/);
 assert.deepEqual(requests[0].body.generationConfig,{maxOutputTokens:1200,thinkingConfig:{thinkingLevel:'low'}});
 assert.deepEqual(body.generationConfig,{maxOutputTokens:1200},'request defaults do not mutate caller state');
});

test('explicit model and per-request overrides remain authoritative and receive compatible settings',async()=>{
 const {gemini,requests}=fixture({model:'gemini-3.5-flash-lite'});
 assert.equal(gemini.model,'gemini-3.5-flash-lite');
 await gemini.generate({contents:[]});
 assert.match(requests[0].url,/\/models\/gemini-3\.5-flash-lite:generateContent$/);
 assert.equal(requests[0].body.generationConfig,undefined);
 await gemini.generate({contents:[],generationConfig:{thinkingConfig:{thinkingLevel:'high'}}},{modelId:'gemini-3.8-flash'});
 assert.match(requests[1].url,/\/models\/gemini-3\.8-flash:generateContent$/);
 assert.equal(requests[1].body.generationConfig.thinkingConfig.thinkingLevel,'high');
});

test('ordinary Phone chat and all six Office specialists use the upgraded default client',async()=>{
 const {gemini,requests}=fixture();
 const cloud=createCloud({gemini,store:createStore({key:Buffer.alloc(32)}),tools:{}});
 await cloud.chat({text:'Hello'});
 for(const id of ['research','plan','write','review','analyse','echo-assistant'])
  await cloud.chat({text:'Complete fixture task',bot:{id,name:id,role:'Fixture role',mode:'research',runId:`fixture-${id}`,model:'must-not-override'}});
 assert.equal(requests.length,7);
 assert.ok(requests.every(r=>r.url.endsWith('/models/gemini-3.8-flash:generateContent')));
 assert.ok(requests.every(r=>r.body.generationConfig.thinkingConfig.thinkingLevel==='low'));
});
