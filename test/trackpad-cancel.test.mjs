import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Run the shipped handlers, with only DOM, time and the Mac API boundary supplied.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('  const pad = $("pad");');
const end = app.indexOf('  document.querySelectorAll("[data-mouse]")', start);
assert.ok(start >= 0 && end > start, 'Extract the actual trackpad handlers');
const source = app.slice(start, end);

function fixture() {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), commands = [], classes = new Set(), captures = new Set();
  const pad = new EventTarget();
  pad.classList = {add: name => classes.add(name), remove: name => classes.delete(name)};
  pad.setPointerCapture = id => captures.add(id);
  pad.hasPointerCapture = id => captures.has(id);
  pad.releasePointerCapture = id => {
    captures.delete(id);
    send('lostpointercapture', {pointerId: id});
  };
  function send(type, props = {}) {
    const event = new Event(type, {cancelable: true});
    Object.assign(event, {pointerId: 1, clientX: 100, clientY: 100, ...props});
    pad.dispatchEvent(event);
  }
  function tick(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      const [id, timer] = next;
      now = timer.at; timers.delete(id); timer.run();
    }
    now = until;
  }
  vm.runInNewContext(source, {
    $: id => { assert.equal(id, 'pad'); return pad; },
    Date: class extends Date { static now() { return now; } },
    performance: {now: () => now},
    setTimeout: (run, delay) => { const id = ++nextTimer; timers.set(id, {run, at: now + delay}); return id; },
    clearTimeout: id => timers.delete(id),
    api: (path, {json}) => {
      assert.equal(path, '/mouse');
      commands.push(JSON.parse(JSON.stringify(json)));
      return Promise.resolve({ok: true});
    },
    toast: () => assert.fail('Unexpected Mac input error'),
  });
  return {send, tick, commands, timers, captures, active: () => classes.has('active')};
}

test('a cancelled short touch never clicks, including a late pointerup', () => {
  const f = fixture();
  f.send('pointerdown');
  f.tick(20);
  f.send('pointercancel');
  f.send('pointerup');
  f.tick(1000);
  assert.deepEqual(f.commands, []);
  assert.equal(f.active(), false);
  assert.equal(f.timers.size, 0);
});

test('only the active pointer can move, finish or cancel the gesture', () => {
  const f = fixture();
  f.send('pointerdown');
  f.send('pointerdown', {pointerId: 2, clientX: 500});
  f.send('pointermove', {pointerId: 2, clientX: 900});
  f.send('pointerup', {pointerId: 2});
  f.send('pointercancel', {pointerId: 2});
  f.send('lostpointercapture', {pointerId: 2});
  assert.equal(f.active(), true, 'Other pointers cannot end the owner gesture');
  assert.deepEqual([...f.captures], [1], 'Other pointers cannot steal capture');
  f.send('pointermove', {clientX: 110, clientY: 105});
  f.send('pointerup');
  f.tick(1000);
  assert.deepEqual(f.commands, [{action: 'move', dx: 22, dy: 11}]);
  assert.equal(f.active(), false);
});

test('capture loss discards movement and a pending tap, then permits a fresh single tap', () => {
  const f = fixture();
  f.send('pointerdown'); f.send('pointerup');
  f.tick(50);
  f.send('pointerdown');
  f.send('pointermove', {clientX: 120, clientY: 90});
  f.send('lostpointercapture');
  assert.equal(f.active(), false);
  assert.equal(f.timers.size, 0);
  f.send('pointerup');
  f.send('pointerdown', {pointerId: 3}); f.send('pointerup', {pointerId: 3});
  f.tick(1000);
  assert.deepEqual(f.commands, [{action: 'click'}]);
});

test('pointercancel releases the owned capture and drops pending tap and movement immediately', () => {
  const f = fixture();
  f.send('pointerdown'); f.send('pointerup');
  f.tick(50);
  f.send('pointerdown'); f.send('pointermove', {clientX: 120, clientY: 90});
  f.send('pointercancel');
  assert.equal(f.active(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.captures.size, 0);
  f.send('pointermove', {clientX: 800}); f.send('pointerup');
  f.tick(1000);
  assert.deepEqual(f.commands, []);
});

test('a completed move leaves no old flush timer to send the next gesture early', () => {
  const f = fixture();
  f.send('pointerdown'); f.send('pointermove', {clientX: 110});
  f.tick(10); f.send('pointerup', {clientX: 110});
  assert.deepEqual(f.commands, [{action: 'move', dx: 22, dy: 0}]);
  assert.equal(f.timers.size, 0);
  f.tick(10);
  f.send('pointerdown', {pointerId: 2}); f.send('pointermove', {pointerId: 2, clientX: 120});
  f.tick(20);
  assert.equal(f.commands.length, 1, 'The previous gesture cannot flush the current movement');
  f.send('pointercancel', {pointerId: 2});
  f.tick(1000);
  assert.equal(f.commands.length, 1);
  assert.equal(f.timers.size, 0);
});

for (const interruption of ['pointercancel', 'lostpointercapture']) {
  test(`${interruption} resets tap history and deltas before an immediate new gesture`, () => {
    const f = fixture();
    f.send('pointerdown'); f.send('pointerup');
    f.tick(50);
    f.send('pointerdown'); f.send('pointermove', {clientX: 120, clientY: 90});
    f.send(interruption);
    assert.equal(f.timers.size, 0);
    f.send('pointerdown', {pointerId: 3}); f.send('pointerup', {pointerId: 3});
    assert.deepEqual(f.commands, [], 'The next tap must not become a double-click');
    f.tick(299); assert.deepEqual(f.commands, []);
    f.tick(1); assert.deepEqual(f.commands, [{action: 'click'}]);
    f.send('pointerdown', {pointerId: 4});
    f.send('pointermove', {pointerId: 4, clientX: 105, clientY: 110});
    f.tick(40); f.send('pointerup', {pointerId: 4}); f.tick(1000);
    assert.deepEqual(f.commands, [{action: 'click'}, {action: 'move', dx: 11, dy: 22}]);
    assert.equal(f.timers.size, 0);
  });

  test(`${interruption} drops only unsent movement and ignores late events`, () => {
    const f = fixture();
    f.send('pointerdown'); f.send('pointermove', {clientX: 110, clientY: 95});
    f.tick(40);
    f.send('pointermove', {clientX: 130, clientY: 80});
    f.send(interruption);
    f.send('pointermove', {clientX: 900}); f.send('pointerup'); f.send(interruption);
    f.tick(1000);
    assert.deepEqual(f.commands, [{action: 'move', dx: 22, dy: -11}]);
    assert.equal(f.timers.size, 0);
    assert.equal(f.active(), false);
  });
}

test('normal single taps still wait 300 ms and implicit capture loss preserves the click', () => {
  const f = fixture();
  f.send('pointerdown'); f.tick(20); f.send('pointerup');
  f.send('lostpointercapture'); f.send('pointercancel');
  f.tick(299); assert.deepEqual(f.commands, []);
  f.tick(1); assert.deepEqual(f.commands, [{action: 'click'}]);
  f.tick(1000); assert.equal(f.commands.length, 1);
});

test('normal double taps send exactly one double-click with no delayed single click', () => {
  const f = fixture();
  f.send('pointerdown'); f.send('pointerup'); f.send('lostpointercapture');
  f.tick(100);
  f.send('pointerdown', {pointerId: 2}); f.send('pointerup', {pointerId: 2});
  f.send('lostpointercapture', {pointerId: 2});
  assert.deepEqual(f.commands, [{action: 'dclick'}]);
  f.tick(1000);
  assert.deepEqual(f.commands, [{action: 'dclick'}]);
  assert.equal(f.timers.size, 0);
});

test('normal moves batch at 40 ms, flush on release and never click', () => {
  const f = fixture();
  f.send('pointerdown');
  f.send('pointermove', {clientX: 103, clientY: 98});
  f.send('pointermove', {clientX: 110, clientY: 95});
  f.tick(39); assert.deepEqual(f.commands, []);
  f.tick(1); assert.deepEqual(f.commands, [{action: 'move', dx: 22, dy: -11}]);
  f.send('pointermove', {clientX: 105, clientY: 100});
  f.send('pointerup'); f.send('lostpointercapture'); f.tick(1000);
  assert.deepEqual(f.commands, [{action: 'move', dx: 22, dy: -11}, {action: 'move', dx: -11, dy: 11}]);
  assert.equal(f.timers.size, 0);
});

test('a long stationary press still does not click', () => {
  const f = fixture();
  f.send('pointerdown'); f.tick(260); f.send('pointerup'); f.tick(1000);
  assert.deepEqual(f.commands, []);
});
