/*
 * Volume+ generic site probe.
 *
 * Loads the extension in headed browsers, navigates to URL (argv[2]), waits for
 * any media element, then drives the popup to 300% + Bass Boost and reports
 * whether the engine detected and bound the player element.
 *
 * Usage: npm i puppeteer-core && node probe.mjs https://music.youtube.com
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, '..');
const TARGET = process.argv[2] || 'https://music.youtube.com';

const browserPath = [
  process.env.VP_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
if (!browserPath) { console.error('no browser'); process.exit(2); }

setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(9); }, 150000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  userDataDir: join(os.tmpdir(), 'vp-probe-' + Date.now()),
  args: [
    '--no-first-run', '--disable-default-apps',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-extensions-except=' + EXT_DIR,
    '--load-extension=' + EXT_DIR,
  ],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  console.log('navigating to', TARGET, '…');
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();

  const found = await page.waitForFunction(() => {
    const all = Array.from(document.querySelectorAll('video, audio'));
    const live = all.filter((el) => el.readyState > 0 && el.currentSrc);
    return { all: all.length, live: live.length };
  }, { timeout: 40000, polling: 500 }).then((h) => h.jsonValue()).catch(() => ({ all: 0, live: 0 }));

  const detail = await page.evaluate(() => ({
    all: document.querySelectorAll('video, audio').length,
    tags: Array.from(document.querySelectorAll('video, audio')).map((el) => ({ tag: el.tagName, src: !!(el.currentSrc || el.src), paused: el.paused, vol: el.volume, cls: (el.className || '').toString().slice(0, 60) })),
    frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src.slice(0, 60) || '(blank)'),
  }));
  console.log('[media]', JSON.stringify(detail));
  if (!found.all) {
    console.log('RESULT: no media element found on this site');
    await browser.close();
    process.exit(0);
  }
  const t = await browser.waitForTarget((tb) => tb.type() === 'service_worker' && tb.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extId = new URL(t.url()).hostname;

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#slider');

  await popup.evaluate(() => {
    const s = document.getElementById('slider');
    s.value = '300';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    const b = document.getElementById('bassBtn');
    if (b.getAttribute('aria-checked') !== 'true') b.click();
  });
  await sleep(1500);

  const eng = await popup.$eval('#engine', (e) => e.textContent.trim());
  const host = await popup.$eval('#host', (e) => e.textContent.trim());
  const vols = await page.evaluate(() => Array.from(document.querySelectorAll('video, audio')).map((el) => ({ tag: el.tagName, vol: el.volume })));

  console.log(`RESULT: host=${host} engine='${eng}' element volumes=${JSON.stringify(vols)}`);
  await popup.close();
  await browser.close();
  process.exit(0);
} catch (err) {
  console.log('ERROR:', (err && err.message) || String(err));
} finally {
  await browser.close();
}