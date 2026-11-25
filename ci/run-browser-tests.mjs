/**
 * @file CI runner: drives headless Chrome over the DevTools protocol (no npm packages; Node ≥ 22 for the
 * built-in WebSocket). Expects the site to be served at BASE (e.g. python3 -m http.server).
 *
 * 1. Opens tests.html and waits for <pre id="ci-result" data-done> ("PASS n/n" or "FAIL n/m").
 * 2. Loads every page once and fails on any uncaught exception, console error, or <html data-error>
 *    (set by the global error banner in js/ui/shell.js).
 *
 * Env: CHROME (browser executable, default google-chrome), BASE (default http://127.0.0.1:8000),
 *      PORT (DevTools port, default 9222), TEST_TIMEOUT_S (default 900).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'google-chrome';
const BASE = (process.env.BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PORT = +(process.env.PORT || 9222);
const TEST_TIMEOUT_S = +(process.env.TEST_TIMEOUT_S || 900);
const PAGES = ['index.html', 'am.html', 'fm.html', 'qpsk.html', 'ber.html'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sdr-ci-'))}`, 'about:blank'], { stdio: 'ignore' });

async function devtools(path, method = 'GET') {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
      if (r.ok) { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }   // /json/close answers in plain text
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not come up');
}

// Open a page in a new target; returns { eval(expr), problems[], close() }.
async function openPage(url) {
  const target = await devtools(`/json/new?${encodeURI(url)}`, 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(), problems = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails, src = d.url || d.stackTrace?.callFrames?.[0]?.url || '';
      // Only the site's own scripts: browser-internal or extension scripts (e.g. Edge's) are not ours.
      if (src.startsWith(BASE)) problems.push('exception: ' + (d.exception?.description || d.text) + ' (' + src + ')');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('log: ' + m.params.entry.text + (m.params.entry.url ? ' (' + m.params.entry.url + ')' : ''));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable');
  return {
    problems,
    eval: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value,
    close: async () => { ws.close(); await devtools(`/json/close/${target.id}`); }
  };
}

let failed = false;
try {
  await devtools('/json/version');

  // 1. tests.html
  const t = await openPage(`${BASE}/tests.html`);
  const t0 = Date.now(); let result = '';
  while (!result && (Date.now() - t0) / 1000 < TEST_TIMEOUT_S) {
    await sleep(2000);
    result = await t.eval(`(function(){ var e = document.getElementById('ci-result'); return e && e.dataset.done ? e.textContent : ''; })()`) || '';
  }
  const fails = await t.eval(`[].slice.call(document.querySelectorAll('#results tr.fail')).map(function(r){ return r.textContent.slice(0, 200); })`) || [];
  console.log(`tests.html: ${result || 'TIMEOUT'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  fails.forEach((f) => console.log('  FAIL ' + f));
  if (!/^PASS /.test(result)) failed = true;
  if (t.problems.length) { failed = true; t.problems.forEach((p) => console.log('  ' + p)); }
  await t.close();

  // 2. every page loads without errors
  for (const p of PAGES) {
    const pg = await openPage(`${BASE}/${p}`);
    await sleep(6000);
    const banner = await pg.eval(`document.documentElement.getAttribute('data-error')`);
    const ok = !banner && !pg.problems.length;
    console.log(`${p}: ${ok ? 'OK' : 'ERROR'}${banner ? ' banner: ' + banner : ''}`);
    pg.problems.forEach((x) => console.log('  ' + x));
    if (!ok) failed = true;
    await pg.close();
  }
} catch (e) {
  console.error('runner error:', e);
  failed = true;
} finally {
  browser.kill();   // the browser this script started
}
process.exit(failed ? 1 : 0);
