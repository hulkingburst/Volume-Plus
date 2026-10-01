/*
 * Volume+ — popup logic.
 *
 * Tabs: Volume / Equalizer / Settings. Volume slider: 10 % detents with a
 * magnetic 100 % stop (drag near 100 % and it clings, so the exact spot is
 * trivial to hit); hold Shift with the arrows for 1 % precision. The EQ is
 * six vertical faders (−12 … +12 dB per band) with one-tap presets, and
 * Settings holds Reduce noise. Everything is pushed to the content-script
 * engine with a short debounce.
 */
(() => {
  'use strict';

  const CFG = (typeof VP_AUDIO !== 'undefined' && VP_AUDIO) || {
    BANDS: [
      { freq: 60, type: 'lowshelf', label: '60', unit: 'Hz' },
      { freq: 170, type: 'peaking', label: '170', unit: 'Hz', q: 1.1 },
      { freq: 350, type: 'peaking', label: '350', unit: 'Hz', q: 1.1 },
      { freq: 1000, type: 'peaking', label: '1', unit: 'kHz', q: 1.1 },
      { freq: 3500, type: 'peaking', label: '3.5', unit: 'kHz', q: 1.1 },
      { freq: 10000, type: 'highshelf', label: '10', unit: 'kHz' },
    ],
    PRESETS: [
      { id: 'flat', name: 'Flat', eq: [0, 0, 0, 0, 0, 0] },
    ],
    NOISE: { DEF: 50, MAX: 80 },
  };
  const BANDS = CFG.BANDS;
  const PRESETS = CFG.PRESETS || [{ id: 'flat', name: 'Flat', eq: [0, 0, 0, 0, 0, 0] }];
  const NOISE_MAX = CFG.NOISE.MAX || 80;

  const DEFAULTS = {
    volume: 1,
    bass: false,
    bassDb: 8,
    eq: BANDS.map(() => 0),
    noise: { on: false, strength: 50 },
  };
  const BASS_MAX = 12;

  // --- snapping constants -------------------------------------------------
  const VMIN = 0, VMAX = 600;      // slider range, percent
  const SNAP = 10;                 // hard detent every 10 %
  const MAGNET = 100;              // the % position of the magnetic stop
  const THUMB_PX = 18;             // keep in sync with CSS thumb size

  const els = {
    pct: document.getElementById('pct'),
    meta: document.getElementById('meta'),
    slider: document.getElementById('slider'),
    ruler: document.getElementById('ruler'),
    bassBtn: document.getElementById('bassBtn'),
    bassSlider: document.getElementById('bassSlider'),
    bassDb: document.getElementById('bassDb'),
    eqWrap: document.getElementById('eq'),
    eqBtn: document.getElementById('eqBtn'),
    eqFlatten: document.getElementById('eqFlatten'),
    noiseBtn: document.getElementById('noiseBtn'),
    noiseSlider: document.getElementById('noiseSlider'),
    noiseVal: document.getElementById('noiseVal'),
    engine: document.getElementById('engine'),
    engineRow: document.getElementById('engineRow'),
    host: document.getElementById('host'),
    reset: document.getElementById('reset'),
  };

  let tabId = null;
  let state = {
    volume: DEFAULTS.volume,
    bass: DEFAULTS.bass,
    bassDb: DEFAULTS.bassDb,
    eq: DEFAULTS.eq.slice(),
    eqOn: true,
    noise: { ...DEFAULTS.noise },
    media: 0, graphs: 0, ctx: 'none',
  };
  let savedEq = null;   // curve kept while the EQ master toggle is off
  let sendTimer = 0;
  let dragging = false;
  let activePointerId = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pctOf = (v) => Math.round(clamp(v, 0, 6) * 100);
  const eqEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_) { return ''; }
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (tabId == null) return reject(new Error('no target tab'));
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  function push() {
    return send({
      type: 'vp:set',
      volume: state.volume,
      bass: state.bass,
      bassDb: state.bassDb,
      eq: state.eqOn ? state.eq.slice() : BANDS.map(() => 0),
      eqOn: state.eqOn,
      noise: { ...state.noise },
    }).then((resp) => {
      if (resp) reflectSnapshot(resp);
    }).catch(() => {});
  }

  function queuePush() {
    window.clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => { sendTimer = 0; void push(); }, 120);
  }

  function flushPush() {
    window.clearTimeout(sendTimer);
    sendTimer = 0;
    void push();
  }

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */
  const views = {
    volume: document.getElementById('view-volume'),
    eq: document.getElementById('view-eq'),
    settings: document.getElementById('view-settings'),
  };

  function showView(name) {
    for (const [key, view] of Object.entries(views)) {
      const on = key === name;
      view.classList.toggle('is-active', on);
      view.hidden = !on;
    }
    for (const t of document.querySelectorAll('.tab')) {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    }
  }

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => showView(t.dataset.view));
  }

  /* ------------------------------------------------------------------ *
   * Tick ruler under the volume slider
   * ------------------------------------------------------------------ */
  (function buildRuler() {
    if (!els.ruler) return;
    const frag = document.createDocumentFragment();
    for (let p = VMIN; p <= VMAX; p += SNAP) {
      const tick = document.createElement('i');
      tick.className = p % 100 === 0 ? 'major' : '';
      tick.style.left = (p / VMAX) * 100 + '%';
      frag.appendChild(tick);
    }
    els.ruler.appendChild(frag);
  })();

  /* ------------------------------------------------------------------ *
   * Equalizer band UI
   * ------------------------------------------------------------------ */
  const bandRefs = [];

  function buildEq() {
    if (!els.eqWrap) return;
    els.eqWrap.textContent = '';
    bandRefs.length = 0;
    BANDS.forEach((b, i) => {
      const band = document.createElement('div');
      band.className = 'band';

      const dbBtn = document.createElement('button');
      dbBtn.type = 'button';
      dbBtn.className = 'db';
      dbBtn.textContent = '0 dB';
      dbBtn.title = 'Tap to zero this band';
      dbBtn.addEventListener('click', () => { setBand(i, 0); flushPush(); });

      const input = document.createElement('input');
      input.type = 'range';
      input.className = 'slider';
      input.min = '-12';
      input.max = '12';
      input.step = '1';
      input.value = '0';
      input.setAttribute('aria-label', `Equalizer band ${b.label} ${b.unit}`);
      input.addEventListener('input', () => setBand(i, Number(input.value)));
      input.addEventListener('change', () => flushPush());

      const hz = document.createElement('span');
      hz.className = 'hz';
      hz.textContent = `${b.label} ${b.unit}`;

      band.append(input, dbBtn, hz);  // input first: .db chip uses top:-16px (CSS sibling order)
      els.eqWrap.appendChild(band);
      bandRefs.push({ input, dbBtn, hz });
    });
  }

  function setBand(i, db) {
    state.eq[i] = db;
    const { input, dbBtn } = bandRefs[i];
    input.value = String(db);
    dbBtn.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    dbBtn.classList.toggle('is-nonzero', db !== 0);
    queuePush();
  }

  buildEq();

  /* Presets: one-tap curve chips. The active chip is marked by comparing the
   * live curve (after the off-toggle zeros / restores it) against each preset. */
  const presetBtns = [];
  function buildPresets() {
    const wrap = document.getElementById('eqPresets');
    if (!wrap) return;
    wrap.textContent = '';
    presetBtns.length = 0;
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.textContent = p.name;
      b.title = `Load the ${p.name} curve`;
      b.addEventListener('click', () => {
        state.eq = p.eq.slice();
        if (!state.eqOn) {
          state.eqOn = true;   // picking a preset turns the EQ on
          savedEq = null;
        }
        render();
        flushPush();
      });
      wrap.appendChild(b);
      presetBtns.push({ btn: b, eq: p.eq, name: p.name });
    });
  }
  buildPresets();

  function activePresetName() {
    if (!state.eqOn) return null;
    for (const p of presetBtns) if (eqEq(state.eq, p.eq)) return p.name;
    return null;
  }

  els.eqBtn.addEventListener('click', () => {
    if (state.eqOn) {
      savedEq = state.eq.slice();
      state.eq = BANDS.map(() => 0);
    } else if (savedEq) {
      state.eq = savedEq;
      savedEq = null;
    }
    state.eqOn = !state.eqOn;
    render();
    flushPush();
  });

  els.eqFlatten.addEventListener('click', () => {
    state.eq = BANDS.map(() => 0);
    savedEq = null;
    render();
    flushPush();
  });

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function render() {
    const v = pctOf(state.volume);
    const mult = state.volume.toFixed(2).replace(/\.?0+$/, '');

    els.pct.textContent = v + '%';
    if (v === 0) els.meta.textContent = 'muted';
    else if (v < 100) els.meta.textContent = `quiet · ${v}% of normal`;
    else if (v === 100) els.meta.textContent = 'normal volume';
    else els.meta.textContent = `boosted · ×${mult}`;

    els.slider.value = String(v);
    els.slider.style.setProperty('--fill', (v / VMAX) * 100 + '%');
    els.slider.classList.toggle('is-magnet', v === MAGNET);
    els.slider.setAttribute('aria-valuetext', `${v} percent`);

    els.bassBtn.setAttribute('aria-checked', String(state.bass));
    els.bassSlider.disabled = !state.bass;
    els.bassSlider.value = String(state.bassDb);
    els.bassSlider.style.setProperty('--fill', (state.bassDb / BASS_MAX) * 100 + '%');
    els.bassDb.textContent = `${state.bassDb} dB`;

    els.eqBtn.setAttribute('aria-checked', String(state.eqOn));
    els.eqWrap.classList.toggle('is-off', !state.eqOn);
    for (let i = 0; i < bandRefs.length; i++) {
      const { input, dbBtn } = bandRefs[i];
      const db = state.eqOn ? (state.eq[i] || 0) : 0;
      input.value = String(db);
      dbBtn.textContent = `${db > 0 ? '+' : ''}${db} dB`;
      dbBtn.classList.toggle('is-nonzero', db !== 0);
    }
    const active = activePresetName();
    for (const p of presetBtns) p.btn.classList.toggle('is-active', p.name === active);

    els.noiseBtn.setAttribute('aria-checked', String(state.noise.on));
    els.noiseSlider.disabled = !state.noise.on;
    els.noiseSlider.max = String(NOISE_MAX);
    els.noiseSlider.value = String(state.noise.strength);
    els.noiseSlider.style.setProperty('--fill', (state.noise.strength / NOISE_MAX) * 100 + '%');
    els.noiseVal.textContent = `${state.noise.strength}%`;

    const src = state.media === 1 ? '1 audio source' : `${state.media} audio sources`;
    const mode = state.graphs > 0 ? 'Web Audio' : 'native';
    els.engine.textContent = state.media > 0 ? `${src} · ${mode}` : 'no media on this page yet';
    if (els.engineRow) {
      els.engineRow.textContent = state.graphs > 0
        ? (state.volume > 1.0001 ? 'Limiter (clean boost)' : 'Web Audio (transparent)')
        : '—';
    }
  }

  function reflectSnapshot(r) {
    if (!r) return;
    state.volume = clamp(typeof r.volume === 'number' ? r.volume : 1, 0, 6);
    state.bass = !!r.bass;
    state.bassDb = clamp(typeof r.bassDb === 'number' ? r.bassDb : 8, 0, BASS_MAX);
    if (Array.isArray(r.eq)) state.eq = BANDS.map((_, i) => clamp(Number(r.eq[i]) || 0, -12, 12));
    if (typeof r.eqOn === 'boolean') {
      state.eqOn = r.eqOn;
      if (r.eqOn && savedEq) { state.eq = savedEq; savedEq = null; }
    }
    if (r.noise && typeof r.noise === 'object') {
      state.noise = {
        on: !!r.noise.on,
        strength: clamp(Math.round(Number(r.noise.strength) || 0), 0, NOISE_MAX),
      };
    }
    state.media = typeof r.media === 'number' ? r.media : 0;
    state.graphs = typeof r.graphs === 'number' ? r.graphs : 0;
    state.ctx = r.ctx || 'none';
    render();
  }

  /* ------------------------------------------------------------------ *
   * Volume snapping: 10 % detents + magnetic 100 % stop
   * ------------------------------------------------------------------ *
   * The <input type=range> keeps step=10 (keyboard and programmatic changes
   * stay on the grid). While dragging we re-map the raw pointer position:
   * round to the nearest detent, and if the raw position sits within the
   * magnet band of the 100 % mark it clings to exactly 100 % — so "a little
   * above 100 %" never strands you at 110 % and landing on 100 is effortless.
   */
  function snapFromClientX(clientX) {
    const rect = els.slider.getBoundingClientRect();
    const usable = Math.max(1, rect.width - THUMB_PX);
    const raw = clamp((clientX - rect.left - THUMB_PX / 2) / usable, 0, 1) * (VMAX - VMIN);

    // Magnet: the 100 % bucket is twice as wide as a normal detent, so "close
    // to 100" always settles exactly on 100 — while 90 and 110 stay reachable
    // just past it (and via the arrow keys).
    if (raw > MAGNET - SNAP && raw < MAGNET + SNAP) return MAGNET;

    return clamp(Math.round(raw / SNAP) * SNAP, VMIN, VMAX);
  }

  function setVolumePct(p, commit) {
    state.volume = p / 100;
    render();
    if (commit) queuePush();
  }

  els.slider.addEventListener('pointerdown', (e) => {
    dragging = true;
    activePointerId = e.pointerId;
    try { els.slider.setPointerCapture(e.pointerId); } catch (_) {}
    setVolumePct(snapFromClientX(e.clientX), true);
  });

  els.slider.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    setVolumePct(snapFromClientX(e.clientX), true);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    activePointerId = null;
    flushPush();
  };
  els.slider.addEventListener('pointerup', endDrag);
  els.slider.addEventListener('pointercancel', endDrag);

  // Double-click the slider → back to exactly 100 % ("normal").
  els.slider.addEventListener('dblclick', () => setVolumePct(MAGNET, true));

  // Clicking the "100" label on the scale also lands exactly on 100 %.
  const scale100 = document.getElementById('scale100');
  if (scale100) {
    scale100.addEventListener('click', () => setVolumePct(MAGNET, true));
  }

  els.slider.addEventListener('input', () => {
    // Keyboard / programmatic changes: already on the 10 % grid via step=10.
    if (dragging) return; // the drag path drives state directly
    setVolumePct(Number(els.slider.value), true);
  });
  els.slider.addEventListener('change', flushPush);

  // Arrows: 10 % steps (the slider's detent grid) · Shift+arrows: fine 1 %.
  // Handled explicitly (instead of relying on native range stepping) so the
  // commit/push timing and the 100 % magnet halo always stay in sync.
  els.slider.addEventListener('keydown', (e) => {
    const table = e.shiftKey
      ? { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }
      : { ArrowUp: SNAP, ArrowRight: SNAP, ArrowDown: -SNAP, ArrowLeft: -SNAP };
    const step = table[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    setVolumePct(clamp(pctOf(state.volume) + step, VMIN, VMAX), true);
  });

  /* ------------------------------------------------------------------ *
   * Bass / noise controls
   * ------------------------------------------------------------------ */
  els.bassSlider.addEventListener('input', () => {
    state.bassDb = Number(els.bassSlider.value);
    render();
    queuePush();
  });
  els.bassSlider.addEventListener('change', flushPush);

  els.bassBtn.addEventListener('click', () => {
    state.bass = !state.bass;
    render();
    void push();
  });

  els.noiseSlider.addEventListener('input', () => {
    state.noise.strength = Number(els.noiseSlider.value);
    render();
    queuePush();
  });
  els.noiseSlider.addEventListener('change', flushPush);

  els.noiseBtn.addEventListener('click', () => {
    state.noise.on = !state.noise.on;
    render();
    void push();
  });

  els.reset.addEventListener('click', () => {
    state = {
      volume: DEFAULTS.volume,
      bass: DEFAULTS.bass,
      bassDb: DEFAULTS.bassDb,
      eq: BANDS.map(() => 0),
      eqOn: true,
      noise: { on: false, strength: DEFAULTS.noise.strength },
      media: state.media, graphs: state.graphs, ctx: state.ctx,
    };
    savedEq = null;
    render();
    flushPush();
  });

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  async function targetTab() {
    const win = await chrome.tabs.query({ lastFocusedWindow: true });
    let list = win;
    if (!list.some((t) => t.active)) list = await chrome.tabs.query({});

    const http = (t) => /^https?:/.test(t.url || '');
    const pref = list.find((t) => t.active && http(t));
    if (pref) return pref;
    return list.find(http) || null;
  }

  async function init() {
    render();

    const tab = await targetTab();
    if (!tab || tab.id == null || !/^https?:/.test(tab.url || '')) {
      els.host.textContent = '';
      els.meta.textContent = 'open a website to control its volume';
      els.engine.textContent = '';
      return;
    }

    tabId = tab.id;
    els.host.textContent = hostname(tab.url);

    let resp = null;
    try {
      resp = await send({ type: 'vp:get' });
    } catch (_) {
      // Tab was opened before the extension got installed — inject the engine.
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['shared/audio-config.js', 'content/content.js'],
        });
        resp = await send({ type: 'vp:get' });
      } catch (_) {
        resp = null;
      }
    }

    if (resp) {
      reflectSnapshot(resp);
    } else {
      els.meta.textContent = 'this page can’t be boosted';
      els.engine.textContent = '';
    }
    render();
  }

  void init();
})();
