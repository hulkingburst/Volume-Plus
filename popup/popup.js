(() => {
  'use strict';

  const DEFAULTS = { volume: 1, bass: false, bassDb: 8 };
  const BASS_MAX = 12;

  const els = {
    pct: document.getElementById('pct'),
    meta: document.getElementById('meta'),
    slider: document.getElementById('slider'),
    bassBtn: document.getElementById('bassBtn'),
    bassSlider: document.getElementById('bassSlider'),
    bassDb: document.getElementById('bassDb'),
    engine: document.getElementById('engine'),
    host: document.getElementById('host'),
    reset: document.getElementById('reset'),
  };

  let tabId = null;
  let state = { ...DEFAULTS, media: 0, graphs: 0, ctx: 'none' };
  let sendTimer = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pctOf = (v) => Math.round(clamp(v, 0, 6) * 100);

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

  function render() {
    const v = pctOf(state.volume);
    const mult = (state.volume).toFixed(2).replace(/\.?0+$/, '');

    els.pct.textContent = v + '%';
    if (v === 0) els.meta.textContent = 'muted';
    else if (v < 100) els.meta.textContent = `quiet · ${v}% of normal`;
    else if (v === 100) els.meta.textContent = 'normal volume';
    else els.meta.textContent = `boosted · ×${mult}`;

    els.slider.value = String(v);
    els.slider.style.setProperty('--fill', v + '%');

    els.bassBtn.setAttribute('aria-checked', String(state.bass));
    els.bassSlider.disabled = !state.bass;
    els.bassSlider.value = String(state.bassDb);
    els.bassSlider.style.setProperty('--bfill', (state.bassDb / BASS_MAX * 100) + '%');
    els.bassDb.textContent = `${state.bassDb} dB`;

    const src = state.media === 1 ? '1 audio source' : `${state.media} audio sources`;
    const mode = state.graphs > 0 ? 'Web Audio' : 'native';
    els.engine.textContent = state.media > 0 ? `${src} · ${mode}` : 'no media on this page yet';
  }

  function reflectSnapshot(r) {
    if (!r) return;
    state.volume = clamp(typeof r.volume === 'number' ? r.volume : 1, 0, 6);
    state.bass = !!r.bass;
    state.bassDb = clamp(typeof r.bassDb === 'number' ? r.bassDb : 8, 0, BASS_MAX);
    state.media = typeof r.media === 'number' ? r.media : 0;
    state.graphs = typeof r.graphs === 'number' ? r.graphs : 0;
    state.ctx = r.ctx || 'none';
    render();
  }

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
          files: ['content/content.js'],
        });
        resp = await send({ type: 'vp:get' });
      } catch (_) {
        resp = null;
      }
    }

    if (resp) {
      reflectSnapshot(resp);
    } else {
      els.meta.textContent = 'this page can\u2019t be boosted';
      els.engine.textContent = '';
    }
    render();
  }

  els.slider.addEventListener('input', () => {
    state.volume = Number(els.slider.value) / 100;
    render();
    queuePush();
  });
  els.slider.addEventListener('change', flushPush);

  els.bassSlider.addEventListener('input', () => {
    state.bassDb = Number(els.bassSlider.value);
    render();
  });
  els.bassSlider.addEventListener('change', flushPush);

  els.bassBtn.addEventListener('click', () => {
    state.bass = !state.bass;
    render();
    void push();
  });

  els.reset.addEventListener('click', () => {
    state.volume = DEFAULTS.volume;
    state.bass = DEFAULTS.bass;
    state.bassDb = DEFAULTS.bassDb;
    render();
    flushPush();
  });

  void init();
})();