import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES
  ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href)
  : await import('playwright');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('  const pad = $("pad");');
const end = app.indexOf('  document.querySelectorAll("[data-mouse]")', start);
assert.ok(start >= 0 && end > start, 'Use the shipped trackpad handlers');
const source = app.slice(start, end);
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const markup = html.match(/<div\b[^>]*\bid="pad"[\s\S]*?<\/div>/)?.[0];
assert.ok(markup, 'Use the existing trackpad control');
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const engine = process.env.ECHO_TRACKPAD_BROWSER || 'chromium';
const browser = await pw[engine].launch({headless: true});
try {
  // No relay or app bootstrap: only the extracted handlers and a recording API.
  const context = await browser.newContext({viewport: {width: 390, height: 844},
    isMobile: true, hasTouch: true, serviceWorkers: 'block', offline: true});
  const requests = [], errors = [];
  await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) errors.push(message.text());
    });
  });
  async function check(name, scenario) {
    const page = await context.newPage();
    try {
      await page.clock.install({time: new Date('2026-10-15T12:00:00Z')});
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style>${markup}`);
      await page.addScriptTag({content: `{
        window.__commands = [];
        const $ = id => document.getElementById(id);
        const api = async (path, options) => {
          if (path !== '/mouse') throw Error('Unexpected fixture API path: ' + path);
          window.__commands.push(structuredClone(options.json));
          return {ok: true};
        };
        const toast = message => { throw Error(message); };
        ${source}
      }`});
      assert.equal(await page.locator('#pad').evaluate(pad => getComputedStyle(pad).touchAction), 'none');
      const state = () => page.evaluate(() => ({commands: window.__commands,
        active: document.getElementById('pad').classList.contains('active')}));
      await scenario(page, state);
      console.log(`PASS ${engine}: ${name}`);
    } finally { await page.close(); }
  }
  async function down(page) {
    await page.mouse.move(100, 100); await page.mouse.down();
    assert.equal(await page.locator('#pad').evaluate(pad => pad.hasPointerCapture(1)), true);
  }

  await check('native single tap and implicit capture loss preserve the delayed click', async (page, state) => {
    await down(page); await page.mouse.up();
    await page.clock.runFor(299); assert.deepEqual((await state()).commands, []);
    await page.clock.runFor(1); assert.deepEqual((await state()).commands, [{action: 'click'}]);
    assert.equal((await state()).active, false);
  });
  await check('native double tap produces only one double-click', async (page, state) => {
    await down(page); await page.mouse.up(); await page.clock.runFor(100);
    await down(page); await page.mouse.up(); await page.clock.runFor(1000);
    assert.deepEqual((await state()).commands, [{action: 'dclick'}]);
  });
  await check('native movement batches at 40 ms and release flushes without a tap', async (page, state) => {
    await down(page); await page.mouse.move(110, 105);
    await page.clock.runFor(39); assert.deepEqual((await state()).commands, []);
    await page.clock.runFor(1);
    assert.deepEqual((await state()).commands, [{action: 'move', dx: 22, dy: 11}]);
    await page.mouse.move(120, 100); await page.mouse.up(); await page.clock.runFor(1000);
    assert.deepEqual((await state()).commands, [{action: 'move', dx: 22, dy: 11}, {action: 'move', dx: 22, dy: -11}]);
  });
  await check('a completed move cannot flush a later cancelled gesture', async (page, state) => {
    await down(page); await page.mouse.move(110, 100);
    await page.clock.runFor(10); await page.mouse.up();
    await page.clock.runFor(10); await down(page); await page.mouse.move(120, 100);
    await page.clock.runFor(20);
    assert.deepEqual((await state()).commands, [{action: 'move', dx: 22, dy: 0}]);
    await page.locator('#pad').dispatchEvent('pointercancel', {pointerId: 1});
    await page.mouse.up(); await page.clock.runFor(1000);
    assert.deepEqual(await state(), {commands: [{action: 'move', dx: 22, dy: 0}], active: false});
  });
  for (const interruption of ['pointercancel', 'lostpointercapture']) {
    await check(`${interruption} clears queued movement, tap and history before immediate reuse`, async (page, state) => {
      await down(page); await page.mouse.up(); await page.clock.runFor(50);
      await down(page); await page.mouse.move(120, 90);
      if (interruption === 'lostpointercapture') {
        // Real browser capture loss while the pointer is still down.
        await page.locator('#pad').evaluate(pad => pad.releasePointerCapture(1));
        await page.mouse.move(121, 90);
      } else {
        await page.locator('#pad').dispatchEvent('pointercancel', {pointerId: 1});
      }
      assert.deepEqual(await state(), {commands: [], active: false});
      assert.equal(await page.locator('#pad').evaluate(pad => pad.hasPointerCapture(1)), false);
      await page.mouse.up();
      await down(page); await page.mouse.up();
      assert.deepEqual((await state()).commands, [], 'Reset tap history must prevent double-click');
      await page.clock.runFor(1000);
      assert.deepEqual((await state()).commands, [{action: 'click'}]);
    });
  }
  await check('secondary pointer events cannot steal ownership or contaminate movement', async (page, state) => {
    await down(page);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      await page.locator('#pad').dispatchEvent(type, {pointerId: 2, clientX: 900, clientY: 900, pointerType: 'touch'});
      assert.deepEqual(await state(), {commands: [], active: true});
    }
    await page.mouse.move(110, 105); await page.mouse.up(); await page.clock.runFor(1000);
    assert.deepEqual((await state()).commands, [{action: 'move', dx: 22, dy: 11}]);
  });
  if (engine === 'chromium') {
    await check('browser-generated touchcancel never sends a click', async (page, state) => {
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 100, y: 100, id: 7}]});
        assert.equal((await state()).active, true);
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchCancel', touchPoints: []});
        await page.clock.runFor(1000);
        assert.deepEqual(await state(), {commands: [], active: false});
      } finally { await cdp.detach(); }
    });
    await check('two native touches preserve the first pointer through secondary release', async (page, state) => {
      const cdp = await context.newCDPSession(page);
      const first = {x: 100, y: 100, id: 7}, second = {x: 250, y: 100, id: 8};
      try {
        await page.evaluate(() => {
          window.__pointerEvents = [];
          for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
            document.getElementById('pad').addEventListener(type, event => window.__pointerEvents.push({type, id: event.pointerId, x: event.clientX}));
          }
        });
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [first]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [first, second]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [first, {...second, x: 280}]});
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: [{...second, x: 280}]});
        assert.deepEqual(await state(), {commands: [], active: true}, JSON.stringify(await page.evaluate(() => window.__pointerEvents)));
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchCancel', touchPoints: []});
        await page.clock.runFor(1000);
        assert.deepEqual(await state(), {commands: [], active: false});
      } finally { await cdp.detach(); }
    });
  }
  assert.deepEqual(errors, [], 'No browser errors or warnings');
  assert.deepEqual(requests, [], 'No network requests, including Mac/provider requests');
  console.log(`PASS ${engine}: isolated shipped-source fixture; zero network requests, console errors or warnings`);
  await context.close();
} finally { await browser.close(); }
