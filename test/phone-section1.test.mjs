import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBots, botState} from '../lib/bots.js';
import {createCloud} from '../lib/cloud.js';
import {createStore} from '../lib/store.js';

// These fixtures must never fall through to a real provider or remote storage.
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
before(() => { globalThis.fetch = async () => { networkAttempts++; throw Error('Network forbidden in Phone section1 fixtures'); }; });
after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0, 'Fixtures made no network attempts'); });
const response = parts => ({candidates: [{content: {role: 'model', parts}}]});
const call = (id, name, args = {}) => ({functionCall: {id, name, args}});
const cloudWith = generate => createCloud({
  store: createStore({key: Buffer.alloc(32)}), tools: {}, gemini: {model: 'fixture', generate},
});
const bot = {id: 'echo-assistant', name: 'Assistant', mode: 'assist', role: 'Help with daily work', runId: 'fixture'};
const until = async predicate => {
  for(let i = 0; i < 300; i++) { if(await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Phone fixture did not settle');
};
function engineWith(cloud, memory, initialState = botState(), beforeSave = async () => {}) {
  let state = initialState, tail = Promise.resolve();
  return createBots({
    withState(_device, fn, {save = true} = {}) {
      const run = tail.then(async () => {
        const copy = structuredClone(state), result = await fn(copy);
        if(typeof save === 'function' ? save() : save) { await beforeSave(copy); state = copy; }
        return structuredClone(result);
      });
      tail = run.catch(() => {}); return run;
    },
    execute: p => cloud.chat({...p, text: p.goal, bot: {...p.bot, runId: p.context.requestId}, memory}),
  });
}

test('ask_person pauses before subsequent effects and model rounds, retaining an honest pending checkpoint', async () => {
  let writes = 0, requests = 0, checkpoint;
  const cloud = cloudWith(async () => ++requests === 1 ? response([
    call('question', 'ask_person', {question: 'Which date should I save?'}),
    call('unanswered-save', 'save_memory', {text: 'Guessed date'}),
  ]) : response([{text: 'Pretended completion'}]));
  const memory = {save: async () => { writes++; return {id: 'bad-note', title: 'Guessed', dates: []}; }};
  const result = await cloud.chat({text: 'Save the appointment date', bot, memory,
    onCheckpoint: async value => { checkpoint = structuredClone(value); },
  });
  assert.equal(writes, 0, 'No effect is allowed after the question');
  assert.equal(requests, 1, 'No model round is allowed before an answer');
  assert.equal(result.question, 'Which date should I save?');
  assert.equal(result.reply, result.question);
  assert.equal(checkpoint.inFlight, null);
  assert.equal(checkpoint.pending.index, 1);
  assert.equal(checkpoint.pending.responses[0].functionResponse.name, 'ask_person');
  assert.equal(checkpoint.pending.responses[0].functionResponse.response.status, 'waiting');
  const stillWaiting = await cloud.chat({text: 'Save the appointment date', bot, memory, checkpoint});
  assert.equal(stillWaiting.question, result.question);
  assert.equal(writes, 0);
  assert.equal(requests, 1, 'Reloading a waiting checkpoint does not answer the question');
});

test('an answer survives a failed checkpoint commit and Retry without losing the waiting tool group', async () => {
  const requests = []; let failAnswerCommit = false;
  const engine = engineWith(cloudWith(async body => {
    requests.push(structuredClone(body));
    return response(requests.length === 1 ? [call('question', 'ask_person', {question: 'Which date?'})] : [{text: 'Confirmed October 20.'}]);
  }), {}, botState(), async value => {
    if(failAnswerCommit && value.jobs.at(-1)?.checkpoint?.contents.some(c => c.parts.some(p => p.text?.startsWith('User answer to the saved question')))) {
      failAnswerCommit = false; throw Error('Fixture checkpoint store unavailable');
    }
  });
  const id = randomUUID();
  await engine.run('owner', {requestId: id, botId: 'research', revision: 1, goal: 'Plan an appointment'}, {requestId: id});
  await until(() => engine.activeCount() === 0);
  assert.equal((await engine.list('owner')).jobs[0].status, 'needs-you');
  failAnswerCommit = true;
  const answerId = randomUUID();
  await engine.run('owner', {requestId: answerId, parentId: id, botId: 'research', revision: 1, goal: 'October 20'}, {requestId: answerId});
  await until(() => engine.activeCount() === 0);
  assert.equal((await engine.list('owner')).jobs[0].status, 'failed');
  assert.equal(requests.length, 1, 'Persistence must precede any continuation provider request');
  await engine.control('owner', {id: answerId, botId: 'research', attempt: 1, operation: 'retry', requestId: randomUUID()});
  await until(() => engine.activeCount() === 0);
  const completed = (await engine.list('owner')).jobs[0];
  assert.equal(completed.status, 'done');
  assert.equal(completed.result.question, null);
  const parts = requests[1].contents.flatMap(c => c.parts);
  assert.equal(parts.filter(p => p.text?.startsWith('User answer to the saved question')).length, 1);
  assert.ok(parts.some(p => p.text?.includes('Which date?') && p.text.includes('October 20')));
  assert.equal(parts.find(p => p.functionResponse?.id === 'question').functionResponse.response.status, 'waiting');
});

test('revisions reject changed bot roles or grants before stopping the active task', async () => {
  for(const change of ['revision', 'grants']) {
    const initial = botState(), id = randomUUID(), configured = initial.bots.find(b => b.id === 'echo-assistant');
    const previous = structuredClone(configured);
    if(change === 'revision') configured.revision++; else previous.mode = 'research';
    initial.jobs.push({id, botId: configured.id, botRevision: 1, botConfig: previous, goal: 'Saved task', attempt: 1,
      status: 'running', worker: 'previous-fixture', leaseUntil: Date.now() + 60000, commands: [], events: [],
    });
    const engine = engineWith(cloudWith(async () => { throw Error('No provider request should start'); }), {}, initial);
    await assert.rejects(engine.control('owner', {id, botId: configured.id, attempt: 1, operation: 'revise',
      text: 'Make it shorter', requestId: randomUUID(),
    }), /revision or tool grants changed/);
    const jobs = (await engine.list('owner')).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'running');
    assert.deepEqual(jobs[0].commands, []);
  }
});

test('Interrupt & revise rejects an in-flight write before stopping the parent or creating a child', async t => {
  let releaseWrite, writing = false, writes = 0, requests = 0;
  const engine = engineWith(cloudWith(async () => ++requests === 1
    ? response([call('uncertain-write', 'save_memory', {text: 'Write once'})])
    : response([{text: 'Saved once'}])), {
    save: async () => { writes++; writing = true; await new Promise(resolve => { releaseWrite = resolve; }); return {id: 'note-1', title: 'Write once', dates: []}; },
  });
  const id = randomUUID();
  t.after(async () => { releaseWrite?.(); await engine.stop('owner', id); await until(() => engine.activeCount() === 0); });
  await engine.run('owner', {requestId: id, botId: 'echo-assistant', revision: 1, goal: 'Remember this'}, {requestId: id});
  await until(() => writing);
  await assert.rejects(engine.control('owner', {
    id, botId: 'echo-assistant', attempt: 1, operation: 'revise', text: 'Use a shorter title', requestId: randomUUID(),
    checkpoint: {version: 1, inFlight: null},
  }), /may already have happened.*blocked/i);
  const jobs = (await engine.list('owner')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'running');
  assert.deepEqual(jobs[0].commands, []);
  releaseWrite(); await until(() => engine.activeCount() === 0);
  assert.equal(writes, 1);
  assert.equal((await engine.list('owner')).jobs[0].status, 'done');
});

test('legacy revisions carry available progress but block writes without trusted completed outcomes', async () => {
  const initial = botState(), id = randomUUID(), requests = []; let writes = 0;
  initial.jobs.push({id, botId: 'echo-assistant', botRevision: 1, goal: 'Remember the facts', attempt: 1,
    status: 'running', worker: 'previous-fixture', leaseUntil: Date.now() + 60000, draft: 'Available draft',
    history: [], context: {}, commands: [], events: [{type: 'TOOL_CALL_RESULT', tool: 'save_memory'}],
  });
  const engine = engineWith(cloudWith(async body => {
    requests.push(structuredClone(body));
    return response(requests.length === 1 ? [call('repeat', 'save_memory', {text: 'Remember the facts'})] : [{text: 'Check the previous saved note.'}]);
  }), {save: async () => { writes++; return {id: 'duplicate', title: 'Duplicate', dates: []}; }}, initial);
  const revision = {id, botId: 'echo-assistant', attempt: 1, operation: 'revise', text: 'Make it shorter', requestId: randomUUID()};
  const accepted = await engine.control('owner', revision);
  await until(() => engine.activeCount() === 0);
  assert.match(accepted.message, /checkpoint is unavailable.*writes are blocked/i);
  assert.equal(writes, 0);
  assert.equal((await engine.list('owner')).jobs[0].status, 'done');
  assert.match(requests[0].contents.flatMap(c => c.parts).map(p => p.text || '').join('\n'), /Available draft/);
  assert.match(requests[1].contents.flatMap(c => c.parts).find(p => p.functionResponse).functionResponse.response.error, /Writes are blocked/);
  assert.equal((await engine.control('owner', revision)).newRunId, accepted.newRunId);
  assert.equal(requests.length, 2);
});

test('legacy revisions with an unresolved write are rejected without changing the active task', async () => {
  const initial = botState(), id = randomUUID();
  initial.jobs.push({id, botId: 'echo-assistant', botRevision: 1, goal: 'Remember the facts', attempt: 1,
    status: 'running', worker: 'previous-fixture', leaseUntil: Date.now() + 60000,
    commands: [], events: [{type: 'TOOL_CALL_START', tool: 'save_memory'}],
  });
  const engine = engineWith(cloudWith(async () => { throw Error('No provider request should start'); }), {}, initial);
  await assert.rejects(engine.control('owner', {id, botId: 'echo-assistant', attempt: 1, operation: 'revise',
    text: 'Use a shorter title', requestId: randomUUID(),
  }), /no saved outcome.*blocked/i);
  const jobs = (await engine.list('owner')).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'running');
  assert.deepEqual(jobs[0].commands, []);
  assert.equal(engine.activeCount(), 0);
});

test('Answer & continue retains completed writes and asks the provider to replace unexecuted guessed calls', async () => {
  const notes = [], requests = [];
  const cloud = cloudWith(async body => {
    requests.push(structuredClone(body));
    if(requests.length === 1) return response([
      call('known-save', 'save_memory', {text: 'Original facts'}),
      call('question', 'ask_person', {question: 'Which date?'}),
      call('guessed-save', 'save_memory', {text: 'Guessed date'}),
    ]);
    if(requests.length === 2) return response([
      call('repeated-save', 'save_memory', {text: 'Original facts'}),
      call('answered-save', 'save_memory', {text: 'October 20'}),
    ]);
    return response([{text: 'Saved the confirmed date.'}]);
  });
  const engine = engineWith(cloud, {save: async value => {
    notes.push(value.text); return {id: `note-${notes.length}`, title: value.text, dates: []};
  }});
  const id = randomUUID();
  await engine.run('owner', {requestId: id, botId: 'echo-assistant', revision: 1, goal: 'Save facts and appointment date'}, {requestId: id});
  await until(() => engine.activeCount() === 0);
  const paused = (await engine.list('owner')).jobs[0];
  assert.equal(paused.status, 'needs-you');
  assert.equal(paused.result.reply, 'Which date?');
  assert.deepEqual(notes, ['Original facts']);
  const answer = {requestId: randomUUID(), parentId: id, botId: 'echo-assistant', revision: 1, goal: 'October 20'};
  await engine.run('owner', answer, {requestId: answer.requestId});
  await until(() => engine.activeCount() === 0);
  const jobs = (await engine.list('owner')).jobs;
  assert.equal(jobs[0].status, 'done');
  assert.equal(jobs[0].parentId, id);
  assert.equal(jobs[0].result.question, null);
  assert.deepEqual(notes, ['Original facts', 'October 20'], 'Neither saved facts nor guessed arguments are replayed');
  assert.equal(jobs[1].status, 'needs-you', 'The original waiting result remains immutable');
  const parts = requests[1].contents.flatMap(c => c.parts);
  assert.ok(parts.some(p => p.text?.includes('Which date?') && p.text.includes('October 20')));
  assert.equal(parts.find(p => p.functionResponse?.id === 'known-save').functionResponse.response.title, 'Original facts');
  assert.equal(parts.find(p => p.functionResponse?.id === 'guessed-save').functionResponse.response.status, 'not-executed');
  assert.equal((await engine.run('owner', answer)).repeated, true);
  assert.equal(requests.length, 3, 'Repeating the accepted answer does not launch another provider call');
});

test('Interrupt & revise preserves saved tool results and partial output without replaying writes or old pending calls', async t => {
  const notes = [], requests = []; let releaseModel, releaseRead, reading = false;
  const cloud = cloudWith(async body => {
    requests.push(structuredClone(body));
    if(requests.length === 1) {
      await new Promise(resolve => { releaseModel = resolve; });
      return response([{text: 'Partial plan'}, call('saved-note', 'save_memory', {text: 'Original facts'})]);
    }
    if(requests.length === 2) return response([call('old-read', 'get_today')]);
    if(requests.length === 3) return response([call('repeated-note', 'save_memory', {text: 'Original facts'})]);
    return response([{text: 'Revised plan using the saved facts.'}]);
  });
  const engine = engineWith(cloud, {
    save: async value => { notes.push(value.text); return {id: `note-${notes.length}`, title: value.text, dates: []}; },
    today: async () => { reading = true; await new Promise(resolve => { releaseRead = resolve; }); return {items: []}; },
  });
  const id = randomUUID();
  t.after(async () => { releaseModel?.(); releaseRead?.(); await engine.stop('owner', id); await until(() => engine.activeCount() === 0); });
  await engine.run('owner', {requestId: id, botId: 'echo-assistant', revision: 1, goal: 'Save facts and plan my day'}, {requestId: id});
  await until(() => releaseModel);
  const update = {id, botId: 'echo-assistant', attempt: 1, operation: 'update', text: 'Use metric units', requestId: randomUUID()};
  await engine.control('owner', update); releaseModel();
  await until(() => reading);
  const revision = {id, botId: 'echo-assistant', attempt: 1, operation: 'revise', text: 'Make the plan shorter', requestId: randomUUID()};
  const accepted = await engine.control('owner', revision);
  await until(async () => (await engine.list('owner')).jobs[0].status === 'done');
  releaseRead(); await until(() => engine.activeCount() === 0);
  assert.deepEqual(notes, ['Original facts'], 'A repeated completed save returns its original outcome');
  const jobs = (await engine.list('owner')).jobs;
  assert.equal(jobs[0].id, accepted.newRunId);
  assert.equal(jobs[0].parentId, id);
  assert.equal(jobs[0].result.saved[0].id, 'note-1');
  assert.equal(jobs[0].commands.find(c => c.id === update.requestId).status, 'applied');
  assert.equal(jobs[1].status, 'stopped');
  assert.equal(jobs[1].draft, 'Partial plan');
  const parts = requests[2].contents.flatMap(c => c.parts);
  assert.ok(parts.some(p => p.text?.includes('Revised instruction: Make the plan shorter')));
  assert.ok(parts.some(p => p.text === 'User update for this task: Use metric units'));
  assert.ok(parts.some(p => p.text === 'Partial plan'));
  assert.equal(parts.find(p => p.functionResponse?.id === 'saved-note').functionResponse.response.title, 'Original facts');
  assert.equal(parts.find(p => p.functionResponse?.id === 'old-read').functionResponse.response.status, 'not-executed');
  assert.equal((await engine.control('owner', revision)).newRunId, accepted.newRunId);
  assert.equal(requests.length, 4, 'A repeated revision uses the existing child');
});
