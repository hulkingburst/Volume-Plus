/*
 * Volume+ — shared audio configuration.
 *
 * Loaded as a classic script on BOTH sides:
 *   - popup/popup.html  (before popup.js)  → labels/ranges for the UI
 *   - content/content.js (via the manifest) → the real filter chain
 *
 * Keeping it in one place means the slider the user drags is always the filter
 * that actually runs. Frequencies are the classic 6-band graphic-EQ centers:
 * shelves on the ends, peaking bands (Q ≈ 1.1) in the middle.
 */
(function (root) {
  'use strict';

  const MAX_GAIN = 6;        // 600 %
  const BASS_MAX_DB = 12;    // low-shelf Bass Boost range
  const BASS_FREQ = 180;     // low-shelf center (Hz)

  const EQ_MAX_DB = 12;      // each EQ band: -12 … +12 dB

  const BANDS = [
    { freq: 60, type: 'lowshelf', label: '60', unit: 'Hz' },
    { freq: 170, type: 'peaking', label: '170', unit: 'Hz', q: 1.1 },
    { freq: 350, type: 'peaking', label: '350', unit: 'Hz', q: 1.1 },
    { freq: 1000, type: 'peaking', label: '1', unit: 'kHz', q: 1.1 },
    { freq: 3500, type: 'peaking', label: '3.5', unit: 'kHz', q: 1.1 },
    { freq: 10000, type: 'highshelf', label: '10', unit: 'kHz' },
  ];

  /*
   * "Reduce noise" is a two-stage filter pair — no fake AI claim:
   *   1. high-pass   → rumble, handling noise, mains hum, traffic thud
   *   2. high-shelf cut (de-hiss) → tape/room hiss, sibilance, browser fan
   * Strength (0–100 %) scales the cutoff frequency and the hiss cut.
   */
  const NOISE = {
    DEF: 50,
    HP_MIN: 45,        // Hz — ~transparent at 0 % strength
    HP_MAX: 180,       // Hz — at 100 % strength
    HISS_FREQ: 6500,   // Hz high-shelf center
    HISS_MAX_DB: 9,    // dB cut at 100 % strength
  };

  root.VP_AUDIO = { MAX_GAIN, BASS_MAX_DB, BASS_FREQ, EQ_MAX_DB, BANDS, NOISE };
})(typeof window !== 'undefined' ? window : globalThis);
