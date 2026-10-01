# Volume+

A clean, minimal tab-volume extension for Chrome / Edge (Manifest V3) — 0–600%,
native-quality audio, a real Bass Boost (low-shelf filter), a **6-band
graphic equalizer**, **noise reduction**, and — critically — **fullscreen that
is never broken**.

Inspired by the gap left by Volume Master (which breaks fullscreen on sites like
YouTube): Volume+ wraps only the *audio output* of media elements. It never
clones, wraps, replaces, or intercepts `<video>`, and never touches
`requestFullscreen()` or site controls — so fullscreen keeps working before,
during, and after volume/Bass Boost changes. The site's **own** volume slider /
shortcuts stay fully under the site's control: Volume+ applies a gain multiplier
**on top**, it never rewrites the element's native volume.

## Features

- **Volume slider 0%–600% in 1% steps**; `100%` = ×1 (the site's volume, exactly
  as the site set it). 0 = mute. Anything ≠ 100% is a real gain applied on top
  of the site's own volume — the site's slider always stays yours.
- **Quiet-but-audible low end**: 1–10% uses tiny (non-zero) gain values instead of
  snapping below the browser's normal minimum.
- **Bass Boost** — a proper `BiquadFilterNode` low-shelf at 180 Hz, with an
  on/off toggle and a 0–12 dB intensity control. Not fake overall-amplification.
- **Equalizer tab** — six vertical faders (60 Hz, 170 Hz, 350 Hz, 1 kHz,
  3.5 kHz, 10 kHz; shelves on the ends, peaking in between), −12…+12 dB per
  band, a master on/off toggle and a one-click Flatten. Tap a band's dB chip to
  zero just that band.
- **Reduce noise (Settings tab)** — a two-stage filter pair: a high-pass
  (45–180 Hz) that trims rumble/hum/handling noise, plus a de-hiss high-shelf
  (up to −9 dB above 6.5 kHz). One 0–100 % strength dial.
- **Snapping slider** — the volume slider stops on every 10 % (with a tick
  ruler), and a magnetic stop makes "close to 100 %" settle exactly on 100, so
  it's never a fight to get back to "normal" after raising it. Double-click the
  slider (or click the 100 label) to jump straight to 100 %. Arrows step 10 %;
  hold Shift with the arrows for 1 % fine steps.
- **Literal boost**: 100% = ×1, 600% = ×6 (+15.6 dB) on top of the site volume.
  No limiter or compressor is inserted, so the boost is exactly as loud as it
  says on the label. At the extreme end of the range audio can exceed full
  scale and clip — that distortion at 6× is expected and normal.
- **Robust engine**: dynamically created/replaced media elements are picked up by
  a throttled `MutationObserver` + `play` events; per-host settings survive
  reloads/navigation; multiple media elements are all handled; iframes included.
- **Minimal permissions** — `storage` + `scripting`, host match `http/https`.
  Everything runs locally. No ads, donation buttons, accounts, analytics, or
  external services.

## Architecture

```
Popup (popup/)  ──chrome.tabs.sendMessage──►  Content script engine (content/content.js)
                                               │
                                               ├─ element volume = the SITE's own volume (never touched)
                                               ├─ any boost/filter: Web Audio graph
                                               │    media element → highpass → de-hiss shelf
                                               │    → bass lowshelf → EQ ×6 → gain
                                               │    → speakers   (gain = ×0–×6 on top of site volume)
                                               └─ settings persisted per host (chrome.storage.local)
```

- The engine runs in **every frame** (`all_frames`) so embedded players are
  covered too. The top frame answers the popup; subframes just apply.
- The extension is purely additive: the element's native `volume` is **never
  rewritten**, so lowering the site's own slider sticks (e.g. 50% site +
  100% Volume+ = 50%; 50% site + 200% Volume+ = ~100%).
- An `AudioContext` is created lazily and resumed on a page gesture when needed;
  while suspended the site's audio plays untouched at its own volume until the
  user interacts. Only elements that need gain/bass are bound.

## Load the extension (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select this folder (`volume-plus`).
4. Open YouTube (or any site with audio/video), click the **Volume+** icon, and
   drag the slider.

That's it — no accounts, no setup. Settings are remembered per site.

## Test that fullscreen really works

1. Open the harness locally (it self-generates a tone video, ~90 Hz bass + 440 Hz)
   ```
   cd volume-plus
   npx http-server test -p 8000        # or: python -m http.server 8000 --directory test
   ```
   then visit `http://127.0.0.1:8000/harness.html`.
2. While the video plays, crank the slider to 300% and enable Bass Boost.
3. Press **Enter fullscreen**, exit, re-enter. Fullscreen must never break.
   Do the same on YouTube: raise volume >100% *then* click fullscreen, scrub the
   timeline, change volume via the popup mid-fullscreen.

### Automated run

```
cd volume-plus/test
npm i puppeteer-core
node automated.mjs
```

For a quick UI-only check without a browser install, open `test/ui-smoke.html`
(regenerate it after popup changes with `node tools/build-smoke.mjs`) — it
inlines the popup and asserts tabs, snapping, EQ and noise-reduction behavior.

This launches a real Chromium with the extension loaded, drives the actual popup,
and asserts: gain control on top of the site volume, Bass Boost, **fullscreen
enter / exit / re-enter while controlled**, the site's own volume never being
reset mid-boost, no DOM mutation, dynamic media, and settings survival across
reloads.

### Live-site checks

```
node youtube.mjs        # real YouTube: 300% + Bass, fullscreen enter/persist/exit/re-enter
node probe.mjs https://music.youtube.com   # any site: does the engine detect & bind its player?
```

`youtube.mjs` verifies fullscreen keeps working on YouTube while the Web Audio
graph is actively bound — including the original Volume Master repro (volume
changed mid-fullscreen, exit, immediate re-enter). `probe.mjs` reports the media
elements a page exposes and whether the engine bound them; pass any URL.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (permissions: `storage`, `scripting`) |
| `shared/audio-config.js` | EQ band frequencies + noise params, shared by UI & engine |
| `content/content.js` | Audio engine: binding, graphs, observer, persistence |
| `popup/popup.html/css/js` | The popup UI (Volume / Equalizer / Settings tabs) |
| `background/service-worker.js` | Minimal placeholder worker |
| `test/harness.html` | Local tone-video + fullscreen test page |
| `test/ui-smoke.html` | Self-contained popup UI smoke test (open in any browser) |
| `test/automated.mjs` | End-to-end browser automation |
| `test/youtube.mjs` | Live YouTube fullscreen verification |
| `test/probe.mjs` | Any-site engine/binding probe |
| `tools/Volume+_Icon.png` | Master icon art (source of `icons/*.png`) |
| `tools/make-icons.ps1` | Resizes master art into `icons/*.png` |
| `icons/` | Extension icons |

## Known limits (by design)

- Sites with DRM-locked audio (e.g. some rentals) can't be routed through Web
  Audio; while their media can't be bound, the site's own volume still works and
  Volume+ falls back gracefully.
- Non-CORS cross-origin media can produce silence when routed through Web Audio;
  media that can't be bound keeps playing at the site's own volume.
- The engine targets media elements (`<video>`/`<audio>`); it does not control
  pages that synthesize audio purely inside Web Audio (e.g. game engines).
- Shadow-DOM-hosted media elements aren't scanned.

## Privacy

No tracking, no analytics, no accounts, no network calls, no external services.
All state lives in your browser's local storage.