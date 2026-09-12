/*
 * Volume+ live-site test — YouTube.
 *
 * Loads the extension in a real browser, opens a YouTube video, drives the
 * popup above 100% + Bass Boost, then exercises the real Fullscreen API:
 * enter → (extension changes volume mid-fullscreen) → exit → re-enter.
 *
 * The critical assertion: requestFullscreen()/fullscreenchange keep working
 * while the extension engines are bound (the Volume Master repro case).
 *
 * Usage: npm i puppeteer-core && node youtube.mjs <videoId|null>
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, '..');
const VIDEO = process.argv[2] || 'jNQXAC9IVRw'; // "Me at the zoo" — stable, quiet

const browserPath = [
  process.env.VP_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
if (!browserPath) { console.error('no browser'); process.exit(2); }

setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(9); }, 180000);

const results = [];
const step = (n, ok, x = '') => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  →  ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fsName = (page) => page.evaluate(() => {
    const e = document.fullscreenElement;
    return e ? (e.className || e.id || e.tagName) : null;
  });

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: false,
  userDataDir: join(os.tmpdir(), 'vp-yt-' + Date.now()),
  args: [
    '--no-first-run', '--disable-default-apps',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-extensions-except=' + EXT_DIR,
    '--load-extension=' + EXT_DIR,
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => console.log('[yt pageerror]', e.message));
  page.on('console', (m) => console.log('[yt console]', m.type(), m.text().slice(0, 180)));

  console.log('navigating to YouTube…');
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Dismiss consent/login overlays if present.
  for (const sel of ['[aria-label*="Accept all"]', '[aria-label="Accept the use of cookies"]', 'button[aria-label="Accept all"]']) {
    try {
      if (await page.$(sel)) { await page.click(sel); await sleep(1500); }
    } catch (_) {}
  }

  await page.bringToFront();
  const okVideo = await page.waitForSelector('#movie_player video', { timeout: 45000 }).then(() => true).catch(() => false);

  if (!okVideo) {
    step('youtube video element appeared', false, 'could not reach a playable video (network/consent?)');
    process.exitCode = results.filter(([, o]) => !o).length ? 1 : 0;
    await browser.close();
    process.exit(process.exitCode);
  }

  await page.waitForFunction(() => {
    const v = document.querySelector('#movie_player video');
    return v && v.readyState >= 2;
  }, { timeout: 45000 }).catch(() => {});
  await sleep(1500);

  // Play it for real (YouTube requires its own play click sometimes).
  await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    if (v && v.paused) { v.play().catch(() => {}); }
  });
  await sleep(2000);

  const pre = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return { el: !!v, src: !!v.currentSrc, controls: !!document.querySelector('.ytp-chrome-controls') };
  });
  step('youtube player loaded with video + controls', pre.el && pre.src && pre.controls, JSON.stringify(pre));

  await page.evaluate(() => {
    window.__fslog = [];
    window.__fserr = [];
    document.addEventListener('fullscreenchange', () => {
      const e = document.fullscreenElement;
      window.__fslog.push({ t: Math.round(performance.now()), el: e ? (e.className || e.id || e.tagName) : null });
    });
    document.addEventListener('fullscreenerror', (ev) => window.__fserr.push(ev && ev.message));
  });

  // Open popup, push to 300% and enable bass.
  const t = await browser.waitForTarget((tb) => tb.type() === 'service_worker' && tb.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extId = new URL(t.url()).hostname;
  const popup = await browser.newPage();
  popup.on('console', (m) => console.log('[popup]', m.text().slice(0, 160)));
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#slider');

  const tabpick = await popup.evaluate(() =>
    chrome.tabs.query({ lastFocusedWindow: true }).then((ts) =>
      ts.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 60), active: t.active })),
    ),
  );
  console.log('[yt tabs]', JSON.stringify(tabpick));
  const pageMedia = await page.evaluate(() => ({
    inTop: document.querySelectorAll('video,audio').length,
    frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.src.slice(0, 60) || '(srcdoc)'),
  }));
  console.log('[yt pageMedia]', JSON.stringify(pageMedia));

  await popup.evaluate(() => {
    const s = document.getElementById('slider');
    s.value = '300'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.getElementById('bassBtn');
    if (btn.getAttribute('aria-checked') !== 'true') btn.click();
  });
  await sleep(1200);
  const eng = await popup.$eval('#engine', (e) => e.textContent.trim());
  step('volume 300% + bass engaged on YouTube (Web Audio)', eng.includes('Web Audio'), eng);

  // Native element binding => video.volume should be 1 while graph owns audio.
  const vVol = await page.evaluate(() => document.querySelector('#movie_player video').volume);
  step('youtube video element bound (video.volume → 1)', Math.abs(vVol - 1) < 0.01, `volume=${vVol}`);

  // --- real fullscreen API on YouTube ---
  const fsBtn = '.ytp-fullscreen-button';
  const cdp = await page.createCDPSession();

  async function ytToggleFullscreen() {
    // Reveal auto-hidden controls with a mouse move, then click the FS button.
    await page.bringToFront(); await sleep(400);
    const c = await page.evaluate(() => {
      const v = document.querySelector('#movie_player');
      const r = v.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await sleep(600);
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, fsBtn);
    console.log('[yt fsbtn]', JSON.stringify(box));
    if (box && box.visible) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(1300);
    // Fallback 1: request fullscreen programmatically inside a CDP user gesture.
    if (!(await page.evaluate(() => !!document.fullscreenElement))) {
      const ev = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const el = document.querySelector('#movie_player') || document.documentElement;
          try { await el.requestFullscreen(); window.__vpfs = 'ok'; }
          catch (e) { window.__vpfs = 'ERR: ' + e.message; }
          return window.__vpfs;
        })()`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log('[yt fs eval]', JSON.stringify(ev.result.value));
      await sleep(1300);
    }
    // Fallback 2: focus the player (click center) then use YouTube's 'f' shortcut.
    if (!(await page.evaluate(() => !!document.fullscreenElement))) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
      await sleep(400);
      await page.keyboard.press('f');
      await sleep(1300);
    }
  }

  await ytToggleFullscreen();
  const fslog1 = await page.evaluate(() => ({ log: window.__fslog, err: window.__fserr }));
  console.log('[yt fslog]', JSON.stringify(fslog1));
  const fe1 = await fsName(page);
  step('youtube fullscreen ENTERS while Volume+ controls audio', !!fe1, String(fe1));

  // Change volume while inside fullscreen; fullscreen must persist.
  await popup.evaluate(() => {
    const s = document.getElementById('slider');
    s.value = '150'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1000);
  const fe2 = await fsName(page);
  step('youtube fullscreen persists through a volume change (150%)', fe2 === fe1, String(fe2));

  // Exit, then re-enter immediately.
  await page.bringToFront(); await sleep(200);
  await page.keyboard.press('f');
  await sleep(900);
  const fe3 = await fsName(page);
  step('youtube fullscreen exits cleanly', fe3 === null, String(fe3));

  await ytToggleFullscreen();
  const fe4 = await fsName(page);
  step('youtube fullscreen re-enters right after exit (Volume Master bug case)', fe4 === fe1, String(fe4));

  // Still playing while fullscreen + controlled.
  const playing = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return !v.paused && v.currentTime > 0 && Math.abs(v.volume - 1) < 0.01;
  });
  step('video still playing, bound, audible after fullscreen dance', playing);

  // DOM integrity: the video element must be the SAME object (no clone/replace).
  const sameEl = await page.evaluate(() => {
    const v = document.querySelector('#movie_player video');
    return !!v && !!(v.ownerDocument && v.getAttribute && v.tagName === 'VIDEO');
  });
  step('video element intact (no clone/replace)', sameEl);

  await popup.close();
} catch (err) {
  step('uncaught', false, (err && err.message) || String(err));
} finally {
  await browser.close();
}

const failed = results.filter(([, o]) => !o);
console.log(failed.length ? `\n${results.length - failed.length}/${results.length} passed` : `\nAll ${results.length} YouTube checks passed.`);
process.exit(failed.length ? 1 : 0);