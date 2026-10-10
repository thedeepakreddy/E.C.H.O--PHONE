// Capture shipping pages in a disposable local account, never a real session.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRelay} from '../server.js';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES
  ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href)
  : await import('playwright');
const out = new URL('../docs/screenshots/', import.meta.url);
await mkdir(out, {recursive: true});
const report = '## Your next step\n\nStart with one useful outcome, then work through it together.\n\n- **Focus:** finish the project brief.\n- **Prepare:** collect the supporting notes.\n- **Review:** check the decisions before sharing.\n\nI can keep the thread and help with the next step.';
const gemini = {model: 'preview', embed: async () => Array(512).fill(0), generate: async () => ({candidates: [{content: {role: 'model', parts: [{text: report}]}}]})};
const password = randomUUID(); // Local preview only; never written or published.
const relay = createRelay({secret: randomUUID().repeat(3), adminPassword: password, publicUrl: 'http://127.0.0.1', gemini, fetchJson: async () => ({})});
const now = Date.now();
const world = {updatedAt: now, checkedAt: now, staleFeeds: [], conflicts: [], earthquakes: {count: 2, top: [{magnitude: 4.2, place: 'Sample region', at: now, depthKm: 12, tsunami: false, url: 'https://earthquake.usgs.gov/'}]}, fires: {count: 124, highConfidence: 18}, tsunamis: [], storms: [{title: 'Sample weather observation', type: 'Weather', severity: 'Monitor', source: 'Preview', at: now}]};
const today = {notifications: true, rows: [
  {id: 'sample-focus', taskId: 'sample-focus', kind: 'task', status: 'open', text: 'Finish the project brief', due: now + 3600000},
  {id: 'sample-review', taskId: 'sample-review', kind: 'reminder', status: 'open', text: 'Review tomorrow’s priorities', due: now + 5400000, repeat: {frequency: 'daily', interval: 1}},
  {id: 'sample-bill', taskId: 'sample-bill', kind: 'bill', status: 'open', text: 'Check the upcoming utility bill', due: now + 86400000}
], completed: [], events: [], calendarUpdatedAt: null, curiosity: null};
const briefing = {at: now, date: new Date(now).toISOString().slice(0,10), weather: {temp: 21, text: 'Clear', high: 23, low: 16, tip: 'A good day for a short walk.'}, place: 'Sample city', calendar: [{time: '10:00', title: 'Project review', location: 'Workspace'}], reminders: [{time: '18:00', text: 'Review tomorrow’s priorities'}], missions: [], macOnline: false};
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const fixture = path === '/world' ? world : path === '/cloud/today' && req.method === 'GET' ? today : path === '/cloud/briefing/now' ? {briefing} : path === '/weather' ? {temperature: 21, feelsLike: 20, humidity: 43, wind: 7, condition: 'Clear', updatedAt: now} : null;
  if (fixture) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(fixture));}
  else relay.handler(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const captures = [];
const selected = process.env.ECHO_SCREENSHOTS_ONLY?.split(',');
async function capture(id, title) {
  if (selected && !selected.includes(id)) return;
  await page.waitForTimeout(650);
  if (await page.locator('#toast.bad.show').count()) throw new Error('A preview error was visible on ' + id);
  await page.screenshot({path: new URL(`${id}.png`, out).pathname});
  captures.push({id, title, width: 390, height: 844});
  console.log('Captured', id);
}
async function open(view) {
  // Use the app's delegated navigation in this disposable preview document.
  await page.evaluate(view => {
    const b = document.createElement('button'); b.dataset.open = view;
    document.body.append(b); b.click(); b.remove();
  }, view);
  await page.locator(`#v-${view}`).waitFor({state: 'visible'});
}
try {
  await page.goto(base);
  await capture('welcome', 'Welcome');
  await page.locator('#get-started').click();
  await page.locator('#v-home').waitFor({state: 'visible'});
  await page.waitForTimeout(4000);
  await capture('echo', 'Echo');
  await open('today'); await capture('today', 'Today');
  await page.locator('#today-add').click();
  await capture('commitment', 'Capture and recurring reminders');
  await page.locator('#sheet-experience').getByRole('button', {name: 'Close', exact: true}).click();
  await open('chat');
  await page.locator('#chat-input').fill('Help me plan a focused day.');
  await page.locator('#chat-input').press('Enter');
  await page.locator('.msg.echo .echo-markdown h2').waitFor();
  await page.locator('#chat-input').blur();
  await capture('chat', 'Chat');
  await page.locator('#conversation-open').click();
  await page.locator('.conversation-entry').first().waitFor();
  await capture('conversations', 'Conversations and folders');
  await page.locator('#sheet-experience').getByRole('button', {name: 'Close', exact: true}).click();
  await open('bots');
  await page.locator('#bots-member option').first().waitFor({state: 'attached'});
  await page.locator('#bots-goal').fill('Prepare a clear project plan from my notes.');
  await page.locator('#bots-member').selectOption('plan');
  await page.locator('#bots-run button[type=submit]').click();
  await page.locator('#bots-refresh').click();
  await page.locator('#bots-jobs .echo-markdown h2').waitFor();
  await capture('bots', 'Bots');
  for (const [id, title] of [['browser','Echo Browser'],['world','World Intelligence'],['memory','Saved'],['more','More'],['account','Recovery and sync'],['settings','Settings'],['mac','Optional Mac connection'],['missions','Mac missions'],['snap','Snap'],['briefing','Briefing'],['brain','Brain']]) {
    if (id === 'briefing') {
      await open('home'); await page.locator('#act-neural').click();
      await page.locator('#brief-body h3').first().waitFor();
    } else await open(id);
    await capture(id, title);
  }
  // The screen viewer needs a paired Mac. Capture its real initial markup,
  // without pairing to or recording anybody's desktop.
  await page.evaluate(() => {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'v-screen';
    document.body.dataset.view = 'screen';
  });
  await capture('screen', 'Mac screen viewer (unpaired preview)');
  await page.goto(base + '/admin');
  await page.locator('#login-note').getByText('Use the owner password.', {exact: false}).waitFor();
  await capture('admin-login', 'Admin sign-in');
  await page.locator('#password').fill(password);
  await page.locator('#login-button').click();
  await page.locator('#console').waitFor({state: 'visible'});
  await page.locator('#stats .stat').first().waitFor();
  await capture('admin-overview', 'Admin overview');
  for (const id of ['users','problems','activity']) {
    await page.locator(`nav [data-page="${id}"]`).click();
    await capture(`admin-${id}`, `Admin ${id}`);
  }
  if (errors.length) throw new Error('Preview errors: ' + errors.join('; '));
  if (!selected) await writeFile(new URL('manifest.json', out), JSON.stringify({source: 'Shipping pages with disposable local sample data; no real account or desktop captured.', captures}, null, 2) + '\n');
} finally {
  await browser.close(); server.closeAllConnections(); server.close();
}
