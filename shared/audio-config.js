/*
 * Volume+ — shared audio configuration.
 *
 * Loaded as a classic script on BOTH sides:
 *   - popup/popup.html  (before popup.js)  → labels/ranges/presets for the UI
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
   * One-tap EQ presets (dB per band, same order as BANDS). The popup marks the
   * active chip by comparing the live curve against these exact values.
   */
  const PRESETS = [
    { id: 'flat',     name: 'Flat',      eq: [0, 0, 0, 0, 0, 0] },
    { id: 'bass',     name: 'Bass Boost', eq: [8, 4, 0, 0, 0, 0] },
    { id: 'vocal',    name: 'Vocal',     eq: [-3, -1, 2, 5, 4, 1] },
    { id: 'treble',   name: 'Treble',    eq: [-2, -1, 0, 1, 4, 7] },
    { id: 'rock',     name: 'Rock',      eq: [5, 3, -1, -1, 3, 5] },
    { id: 'pop',      name: 'Pop',       eq: [-1, 1, 4, 4, 1, -1] },
    { id: 'loudness', name: 'Loudness',  eq: [6, 3, 0, 0, 3, 6] },
  ];

  /*
   * "Reduce noise" is a three-stage filter chain — no fake AI claim:
   *   1. high-pass         → rumble, handling noise, mains hum, traffic thud
   *   2. band-stop         → a narrow dynamic dip parked on the hiss band
   *   3. high-shelf cut    → tape/room hiss, sibilance, browser fan
   * Strength (0–100 %) scales the cutoff frequency and the cut depth.
   *
   * MAX caps how far the strength dial actually travels: past ~80 % the
   * high-pass starts eating voices and everything just sounds underwater.
   * The dial stops there instead of lying about "100 %".
   */
  const NOISE = {
    DEF: 50,
    MAX: 80,           // useful ceiling for the strength slider
    HP_MIN: 45,        // Hz — ~transparent at 0 % strength
    HP_MAX: 320,       // Hz — at full strength (clearly audible de-rumble)
    NOTCH_Q: 3,        // narrow band-stop on the hiss band
    HISS_FREQ: 6500,   // Hz band-stop / high-shelf center
    HISS_MAX_DB: 18,   // dB shelf cut at full strength
  };

  root.VP_AUDIO = { MAX_GAIN, BASS_MAX_DB, BASS_FREQ, EQ_MAX_DB, BANDS, NOISE, PRESETS };
})(typeof window !== 'undefined' ? window : globalThis);
