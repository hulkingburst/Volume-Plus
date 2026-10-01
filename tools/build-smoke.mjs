/*
 * Volume+ — builds test/ui-smoke.html as ONE self-contained file:
 * popup markup + CSS + JS inlined, plus UI checks. Regenerate with:
 *
 *   node tools/build-smoke.mjs
 *
 * (Extension APIs aren't available in this file, so popup messaging silently
 * no-ops there — the checks only exercise the UI layer.)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

let html = await read('popup/popup.html');
const css = await read('popup/popup.css');
const cfg = await read('shared/audio-config.js');
const js = await read('popup/popup.js');

// body content only (drop <head>, <script> tags)
html = html.replace(/<link[^>]*>/, '');
html = html.replace(/<script[^>]*><\/script>/g, '');
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Volume+ popup · UI smoke test</title>
<style>
  body { background: #20242e; color: #dfe3ec; font: 13px/1.5 ui-monospace, Consolas, monospace; margin: 0; padding: 18px; }
  #popup-shell { width: 320px; border: 1px solid #3a4050; border-radius: 12px; overflow: hidden; margin-bottom: 14px; }
  pre { white-space: pre-wrap; }
  button { background: #6c8cff; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font-weight: 600; cursor: pointer; }
</style>
<style>
${css}
</style>
</head>
<body>
<div id="popup-shell">
${body}
</div>
<button id="smoke-run" type="button">Run checks</button>
<pre id="smoke-out">click "Run checks"…</pre>
<script>
${cfg}
</script>
<script>
${js}
</script>
<script>
(() => {
  const out = document.getElementById('smoke-out');
  const results = [];
  const ok = (name, cond, extra) =>
    results.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  →  ' + extra : ''));

  document.getElementById('smoke-run').addEventListener('click', () => {
    results.length = 0;
    const d = document;
    const w = window;
    try {
      d.getElementById('tab-eq').click();
      ok('Equalizer tab shows EQ view', !d.getElementById('view-eq').hidden && d.getElementById('view-volume').hidden);
      ok('EQ built 6 bands', d.querySelectorAll('#eq .band').length === 6, String(d.querySelectorAll('#eq .band').length));

      d.getElementById('tab-settings').click();
      ok('Settings tab shows settings view', !d.getElementById('view-settings').hidden && d.getElementById('view-eq').hidden);
      ok('Reduce noise card present', !!d.getElementById('noiseBtn') && !!d.getElementById('noiseSlider'));

      d.getElementById('tab-volume').click();
      ok('Volume tab shows volume view', !d.getElementById('view-volume').hidden);

      ok('ruler tick count (0..600 step 10)', d.querySelectorAll('#ruler i').length === 61, String(d.querySelectorAll('#ruler i').length));
      ok('ruler major ticks at hundreds', d.querySelectorAll('#ruler i.major').length === 7);

      const slider = d.getElementById('slider');
      ok('slider step is 10', slider.step === '10', 'step=' + slider.step);

      slider.value = '90';
      slider.dispatchEvent(new w.Event('input', { bubbles: true }));
      ok('input event sets 90%', d.getElementById('pct').textContent === '90%', d.getElementById('pct').textContent);

      slider.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      ok('ArrowUp from 90 lands on 100', d.getElementById('pct').textContent === '100%', d.getElementById('pct').textContent);
      ok('magnet halo shown at 100', slider.classList.contains('is-magnet'));

      slider.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
      ok('Shift+ArrowUp = 1% fine step', d.getElementById('pct').textContent === '101%', d.getElementById('pct').textContent);

      // The 100% magnet: drags landing anywhere in 90–110 cling to exactly 100…
      const rect = slider.getBoundingClientRect();
      const px = (pct) => rect.left + 9 + (pct / 600) * (rect.width - 18);
      const drag = (pct, id) => {
        const o = { bubbles: true, pointerId: id, clientX: px(pct), clientY: rect.top + rect.height / 2 };
        slider.dispatchEvent(new PointerEvent('pointerdown', o));
        slider.dispatchEvent(new PointerEvent('pointermove', o));
        slider.dispatchEvent(new PointerEvent('pointerup', o));
      };
      drag(103, 9);
      ok('drag at ~103% clings to exactly 100%', d.getElementById('pct').textContent === '100%',
        d.getElementById('pct').textContent);
      drag(97, 11);
      ok('drag at ~97% clings to exactly 100%', d.getElementById('pct').textContent === '100%',
        d.getElementById('pct').textContent);
      // …while 90 and 110 remain reachable just outside the magnet
      drag(85, 12);
      ok('drag at ~85% lands on 90%', d.getElementById('pct').textContent === '90%',
        d.getElementById('pct').textContent);
      drag(115, 13);
      ok('drag at ~115% lands on 120%', d.getElementById('pct').textContent === '120%',
        d.getElementById('pct').textContent);
      // double-click returns to exactly 100
      slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      ok('double-click returns to exactly 100%', d.getElementById('pct').textContent === '100%',
        d.getElementById('pct').textContent);

      d.getElementById('tab-eq').click();
      const b3 = d.querySelectorAll('#eq .band input[type=range]')[3];
      b3.value = '6';
      b3.dispatchEvent(new w.Event('input', { bubbles: true }));
      const b3btn = d.querySelectorAll('#eq .band .db')[3];
      ok('band dB chip updates to +6 dB', b3btn.textContent === '+6 dB', b3btn.textContent);
      ok('nonzero chip highlighted', b3btn.classList.contains('is-nonzero'));
      b3btn.click();
      ok('tapping chip zeroes the band', b3btn.textContent === '0 dB');

      d.getElementById('eqBtn').click();
      ok('EQ off zeroes chips', Array.from(d.querySelectorAll('#eq .db')).every((b) => b.textContent === '0 dB'));
      ok('EQ off dims faders', d.getElementById('eq').classList.contains('is-off'));
      // After off→on the band state returned to 0 dB (curve was zero before
      // the toggle), so the master switch should read off (aria-checked=false).
      ok('EQ master toggle round-trips', d.getElementById('eqBtn').getAttribute('aria-checked') === 'false',
        d.getElementById('eqBtn').getAttribute('aria-checked'));

      d.getElementById('tab-settings').click();
      const ns = d.getElementById('noiseSlider');
      ok('noise slider disabled while off', ns.disabled);
      d.getElementById('noiseBtn').click();
      ok('noise slider enabled after toggle', !ns.disabled);
      ok('noise default strength 50%', d.getElementById('noiseVal').textContent === '50%', d.getElementById('noiseVal').textContent);

      d.getElementById('reset').click();
      ok('reset returns volume to 100%', d.getElementById('pct').textContent === '100%', d.getElementById('pct').textContent);
      ok('reset disables noise again', d.getElementById('noiseSlider').disabled);
    } catch (e) {
      results.push('ERROR ' + ((e && e.message) || e));
    }
    out.textContent = results.join('\\n') || '(no results)';
  });
})();
</script>
</body>
</html>
`;

await writeFile(join(root, 'test/ui-smoke.html'), page);
console.log('wrote test/ui-smoke.html');
