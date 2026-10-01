/*
 * Volume+ — audio engine (content script)
 *
 * Design principles:
 *  - The page's DOM and the browser's Fullscreen / pointer / video APIs are
 *    NEVER touched. We only wrap a media element's *audio output* with a
 *    Web Audio graph, so fullscreen, Play/Pause, seeking, and site controls
 *    keep working untouched (this is the bug Volume Master ran into).
 *  - Volume is applied ON TOP of the site's own volume: the element's native
 *    `volume` stays fully under the site's control (its slider / shortcuts /
 *    mute), and the extension acts as a pure multiplier on top of it through
 *    a Web Audio graph. 100% = ×1.
 *  - One AudioContext per frame, one graph per media element, all kept local.
 *    Graph: source → highpass → dynamic notch → de-hiss shelf (noise) →
 *    EQ × 6 → bass lowshelf → pre-gain → limiter → make-up → speakers.
 *    Noise/EQ stages sit at neutral values when off, so they cost nothing
 *    audible.
 *  - Dynamically created/replaced/paused media elements are reconciled via a
 *    (throttled) MutationObserver + play events.
 *  - Settings are persisted per host so reloads and navigations keep working.
 */
(() => {
  'use strict';

  if (window.__VOLUME_PLUS_ACTIVE__) return;
  Object.defineProperty(window, '__VOLUME_PLUS_ACTIVE__', { value: true, configurable: false });

  const CFG = (typeof VP_AUDIO !== 'undefined' && VP_AUDIO) || {
    MAX_GAIN: 6, BASS_MAX_DB: 12, BASS_FREQ: 180, EQ_MAX_DB: 12,
    BANDS: [
      { freq: 60, type: 'lowshelf', label: '60', unit: 'Hz' },
      { freq: 170, type: 'peaking', label: '170', unit: 'Hz', q: 1.1 },
      { freq: 350, type: 'peaking', label: '350', unit: 'Hz', q: 1.1 },
      { freq: 1000, type: 'peaking', label: '1', unit: 'kHz', q: 1.1 },
      { freq: 3500, type: 'peaking', label: '3.5', unit: 'kHz', q: 1.1 },
      { freq: 10000, type: 'highshelf', label: '10', unit: 'kHz' },
    ],
    NOISE: { DEF: 50, MAX: 80, HP_MIN: 45, HP_MAX: 320, NOTCH_Q: 3, HISS_FREQ: 6500, HISS_MAX_DB: 18 },
  };

  const MAX_GAIN    = CFG.MAX_GAIN;    // 600 %
  const BASS_MAX_DB = CFG.BASS_MAX_DB;
  const BASS_FREQ   = CFG.BASS_FREQ;
  const BANDS       = CFG.BANDS;
  const NOISE       = CFG.NOISE;
  const GRAPH_CAP   = 32;              // safety cap for pathological pages

  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /*
   * Perceptual pre-gain. The popup's P% maps to P^(2/3) gain because the ear
   * is logarithmic: a raw ×2 gain does not SOUND twice as loud, it sounds like
   * "the same thing but noisier". P^(2/3) keeps the perceived jump linear —
   * and the limiter below turns that gain into real, clean loudness.
   */
  const boostPre = (v) => (v <= 1.0001 ? v : Math.pow(v, 2 / 3));

  const SETTINGS = {
    volume: 1,
    bass: false,
    bassDb: 8,
    eqOn: true,
    eq: BANDS.map(() => 0),               // dB per band, −12 … +12
    noise: { on: false, strength: NOISE.DEF },
  };

  let audioCtx  = null;
  const graphs  = new Map(); // element -> { src, hp, notch, hiss, filter, eq[], preGain, comp, outGain }
  let known     = new Set(); // media elements currently in the DOM
  let pendingResume = false;

  /* ------------------------------------------------------------------ *
   * Persistence (per host, local only)
   * ------------------------------------------------------------------ */
  function sanitize(mine) {
    if (!mine || typeof mine !== 'object') return null;
    const eq = Array.isArray(mine.eq)
      ? BANDS.map((_, i) => clampNum(Number(mine.eq[i]) || 0, -CFG.EQ_MAX_DB, CFG.EQ_MAX_DB))
      : BANDS.map(() => 0);
    const ns = (mine.noise && typeof mine.noise === 'object') ? mine.noise : {};
    return {
      vol:    clampNum(typeof mine.vol === 'number' ? mine.vol : 1, 0, MAX_GAIN),
      bass:   !!mine.bass,
      bassDb: clampNum(typeof mine.bassDb === 'number' ? mine.bassDb : 8, 0, BASS_MAX_DB),
      eqOn: mine.eqOn !== false,
      eq,
      noise: {
        on: !!ns.on,
        strength: clampNum(typeof ns.strength === 'number' ? ns.strength : NOISE.DEF, 0, 100),
      },
    };
  }

  async function loadSettings() {
    try {
      const { vp } = await chrome.storage.local.get('vp');
      const host = location.hostname || '_default';
      const mine = sanitize(vp && vp[host]);
      if (mine) {
        SETTINGS.volume = mine.vol;
        SETTINGS.bass = mine.bass;
        SETTINGS.bassDb = mine.bassDb;
        SETTINGS.eqOn = mine.eqOn;
        SETTINGS.eq = mine.eq;
        SETTINGS.noise = mine.noise;
      }
    } catch (_) {}
  }

  function persist() {
    chrome.storage.local
      .get('vp')
      .then(({ vp }) => {
        const all = vp || {};
        all[location.hostname || '_default'] = {
          vol: Math.round(SETTINGS.volume * 1000) / 1000,
          bass: SETTINGS.bass,
          bassDb: SETTINGS.bassDb,
          eqOn: !!SETTINGS.eqOn,
          eq: SETTINGS.eqOn ? SETTINGS.eq.map((db) => Math.round(db * 10) / 10) : BANDS.map(() => 0),
          noise: {
            on: !!SETTINGS.noise.on,
            strength: Math.round(SETTINGS.noise.strength),
          },
        };
        void chrome.storage.local.set({ vp: all });
      })
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * Audio graph
   * ------------------------------------------------------------------ */
  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        audioCtx = new AC();
      } catch (_) {
        return null;
      }
    }
    if (audioCtx.state === 'suspended') {
      pendingResume = true;
      void audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function needsGraph() {
    return (
      Math.abs(SETTINGS.volume - 1) > 0.0001 ||
      SETTINGS.bass ||
      (SETTINGS.eqOn && SETTINGS.eq.some((db) => Math.abs(db) > 0.01)) ||
      SETTINGS.noise.on
    );
  }

  function bind(el) {
    if (graphs.has(el)) return graphs.get(el);
    const ctx = ensureCtx();
    // Never bind into a suspended context: audio would go blank. Wait for a
    // page gesture instead (the site's own volume keeps working meanwhile).
    if (!ctx || ctx.state !== 'running') return null;
    try {
      const src = ctx.createMediaElementSource(el);

      // Noise reduction stage 1: high-pass (rumble, hum, handling noise).
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.Q.value = 0.707;

      // Noise reduction stage 2: a narrow dynamic band-stop parked on the
      // hiss band (a broadband gate would eat voices; a narrow dip does not).
      // Neutral 'peaking' at 0 dB while noise reduction is off.
      const notch = ctx.createBiquadFilter();
      notch.type = 'peaking';
      notch.frequency.setValueAtTime(NOISE.HISS_FREQ, ctx.currentTime);
      notch.Q.setValueAtTime(NOISE.NOTCH_Q, ctx.currentTime);

      // Noise reduction stage 3: high-shelf cut (hiss, sibilance).
      const hiss = ctx.createBiquadFilter();
      hiss.type = 'highshelf';

      // Bass Boost: low-shelf at 180 Hz.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowshelf';
      filter.frequency.setValueAtTime(BASS_FREQ, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);
      filter.gain.setValueAtTime(SETTINGS.bass ? SETTINGS.bassDb : 0, ctx.currentTime);

      // Graphic equalizer: one biquad per band.
      const eq = BANDS.map((b) => {
        const f = ctx.createBiquadFilter();
        f.type = b.type;
        f.frequency.setValueAtTime(b.freq, ctx.currentTime);
        if (b.q) f.Q.setValueAtTime(b.q, ctx.currentTime);
        f.gain.setValueAtTime(0, ctx.currentTime);
        return f;
      });

      // Loudness chain, ON TOP of the element's own volume (the site keeps
      // control of element.volume; we never touch it). Boosting >100% is built
      // as a perceptually scaled pre-gain feeding a fast soft-knee limiter
      // with modest make-up: the limiter turns headroom into real, dense
      // loudness instead of cracked peak clipping, so 200% genuinely sounds
      // about twice as loud and stays clean.
      const preGain = ctx.createGain();
      preGain.gain.setValueAtTime(boostPre(SETTINGS.volume), ctx.currentTime);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-10, ctx.currentTime); // catch peaks just under full scale
      comp.knee.setValueAtTime(30, ctx.currentTime);       // soft knee: inaudible engagement
      comp.ratio.setValueAtTime(12, ctx.currentTime);      // limit, don't crush
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.25, ctx.currentTime);

      const outGain = ctx.createGain(); // gentle make-up while boosting
      outGain.gain.setValueAtTime(
        SETTINGS.volume > 1.0001
          ? Math.min(2, 0.85 + 0.15 * Math.log2(SETTINGS.volume))
          : 1,
        ctx.currentTime,
      );

      let prev = src;
      for (const node of [hp, notch, hiss, ...eq, filter, preGain, comp, outGain]) {
        prev.connect(node);
        prev = node;
      }
      outGain.connect(ctx.destination);

      const graph = { src, hp, notch, hiss, filter, eq, preGain, comp, outGain };
      graphs.set(el, graph);
      applyTo(el);
      return graph;
    } catch (_) {
      return null;
    }
  }

  const smooth = (node, value) => {
    if (audioCtx) node.setTargetAtTime(value, audioCtx.currentTime, 0.018);
    else node.value = value;
  };

  function applyTo(el) {
    const g = graphs.get(el);
    if (!g) {
      if (SETTINGS.volume <= 0.0001) {
        // Extension "mute" while the graph can't be engaged (suspended
        // context, bind failed): fall back to the element's native volume
        // so mute holds.
        try { if (el.volume !== 0) el.volume = 0; } catch (_) {}
      }
      // Otherwise the element is unbound at ×1: the site owns element.volume
      // completely and we leave it untouched.
      return;
    }
    smooth(g.preGain.gain, boostPre(SETTINGS.volume));
    smooth(g.outGain.gain,
      SETTINGS.volume > 1.0001
        ? Math.min(2, 0.85 + 0.15 * Math.log2(SETTINGS.volume))
        : 1);
    smooth(g.filter.gain, SETTINGS.bass ? SETTINGS.bassDb : 0);
    g.eq.forEach((f, i) => smooth(f.gain, SETTINGS.eqOn ? (SETTINGS.eq[i] || 0) : 0));
    if (SETTINGS.noise.on) {
      // Strength is capped at NOISE.MAX: beyond it the high-pass starts eating
      // voices, so more travel would only sound worse, not cleaner.
      const t = clampNum(SETTINGS.noise.strength, 0, NOISE.MAX) / NOISE.MAX;
      smooth(g.hp.frequency, NOISE.HP_MIN + (NOISE.HP_MAX - NOISE.HP_MIN) * t);
      g.notch.type = 'bandstop';           // engage the dynamic hiss band-stop
      smooth(g.notch.frequency, NOISE.HISS_FREQ);
      smooth(g.hiss.frequency, NOISE.HISS_FREQ);
      smooth(g.hiss.gain, -NOISE.HISS_MAX_DB * t);
    } else {
      smooth(g.hp.frequency, 5);           // below audio: fully transparent
      g.notch.type = 'peaking';            // neutral band: no dip when off
      smooth(g.hiss.frequency, 20000);
      smooth(g.hiss.gain, 0);
    }
  }

  function applyAll() {
    for (const el of known) applyTo(el);
  }

  /* ------------------------------------------------------------------ *
   * Reconciliation: keep up with media elements that appear / disappear
   * ------------------------------------------------------------------ */
  function rescan() {
    let els = [];
    try {
      els = Array.from(document.querySelectorAll('video, audio'));
    } catch (_) {}

    const next = new Set(els);
    known = next;

    if (needsGraph()) {
      for (const el of known) {
        if (graphs.has(el) || graphs.size >= GRAPH_CAP) continue;
        bind(el); // may defer if the context is suspended
      }
    }

    // Release graphs for elements that left the DOM when over the cap so a
    // long-lived tab never accumulates unbounded node graphs.
    if (graphs.size > GRAPH_CAP) {
      const drop = [];
      for (const [el] of graphs) {
        if (!known.has(el)) drop.push(el);
        if (graphs.size - drop.length <= GRAPH_CAP) break;
      }
      for (const el of drop) dispose(el);
    }

    applyAll();
  }

  function dispose(el) {
    const g = graphs.get(el);
    if (!g) return;
    try {
      g.src.disconnect();
      g.hp.disconnect();
      g.notch.disconnect();
      g.hiss.disconnect();
      g.filter.disconnect();
      for (const f of g.eq) f.disconnect();
      g.preGain.disconnect();
      g.comp.disconnect();
      g.outGain.disconnect();
    } catch (_) {}
    graphs.delete(el);
  }

  let scanTimer = 0;
  function scheduleRescan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; rescan(); }, 350);
  }

  let mo = null;
  function touchesMedia(nodeList) {
    for (const n of nodeList) {
      if (n.nodeType !== 1) continue;
      if (n.matches && n.matches('video,audio')) return true;
      if (n.querySelectorAll && (n.querySelectorAll('video,audio').length > 0)) return true;
    }
    return false;
  }

  function ensureObserver() {
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', ensureObserver, { once: true });
      return;
    }
    if (mo) return;
    mo = new MutationObserver((muts) => {
      let hit = false;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        if (touchesMedia(m.addedNodes) || touchesMedia(m.removedNodes)) { hit = true; break; }
      }
      if (hit) scheduleRescan();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* Resume a suspended context on any page gesture; never blocks anything. */
  function onGesture() {
    if (audioCtx && audioCtx.state === 'suspended') {
      pendingResume = true;
      void audioCtx.resume().catch(() => {});
      rescan();
    }
  }
  document.addEventListener('pointerdown', onGesture, { passive: true });
  document.addEventListener('keydown', onGesture, { passive: true });
  document.addEventListener('play', scheduleRescan, { passive: true });

  // Retry deferred graph binds once the context is allowed to run, and keep
  // graph values in sync with the current settings.
  setInterval(() => {
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {});
    } else if (pendingResume) {
      pendingResume = false;
      scheduleRescan();
    }
    applyAll();
  }, 1200);

  /* ------------------------------------------------------------------ *
   * Messaging: popup -> this frame.
   * Top frame answers; subframes just apply (keeps protocol clean).
   * ------------------------------------------------------------------ */
  function applyIncoming(msg) {
    if (typeof msg.volume === 'number') SETTINGS.volume = clampNum(msg.volume, 0, MAX_GAIN);
    if (typeof msg.bass === 'boolean') SETTINGS.bass = msg.bass;
    if (typeof msg.bassDb === 'number') SETTINGS.bassDb = clampNum(msg.bassDb, 0, BASS_MAX_DB);
    if (typeof msg.eqOn === 'boolean') SETTINGS.eqOn = msg.eqOn;
    if (Array.isArray(msg.eq)) {
      SETTINGS.eq = BANDS.map((_, i) =>
        clampNum(Number(msg.eq[i]) || 0, -CFG.EQ_MAX_DB, CFG.EQ_MAX_DB));
    }
    if (msg.noise && typeof msg.noise === 'object') {
      SETTINGS.noise = {
        on: !!msg.noise.on,
        strength: clampNum(Number(msg.noise.strength) || 0, 0, 100),
      };
    }
    persist();
  }

  function snapshot() {
    return {
      volume: Math.round(SETTINGS.volume * 1000) / 1000,
      bass: !!SETTINGS.bass,
      bassDb: Math.round(SETTINGS.bassDb * 10) / 10,
      eqOn: !!SETTINGS.eqOn,
      eq: SETTINGS.eq.map((db) => Math.round(db * 10) / 10),
      noise: {
        on: !!SETTINGS.noise.on,
        strength: Math.round(SETTINGS.noise.strength),
      },
      media: known.size,
      graphs: graphs.size,
      ctx: audioCtx ? audioCtx.state : 'none',
      state: SETTINGS.volume > 1.0001 ? 'limiter' : 'transparent',
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'vp:get' && msg.type !== 'vp:set' && msg.type !== 'vp:sync') return;

    const isTop = window.top === window && !(sender && sender.tab && sender.frameId > 0);

    if (msg.type === 'vp:set') applyIncoming(msg);
    rescan();

    if (isTop && typeof sendResponse === 'function') {
      try { sendResponse(snapshot()); } catch (_) {}
    }
  });

  /* ------------------------------------------------------------------ */
  async function init() {
    await loadSettings();
    ensureObserver();
    rescan();
    document.addEventListener('DOMContentLoaded', () => rescan(), { once: true });
    window.addEventListener('pageshow', () => rescan(), { passive: true });
  }

  void init();
})();
