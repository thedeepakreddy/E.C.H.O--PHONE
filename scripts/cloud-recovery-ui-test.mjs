// Run directly: ECHO_BROWSER_DEPENDENCIES=<bundled node_modules> node scripts/cloud-recovery-ui-test.mjs
// Test-only selector contract with the app renderer:
//   [data-cloud-failure] lives in #messages and survives toast expiry / renderChat.
//   [data-cloud-retry] is a native button named Retry, absent/disabled for retryable:false.
//   [data-model-notice] explains modelInfo separately from the answer markdown.
// Extract the shipped chat, cloudApi and Mac sync handlers; stub surrounding bootstrap/API boundaries.
// No copied recovery logic, relay/server imports, credentials, or provider requests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES
  ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href)
  : await import('playwright');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
function shipped(from, until) {
  const start = app.indexOf(from), end = app.indexOf(until, start);
  assert.ok(start >= 0 && end > start, `Find shipped handler boundaries: ${from}`);
  return app.slice(start, end);
}
const helpers = shipped('  const el = ', '  // ---------- no zoom, ever ----------');
const toastSource = shipped('  let toastTimer = ', '  // ---------- link token and session ----------');
const cloudApiSource = shipped('  async function cloudApi(', '  // Only categorical diagnostics');
const problemSource = shipped('  function cloudProblem(', '  // ---------- approvals ----------');
const chatSource = shipped('  // ---------- chat ----------', '  // Buttons under Phone mode\'s answers.');
const syncSource = shipped('  let syncing = false;', '  // Voice notes: hold the composer mic;');
const chatMarkup = html.match(/<section id="v-chat"[\s\S]*?<\/section>/)?.[0];
assert.ok(chatMarkup, 'Use shipped chat markup');
const markup = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${css}</style>${chatMarkup}<span id="chat-badge" hidden></span>
  <div class="toast glass" id="toast" role="status" aria-live="polite"></div>`;
const markdownSources = ['vendor/markdown-it.min.js', 'vendor/purify.min.js', 'markdown.js']
  .map(file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
const threadId = 'fixture-original-thread';
const text = 'Compare my saved options, preserving this exact request.';
const history = [
  {role: 'user', text: 'My budget is 120 euros.'},
  {role: 'echo', text: 'I will compare the two saved options.'},
];
const unavailable = {error: 'unavailable', message: 'Echo’s brain is temporarily busy. Please retry.', retryable: true};
const answer = 'The second saved option fits your budget.';
const modelInfo = {requested: 'gemini-3.8-flash', used: 'gemini-3.5-flash-lite', fallback: true};
const success = {reply: answer, actions: [], sources: [], modelInfo};
const engine = process.env.ECHO_CLOUD_RECOVERY_BROWSER || 'chromium';
const server = http.createServer((request, response) => {
  // All requests must be intercepted; there is no live API behind this fixture.
  response.writeHead(500); response.end('Unexpected un-intercepted fixture request');
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await pw[engine].launch({headless: true,
    ...(engine === 'webkit' && process.env.ECHO_WEBKIT_EXECUTABLE ? {executablePath: process.env.ECHO_WEBKIT_EXECUTABLE} : {})});

  async function fixture(t) {
    const context = await browser.newContext({viewport: {width: 390, height: 844},
      isMobile: true, hasTouch: true, serviceWorkers: 'block'});
    const requests = [], pending = [], unexpected = [], errors = [], consoleErrors = [];
    t.after(async () => {
      for (const resolve of pending) resolve(null);
      await context.close();
      assert.deepEqual(unexpected, [], 'No unexpected network, Mac, or provider calls');
      assert.deepEqual(errors, [], 'No browser runtime errors');
      assert.deepEqual(consoleErrors, [], 'No unexpected browser console errors or warnings');
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/' && request.method() === 'GET') {
        return route.fulfill({status: 200, contentType: 'text/html', body: markup});
      }
      if (url.origin === origin && url.pathname === '/cloud/chat' && request.method() === 'POST') {
        requests.push(request.postDataJSON());
        const reply = await new Promise(resolve => pending.push(resolve));
        if (!reply) return route.abort();
        return route.fulfill({status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body)});
      }
      unexpected.push(`${request.method()} ${url.href}`);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      // A deliberate HTTP 503 is a transport fixture, not a runtime error.
      if (message.location().url === `${origin}/cloud/chat`
        && /^Failed to load resource:.*503/.test(message.text())) return;
      consoleErrors.push(message.text());
    });
    await page.clock.install({time: new Date('2026-10-15T12:00:00Z')});
    await page.goto(origin);
    for (const content of markdownSources) await page.addScriptTag({content});
    await page.addScriptTag({content: `(() => {
      "use strict";
      const $ = id => document.getElementById(id);
      const body = document.body;
      const values = new Map([["echo_chat_cache", JSON.stringify(${JSON.stringify(history)}.map((m, i) => ({
        k: "fixture-history-" + i, at: Date.now() - 2000 + i, from: m.role === "user" ? "you" : "echo",
        text: m.text, kind: "text", src: "phone", threadId: ${JSON.stringify(threadId)}
      })))]]);
      const store = {get: key => values.get(key) ?? null, set: (key, value) => values.set(key, value)};
      ${helpers}
      ${toastSource}
      let mode = "phone", currentView = "chat", currentThread = ${JSON.stringify(threadId)};
      let cloudBusy = false, cloudInfo = null, macOnline = false, snapCtx = null, stickToBottom = true;
      let PASS = "local-fixture-only", INSTALLATION = "fixture-installation", DEV = "fixture-account";
      const passValid = () => true, ensurePhoneSession = async () => {};
      const paintPhoneHome = () => {}, renderMode = () => {}, prepareActions = () => {};
      let fixturePlace = {name: "Budapest", lat: 47.5, lon: 19.04}, S = "";
      values.set("echo_shortcuts", "Original shortcut");
      const place = () => fixturePlace, voiceSession = {active: false}, stopVoice = () => {};
      const fixtureImports = [];
      const api = async (path, options) => {
        if (path !== "/chat/import") throw Error("Unexpected fixture Mac API path: " + path);
        fixtureImports.push(structuredClone(options.json));
        return {ok: true};
      };
      const experience = {ensureThread: async () => {}, afterReply: () => {}};
      ${cloudApiSource}
      ${problemSource}
      ${chatSource}
      ${syncSource}
      // Bootstrap-only hooks: the request/render/retry paths above are all shipped code.
      window.__cloudRecoveryFixture = {
        rerender: renderChat,
        stop: () => cloudAbort?.abort(),
        ambient: options => {
          if (options.account !== undefined) DEV = options.account;
          if (options.threadId !== undefined) currentThread = options.threadId;
          if (options.place !== undefined) fixturePlace = options.place;
          if (options.shortcuts !== undefined) values.set("echo_shortcuts", options.shortcuts);
        },
        syncMac: async () => { S = "fixture-session"; macOnline = true; await syncToMac(); return fixtureImports; },
      };
      $("v-chat").hidden = false;
      renderChat();
    })();`});
    assert.deepEqual(errors, [], 'Shipped handler fixture initializes successfully');
    const reply = (index, body, status = 200) => {
      assert.ok(pending[index], `Cloud request ${index + 1} reached the local transport`);
      pending[index]({body, status});
    };
    async function send() {
      await page.locator('#chat-input').fill(text);
      const sent = page.waitForRequest(request => request.url() === `${origin}/cloud/chat`);
      await page.locator('#send-btn').click();
      await sent;
      assert.equal(await page.locator('#typing').count(), 1, 'Typing is shown while the request is pending');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].text, text);
      assert.equal(requests[0].threadId, threadId);
      assert.deepEqual(requests[0].history, history, 'The initial request contains only the prior conversation');
      assert.equal(typeof requests[0].requestId, 'string');
      assert.ok(requests[0].requestId.length > 0, 'The initial request has an identity');
    }
    async function settled() {
      await page.waitForFunction(() => !document.getElementById('typing'));
      assert.doesNotMatch(await page.locator('#presence').innerText(), /typing/i);
      assert.deepEqual(errors, [], 'Actual chat handlers settle without runtime errors');
    }
    return {page, requests, reply, send, settled};
  }

  await test(`${engine}: overload leaves a persistent in-chat failure and stops typing`, async t => {
    const f = await fixture(t);
    await f.send(); f.reply(0, unavailable, 503); await f.settled();
    const failure = f.page.locator('#messages [data-cloud-failure]');
    assert.equal(await failure.count(), 1, '503 overload must remain in the conversation, not only a toast');
    assert.equal(await failure.isVisible(), true);
    assert.ok((await failure.innerText()).includes(unavailable.message));
    assert.equal(await f.page.locator('#messages .msg.me').filter({hasText: text}).count(), 1,
      'The original user message stays in the conversation');
    const retry = failure.locator('[data-cloud-retry]');
    assert.equal(await retry.evaluate(button => button.tagName), 'BUTTON', 'Retry must be a native button');
    assert.equal(await failure.getByRole('button', {name: 'Retry', exact: true}).count(), 1);
    assert.equal(await retry.isEnabled(), true);
    assert.equal(await retry.evaluate(button => getComputedStyle(button).minHeight), '44px');
    await f.page.screenshot({path:'/tmp/echo-cloud-recovery-failure.png'});
    await f.page.clock.runFor(6000); // Past the shipped 2600 ms toast expiry.
    assert.equal(await f.page.locator('#toast').evaluate(node => node.classList.contains('show')), false);
    await f.page.evaluate(() => window.__cloudRecoveryFixture.rerender());
    assert.equal(await failure.isVisible(), true, 'Failure survives toast expiry and a normal chat redraw');
    assert.equal(await retry.isVisible(), true);
    assert.equal(f.requests.length, 1, 'Overload never silently auto-replays');
  });

  await test(`${engine}: double-click Retry replays the original request exactly once`, async t => {
    const f = await fixture(t);
    await f.send();
    const original = structuredClone(f.requests[0]);
    f.reply(0, unavailable, 503); await f.settled();
    const retry = f.page.locator('#messages [data-cloud-retry]');
    assert.equal(await retry.count(), 1, 'A retryable overload exposes Retry');
    assert.equal(await retry.evaluate(button => button.tagName), 'BUTTON');
    await f.page.locator('#chat-input').fill('A different unsent draft must not become the replay.');
    await f.page.evaluate(() => window.__cloudRecoveryFixture.ambient({
      place: {name: 'Vienna', lat: 48.2, lon: 16.37}, shortcuts: 'A different shortcut',
    }));
    const bounds = await retry.boundingBox();
    assert.ok(bounds, 'Retry is rendered and clickable');
    const sent = f.page.waitForRequest(request => request.url().endsWith('/cloud/chat'));
    // Two native clicks even if the first click disables/removes the button.
    await f.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {clickCount: 2, delay: 20});
    await sent; await f.page.clock.runFor(1000);
    assert.equal(f.requests.length, 2, 'A double click sends one replay while its response is pending');
    assert.deepEqual(f.requests[1], original,
      'Retry preserves the full original request, including identity, thread, history, text and context');
    f.reply(1, success); await f.settled();
    assert.equal(await f.page.locator('#messages .msg.me').filter({hasText: text}).count(), 1);
    const answerBody = f.page.locator('#messages .msg.echo .echo-markdown').filter({hasText: answer});
    assert.equal(await answerBody.count(), 1, 'Recovery renders exactly one answer');
    assert.equal((await answerBody.innerText()).trim(), answer, 'Fallback metadata does not alter the answer');
    assert.equal(await f.page.locator('#messages [data-cloud-failure]:visible').count(), 0);
    assert.equal(await f.page.locator('#messages [data-cloud-retry]:visible').count(), 0);
    assert.equal(await f.page.locator('#toast').evaluate(node=>node.classList.contains('show')),false,'A recovered answer clears its stale overload toast');
    const notice = f.page.locator('#messages [data-model-notice]');
    assert.equal(await notice.isVisible(), true, 'The recovered response discloses fallback');
    assert.ok((await notice.innerText()).includes(modelInfo.used));
    await f.page.screenshot({path:'/tmp/echo-cloud-recovery-fallback.png'});
    await f.page.clock.runFor(6000);
    assert.equal(f.requests.length, 2, 'Success cannot trigger a delayed extra replay');
  });

  await test(`${engine}: fallback model notice is visible separately from the unmodified answer`, async t => {
    const f = await fixture(t);
    await f.send(); f.reply(0, success); await f.settled();
    const answerBody = f.page.locator('#messages .msg.echo .echo-markdown').filter({hasText: answer});
    assert.equal((await answerBody.innerText()).trim(), answer);
    const notice = f.page.locator('#messages [data-model-notice]');
    assert.equal(await notice.count(), 1, 'A modelInfo fallback must have a visible model notice');
    assert.equal(await notice.isVisible(), true);
    assert.ok((await notice.innerText()).includes(modelInfo.used), 'The notice identifies the model actually used');
    assert.equal(await answerBody.locator('[data-model-notice]').count(), 0, 'Model metadata is separate from answer content');
  });

  await test(`${engine}: retryable:false offers no actionable Retry and never replays`, async t => {
    const f = await fixture(t);
    await f.send(); f.reply(0, {...unavailable, retryable: false}, 503); await f.settled();
    const retries = f.page.locator('#messages [data-cloud-retry]');
    assert.equal(await f.page.locator('#messages [data-cloud-failure]').isVisible(), true,
      'Non-retryable failures still remain in the conversation');
    for (const retry of await retries.all()) {
      assert.equal(await retry.evaluate(button => button.tagName), 'BUTTON');
      assert.equal(await retry.isDisabled(), true, 'A non-retryable error cannot offer an enabled Retry');
      // Native activation must also be fenced if a disabled button is retained.
      await retry.evaluate(button => button.click());
    }
    await f.page.clock.runFor(30_000);
    assert.equal(f.requests.length, 1, 'Non-retryable failures cannot automatically or explicitly replay');
    assert.equal(await f.page.locator('#typing').count(), 0);
    assert.equal(await f.page.locator('[data-model-notice]').count(), 0, 'A failed response has no fallback success notice');
  });

  await test(`${engine}: a Retry from an inactive conversation cannot replay`, async t => {
    const f = await fixture(t);
    await f.send(); f.reply(0, unavailable, 503); await f.settled();
    const retry = f.page.locator('#messages [data-cloud-retry]');
    assert.equal(await retry.count(), 1);
    // Simulate conversation state changing before the old DOM is redrawn.
    await f.page.evaluate(() => window.__cloudRecoveryFixture.ambient({threadId: 'fixture-other-thread'}));
    await retry.click();
    await f.page.clock.runFor(1000);
    assert.equal(f.requests.length, 1, 'A stale Retry cannot send into another conversation');
    await f.page.evaluate(() => window.__cloudRecoveryFixture.ambient({threadId: 'fixture-original-thread'}));
    const sent = f.page.waitForRequest(request => request.url().endsWith('/cloud/chat'));
    await retry.click(); await sent;
    assert.deepEqual(f.requests[1], f.requests[0], 'Returning to the original conversation permits the original replay');
    f.reply(1, success); await f.settled();
  });

  await test(`${engine}: failure messages stay out of later request history and Mac sync`, async t => {
    const f = await fixture(t);
    await f.send(); f.reply(0, unavailable, 503); await f.settled();
    const nextText = 'Compare a third option as a new request.';
    await f.page.locator('#chat-input').fill(nextText);
    const sent = f.page.waitForRequest(request => request.url().endsWith('/cloud/chat'));
    await f.page.locator('#send-btn').click(); await sent;
    assert.notEqual(f.requests[1].requestId, f.requests[0].requestId, 'A new message gets a new request identity');
    assert.equal(f.requests[1].text, nextText);
    assert.deepEqual(f.requests[1].history, [...history, {role: 'user', text}],
      'History retains the original user message and excludes the synthetic failure');
    f.reply(1, {reply: answer, actions: [], sources: []}); await f.settled();
    const imports = await f.page.evaluate(() => window.__cloudRecoveryFixture.syncMac());
    const imported = imports.flatMap(batch => batch.messages);
    assert.deepEqual(imported.map(message => message.text), [...history.map(message => message.text), text, nextText, answer],
      'The shipped Mac sync copies conversation messages without the failure record');
    assert.equal(imported.some(message => message.ref.endsWith('-failure')), false);
  });

  await test(`${engine}: a 45-second timeout stops typing and leaves an uncertain failure without Retry`, async t => {
    const f = await fixture(t);
    await f.page.clock.pauseAt(new Date('2026-10-15T12:01:00Z'));
    await f.send(); // Leave the transport unresolved to exercise the actual abort timer.
    await f.page.clock.runFor(44_999);
    assert.equal(await f.page.locator('#typing').count(), 1, 'The deadline has not expired before 45 seconds');
    assert.equal(await f.page.locator('#messages [data-cloud-failure]').count(), 0);
    await f.page.clock.runFor(1); await f.settled();
    const failure = f.page.locator('#messages [data-cloud-failure]');
    assert.equal(await failure.isVisible(), true);
    assert.match(await failure.innerText(), /took too long|timed out/i);
    assert.match(await failure.innerText(), /may already|check.*before.*again|uncertain/i);
    assert.equal(await failure.locator('[data-cloud-retry]').count(), 0,
      'A client timeout cannot infer that replay is safe');
    assert.equal(await f.page.locator('#messages .msg.me').filter({hasText: text}).count(), 1);
    await f.page.clock.runFor(60_000);
    assert.equal(await failure.isVisible(), true, 'The uncertain result persists after toast expiry');
    assert.equal(f.requests.length, 1, 'Timeout cannot silently replay the request');
  });
  await test(`${engine}: Stop clears pending thinking without a failure or fallback replay`,async t=>{
    const f=await fixture(t);await f.send();
    await f.page.evaluate(()=>window.__cloudRecoveryFixture.stop());await f.settled();
    await f.page.clock.runFor(60_000);
    assert.equal(await f.page.locator('[data-cloud-failure]').count(),0);
    assert.equal(f.requests.length,1);
  });

  await test(`${engine}: an old account’s Retry cannot submit its request under a new account`,async t=>{
    const f=await fixture(t);await f.send();f.reply(0,unavailable,503);await f.settled();
    await f.page.evaluate(()=>window.__cloudRecoveryFixture.ambient({account:'another-fixture-account'}));
    await f.page.locator('[data-cloud-retry]').click();await f.page.clock.runFor(1000);
    assert.equal(f.requests.length,1);
    assert.equal(await f.page.locator('#typing').count(),0);
  });

  await test(`${engine}: Stop during Retry consumes its old safe receipt and never re-enables it`,async t=>{
    const f=await fixture(t);await f.send();f.reply(0,{...unavailable,retryVersion:'original-history-key'},503);await f.settled();
    const sent=f.page.waitForRequest(request=>request.url().endsWith('/cloud/chat'));
    await f.page.locator('[data-cloud-retry]').click();await sent;
    assert.equal(f.requests[1].retryVersion,'original-history-key','Server history fence is retained on replay');
    await f.page.evaluate(()=>window.__cloudRecoveryFixture.stop());await f.settled();
    await f.page.clock.runFor(60_000);
    assert.equal(await f.page.locator('[data-cloud-retry]').count(),0,'An old safe receipt cannot authorize another uncertain attempt');
    assert.match(await f.page.locator('[data-cloud-failure]').innerText(),/stopped|may have started/i);
    assert.equal(f.requests.length,2);
  });

  await test(`${engine}: a late answer cannot enter a different account’s conversation`,async t=>{
    const f=await fixture(t);await f.send();
    await f.page.evaluate(()=>window.__cloudRecoveryFixture.ambient({account:'another-fixture-account'}));
    f.reply(0,success);await f.settled();
    assert.equal(await f.page.locator('[data-model-notice]').count(),0);
    assert.equal(await f.page.locator('.echo-markdown').filter({hasText:answer}).count(),0);
    assert.equal(await f.page.locator('[data-cloud-failure]').count(),0);
  });
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
