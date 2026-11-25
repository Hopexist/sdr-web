/**
 * @file Regenerates the README screenshots (docs/img) with headless Chrome over the DevTools protocol.
 * No npm packages; Node ≥ 22. Serve the folder first (python -m http.server 8000), then:
 *   CHROME=<browser exe> node ci/screenshots.mjs [outDir] [width] [height]
 * Writes <page>-<theme>.jpg for every page in light and dark at the given size (default 1280×800).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'google-chrome';
const BASE = (process.env.BASE || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PORT = +(process.env.PORT || 9223);
const OUT = process.argv[2] || 'docs/img';
const W = +(process.argv[3] || 1280), H = +(process.argv[4] || 800);
const PAGES = ['index', 'am', 'fm', 'qpsk', 'ber', 'tests'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sdr-shots-'))}`, 'about:blank'], { stdio: 'ignore' });

async function devtools(path, method = 'GET') {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method }); if (r.ok) { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } } } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not come up');
}

try {
  const target = await devtools(`/json/new?${encodeURI(BASE + '/index.html')}`, 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
  await sleep(1500);
  for (const theme of ['light', 'dark']) {
    // Same origin for every page: set the theme and mark every tour as seen, then load each page.
    await evaluate(`localStorage.setItem('sdr-web.theme', '${theme}');` +
      PAGES.map((p) => `localStorage.setItem('sdr-web.tour.${p}.html', 'done');`).join(''));
    for (const p of PAGES) {
      await send('Page.navigate', { url: `${BASE}/${p}.html` });
      await sleep(5000);
      if (p === 'tests') {   // the synchronous groups block the page; wait for the summary
        for (let i = 0; i < 60; i++) {
          const r = await evaluate(`!!document.getElementById('ci-result').dataset.done`);
          if (r.result?.result?.value) break;
          await sleep(2000);
        }
        await evaluate('scrollTo(0, 0)');
      }
      if (p === 'ber') {     // show a finished sweep (preset 1) rather than an empty plot
        await evaluate(`[].slice.call(document.querySelectorAll('button')).filter(function (b) { return /Run all/.test(b.textContent); })[0].click()`);
        await sleep(25000);
      }
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      const file = join(OUT, `${p}-${theme}.jpg`);
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(file);
    }
  }
  ws.close();
} finally {
  browser.kill();   // the browser this script started
}
