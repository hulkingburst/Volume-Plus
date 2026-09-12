import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..');
const HARNESS = readFileSync(join(__dirname, 'harness.html'), 'utf8');
const PORT = 8932;

const browsers = [
  process.env.VP_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const browserPath = browsers.find((p) => existsSync(p));
if (!browserPath) { console.error('no browser'); process.exit(2); }
console.log('browser =', browserPath);
setTimeout(() => { console.log('WATCHDOG timeout'); process.exit(9); }, 70000);

const server = http.createServer((q, s) => { s.writeHead(200, {'Content-Type':'text/html'}); s.end(HARNESS); });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const launch = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  userDataDir: join(os.tmpdir(), 'vp-dbg-' + Date.now()),
  args: [
    '--no-first-run', '--disable-default-apps',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
  ],
});

const page = await launch.newPage();
page.on('console', (m) => console.log('[page console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[page error]', e.message));

await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
await page.waitForFunction(() => document.querySelector('#v') && document.querySelector('#v').readyState >= 1, { timeout: 20000 });

console.log('ctx state (page world) =', await page.evaluate(() => { try { return new AudioContext().state; } catch (e) { return 'ERR ' + e.message; } }));

// Gesture on page
await page.mouse.click(360, 240).catch((e) => console.log('click err', e.message));
await new Promise((r) => setTimeout(r, 400));

// Find extension
const sw = await launch.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
const extId = new URL(sw.url()).hostname;
console.log('extension id =', extId);

const popup = await launch.newPage();
popup.on('console', (m) => console.log('[popup console]', m.type(), m.text()));
popup.on('pageerror', (e) => console.log('[popup error]', e.message));
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForSelector('#slider');

console.log('popup state:', await popup.evaluate(() => ({
  pct: document.getElementById('pct').textContent,
  eng: document.getElementById('engine').textContent,
})));

// Set 300 via popup control
await popup.evaluate(() => {
  const s = document.getElementById('slider');
  s.value = '300';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1500));

console.log('popup after 300%:', await popup.evaluate(() => ({
  pct: document.getElementById('pct').textContent,
  eng: document.getElementById('engine').textContent,
  slider: document.getElementById('slider').value,
})));
console.log('page video volume =', await page.evaluate(() => document.querySelector('#v').volume));

// Try fullscreen via CDP user-gesture evaluation (avoids actionability hangs)
try {
  const client = await page.target().createCDPSession();
  await client.send('Runtime.evaluate', {
    expression: "document.querySelector('#fs').click()",
    userGesture: true,
    awaitPromise: false,
  });
  await new Promise((r) => setTimeout(r, 800));
  console.log('fullscreenElement =', await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id)); console.log('harness log:', await page.evaluate(() => document.getElementById('log').textContent));
} catch (e) {
  console.log('fullscreen attempt error:', e.message);
}

await launch.close();
server.close();
process.exit(0);
