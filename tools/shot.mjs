// Headless Chrome/Edge for screenshots (checking screens, and the pictures in the user guide).
// As a tool: node tools/shot.mjs <url> <out.png> [--profile DIR] [--w 1366] [--h 800] [--js "code to run first"] [--wait ms] [--full]
// A profile folder keeps that "device's" data (its Velanzo set-up and database) between runs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('Could not connect to the browser'));
  });
}

let nextPort = 9340;
export async function openBrowser({ profile, width = 1366, height = 800, scale = 1, mobile = false } = {}) {
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) throw new Error('Chrome or Edge not found');
  const dir = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'vz-shot-'));
  fs.mkdirSync(dir, { recursive: true });
  const port = nextPort++;
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ }
  }
  if (!target) { proc.kill(); throw new Error('Browser did not start'); }
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  const page = {
    cdp,
    async goto(url, wait = 1500) {
      await cdp.send('Page.navigate', { url });
      await sleep(wait);
    },
    // a real reload (going to the same address with a different #… does not reload)
    async reload(url, wait = 2500) {
      if (url) await cdp.send('Runtime.evaluate', { expression: `history.replaceState(null, '', ${JSON.stringify(url)})` });
      await cdp.send('Page.reload', { ignoreCache: false });
      await sleep(wait);
    },
    async js(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async shot(file, { full = false, clip } = {}) {
      let params = { format: file.endsWith('.webp') ? 'webp' : 'png', quality: 82 };
      if (full) {
        const h = await page.js('return Math.ceil(document.documentElement.scrollHeight)');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: Math.max(height, h), deviceScaleFactor: scale, mobile });
        await sleep(300);
      }
      if (clip) params.clip = { ...clip, scale: 1 };
      const r = await cdp.send('Page.captureScreenshot', params);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      if (full) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    },
    async resize(w, h, m = mobile) { await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: m }); await sleep(250); },
  };
  return {
    page,
    async close() {
      try { cdp.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(600);
      // a browser profile in the temp folder is only for this run: remove it (each holds ~100 MB and they add up)
      if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()))) {
        for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(500); } }
      }
    },
  };
}

// Used as a command
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  const opt = (name, d) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : d; };
  const [url, out] = args;
  const b = await openBrowser({ profile: opt('profile'), width: Number(opt('w', 1366)), height: Number(opt('h', 800)), mobile: args.includes('--mobile') });
  try {
    await b.page.goto(url, Number(opt('wait', 2500)));
    if (opt('js')) console.log(JSON.stringify(await b.page.js(opt('js'))));
    await sleep(Number(opt('after', 400)));
    await b.page.shot(out, { full: args.includes('--full') });
    console.log('saved', out);
  } finally {
    await b.close();
  }
}
