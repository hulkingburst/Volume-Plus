/*
 * Volume+ automated test
 *
 * Launch a real (headed) Chromium with the extension loaded, opens the
 * actual popup, and verifies:
 *   1. Extension gain is a multiplier applied ON TOP of the site's own
 *      element.volume (which is never rewritten): 40% through the graph,
 *      300% boost, and lowering the site volume mid-boost is preserved.
 *   2. >100% + Bass Boost engages the Web Audio path.
 *   3. FULLSCREEN IS NEVER BROKEN: enter/exit/re-enter fullscreen while the
 *      extension is actively controlling audio, including changing volume
 *      and bass while inside fullscreen (the Volume Master repro case).
 *   4. The page DOM is left untouched (no clones/wrappers).
 *   5. Settings survive a page reload (dynamically re-created media).
 *   6. NEW UI: Equalizer tab (band chip updates, persisted across reload) and
 *      Settings tab (Reduce noise toggle enables its strength slider).
 *
 * Headed browser is required — headless Edge/Chrome refuse requestFullscreen.
 *
 * Usage:  npm i puppeteer-core && node automated.mjs
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, '..');
const HARNESS = readFileSync(join(__dirname, 'harness.html'), 'utf8');
const PORT = 8931;

const BROWSER_CANDIDATES = [
  process.env.VP_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  →  ' + extra : ''}`);
};

function findBrowser() {
  for (const c of BROWSER_CANDIDATES) if (c && existsSync(c)) return c;
  return null;
}

function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HARNESS);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function getExtensionId(browser) {
  const t = await browser.waitForTarget(
    (tb) => tb.type() === 'service_worker' && tb.url().startsWith('chrome-extension://'),
    { timeout: 15000 },
  );
  return new URL(t.url()).hostname;
}

/* Trusted input: real CDP mouse events → genuine user activation. */
async function trustedClick(page, selector) {
  const cdp = await page.createCDPSession();
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }, selector);
  await sleep(200);
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!box) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

async function openPopup(browser, extensionId) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForSelector('#slider');
  // popup.init() renders DEFAULTS synchronously, then hydrates from the tab's
  // snapshot asynchronously — wait until that real snapshot has arrived.
  await page.waitForFunction(
    () => {
      const e = document.querySelector('#engine');
      return e && e.textContent.includes('audio source');
    },
    { timeout: 10000 },
  );
  return page;
}

async function setVolume(popup, percent) {
  await popup.evaluate((val) => {
    const s = document.getElementById('slider');
    s.value = String(val);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, percent);
  await sleep(700);
}

async function setBass(popup, { enabled, db }) {
  await popup.evaluate(({ enabled, db }) => {
    if (enabled !== undefined) {
      const btn = document.getElementById('bassBtn');
      if (btn.getAttribute('aria-checked') !== String(enabled)) btn.click();
    }
    if (db !== undefined) {
      const s = document.getElementById('bassSlider');
      s.value = String(db);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { enabled, db });
  await sleep(700);
}

const popupText = (popup, id) => popup.$eval(id, (el) => el.textContent.trim());
const fullscreenId = (page) => page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id);
const harnessLog = (page) => page.evaluate(() => document.getElementById('log').textContent);

async function enterFullscreen(page) {
  await page.bringToFront();
  await sleep(300);
  if (!(await trustedClick(page, '#fs'))) throw new Error('no #fs button');
  await sleep(800);
}

async function exitFullscreen(page) {
  await page.evaluate(() => { if (document.fullscreenElement) return document.exitFullscreen(); });
  await sleep(700);
}

async function run(browser, page) {
  step('harness page reachable over http', page.url().startsWith('http://127.0.0.1'), page.url());

  await page.waitForFunction(
    () => document.querySelector('#v') && document.querySelector('#v').readyState >= 1,
    { timeout: 20000 },
  );

  const baseline = await page.evaluate(() => ({
    children: document.body.children.length,
    parent: document.querySelector('#v').parentElement.id || document.querySelector('#v').parentElement.tagName,
  }));

  const extensionId = await getExtensionId(browser);
  const popup = await openPopup(browser, extensionId);

  // 1. defaults: 100%, native path
  const p0 = await popupText(popup, '#pct');
  const e0 = await popupText(popup, '#engine');
  step('popup reports 100% · native by default', p0 === '100%' && e0.includes('native'), `${p0} | ${e0}`);

  // 2. sub-100% is a gain multiplier on top — the site's own volume is untouched
  await setVolume(popup, 40);
  const v40 = await page.evaluate(() => document.querySelector('#v').volume);
  const e40 = await popupText(popup, '#engine');
  step('40% multiplies via Web Audio, leaving the site volume untouched',
    Math.abs(v40 - 1) < 0.01 && e40.includes('Web Audio'), `volume=${v40} | ${e40}`);

  // 3. gesture on the page so the AudioContext is allowed to run
  await page.bringToFront();
  await sleep(300);
  await trustedClick(page, '#fsout');

  // 4. >100% boosts on top of the site volume (never resets element.volume)
  await setVolume(popup, 300);
  const v300 = await page.evaluate(() => document.querySelector('#v').volume);
  const e300 = await popupText(popup, '#engine');
  step('300% boosts via Web Audio on top of the site volume',
    Math.abs(v300 - 1) < 0.01 && e300.includes('Web Audio'), `volume=${v300} | ${e300}`);

  // 5. THE regression: lowering the SITE volume mid-boost must stick (no reset
  //    to full blast ~1s later, which the old engine did).
  await page.evaluate(() => { document.querySelector('#v').volume = 0.4; });
  await sleep(1800); // well past the 1200 ms reassert interval
  const siteVolHeld = await page.evaluate(() => document.querySelector('#v').volume);
  const stillBoosted = await page.evaluate(() => document.querySelector('#v').volume);
  step('lowering the site volume while boosted is preserved (not reset to max)',
    Math.abs(siteVolHeld - 0.4) < 0.01, `site volume still ${stillBoosted} with 300% engaged`);

  // 5. fullscreen while the extension controls audio
  await enterFullscreen(page);
  const fs1 = await fullscreenId(page);
  step('fullscreen enters while Volume+ controls audio', fs1 === 'v',
    `fullscreen=${fs1}${fs1 !== 'v' ? ' | log: ' + (await harnessLog(page)) : ''}`);

  // 6. volume + bass changes DURING fullscreen
  await setVolume(popup, 150);
  await setBass(popup, { enabled: true, db: 10 });
  const fs2 = await fullscreenId(page);
  const pctDuring = await popupText(popup, '#pct');
  const bassOn = await popup.$eval('#bassBtn', (b) => b.getAttribute('aria-checked'));
  step('fullscreen survives live volume + bass changes (150%, bass→10 dB)',
    fs2 === 'v' && pctDuring === '150%' && bassOn === 'true', `fullscreen=${fs2} | ${pctDuring} | bass=${bassOn}`);

  // 7. exit → re-enter immediately → exit (the Volume Master repro case)
  await exitFullscreen(page);
  const fs3 = await fullscreenId(page);
  step('fullscreen exits cleanly', fs3 === null);

  await enterFullscreen(page);
  const fs4 = await fullscreenId(page);
  const vRe = await page.evaluate(() => document.querySelector('#v').volume);
  // Site volume (0.4 from step 5) must survive the fullscreen dance untouched.
  step('re-entering fullscreen right after exit works (Volume Master bug case)',
    fs4 === 'v' && Math.abs(vRe - 0.4) < 0.01, `fullscreen=${fs4} | volume=${vRe}`);
  await exitFullscreen(page);

  // 8. quiet-but-audible low range while bound
  await setVolume(popup, 5);
  const p5 = await popupText(popup, '#pct');
  step('5% (quiet but audible) accepted', p5 === '5%', p5);

  // 9. DOM untouched
  const after = await page.evaluate(() => ({
    children: document.body.children.length,
    parent: document.querySelector('#v').parentElement.id || document.querySelector('#v').parentElement.tagName,
  }));
  step('no DOM mutation / clones / wrappers',
    after.children === baseline.children && after.parent === baseline.parent, JSON.stringify(after));

  // 9b. Equalizer tab: move a band, chip must update
  await popup.evaluate(() => { document.getElementById('tab-eq').click(); });
  await popup.evaluate(() => {
    const b = document.querySelectorAll('#eq .band input[type=range]')[1];
    b.value = '6';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    b.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(700);
  const eqChip = await popup.$eval('#eq .band:nth-child(2) .db', (el) => el.textContent.trim());
  step('EQ band 170 Hz set to +6 dB via the Equalizer tab', eqChip === '+6 dB', eqChip);

  // 9c. Settings tab: Reduce noise toggle arms its strength slider
  await popup.evaluate(() => { document.getElementById('tab-settings').click(); });
  await popup.evaluate(() => { document.getElementById('noiseBtn').click(); });
  await sleep(700);
  const noiseOn = await popup.$eval('#noiseBtn', (b) => b.getAttribute('aria-checked'));
  const noiseArmed = await popup.$eval('#noiseSlider', (s) => !s.disabled);
  step('Reduce noise toggle enables the strength slider', noiseOn === 'true' && noiseArmed, `checked=${noiseOn}`);

  // 10. persistence: final state survives a reload & dynamically rebuilt media
  await setVolume(popup, 150);
  await setBass(popup, { enabled: true, db: 10 });
  await popup.evaluate(() => {
    document.getElementById('noiseSlider').value = '65';
    document.getElementById('noiseSlider').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('noiseSlider').dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  await page.bringToFront();
  await sleep(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#v', { timeout: 20000 });
  await sleep(4000);
  if (popup) await popup.close();

  const popup2 = await openPopup(browser, extensionId);
  const pAfter = await popupText(popup2, '#pct');
  const bAfter = await popup2.$eval('#bassBtn', (b) => b.getAttribute('aria-checked'));
  const dbAfter = await popupText(popup2, '#bassDb');
  const eAfter = await popupText(popup2, '#engine');
  step('settings persist across reload (150%, bass on, 10 dB, Web Audio)',
    pAfter === '150%' && bAfter === 'true' && dbAfter === '10 dB' && eAfter.includes('Web Audio'),
    `${pAfter} | ${bAfter} | ${dbAfter} | ${eAfter}`);

  const eqAfter = await popup2.evaluate(() => {
    document.getElementById('tab-eq').click();
    return document.querySelector('#eq .band:nth-child(2) .db').textContent.trim();
  });
  const noiseAfter = await popup2.evaluate(() => {
    document.getElementById('tab-settings').click();
    return {
      checked: document.getElementById('noiseBtn').getAttribute('aria-checked'),
      strength: document.getElementById('noiseVal').textContent,
    };
  });
  step('EQ curve + noise setting persist across reload (+6 dB, on, 65%)',
    eqAfter === '+6 dB' && noiseAfter.checked === 'true' && noiseAfter.strength === '65%',
    `${eqAfter} | ${noiseAfter.checked} | ${noiseAfter.strength}`);
  await popup2.close();
}

(async () => {
  setTimeout(() => { console.error('WATCHDOG: timeout'); process.exit(9); }, 240000);

  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No Chromium browser found. Set VP_BROWSER to a chrome/edge exe.');
    process.exit(2);
  }
  console.log(`Browser: ${browserPath}`);

  const server = await serve();
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: false,
    userDataDir: join(os.tmpdir(), `vp-test-${Date.now()}`),
    args: [
      '--no-first-run',
      '--disable-default-apps',
      '--disable-features=Translate,MediaRouter',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-extensions-except=' + EXT_DIR,
      '--load-extension=' + EXT_DIR,
    ],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/harness.html`);
    await run(browser, page);
  } catch (err) {
    step('uncaught test error', false, (err && err.message) || String(err));
  } finally {
    try { await browser.close(); } catch (_) {}
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length
    ? `\n${results.length - failed.length}/${results.length} passed — failures:\n  ${failed.map((f) => '✗ ' + f.name).join('\n  ')}`
    : `\nAll ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();