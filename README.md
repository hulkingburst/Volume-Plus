# Volume+

A clean, minimal tab-volume extension for Chrome / Edge (Manifest V3) — 0–600%,
native-quality audio, a real Bass Boost (low-shelf filter), and — critically —
**fullscreen that is never broken**.

Inspired by the gap left by Volume Master (which breaks fullscreen on sites like
YouTube): Volume+ wraps only the *audio output* of media elements. It never
clones, wraps, replaces, or intercepts `<video>`, and never touches
`requestFullscreen()` or site controls — so fullscreen keeps working before,
during, and after volume/Bass Boost changes.

## Features

- **Volume slider 0%–600%** in 1% steps; `100%` = normal volume. 0 = mute.
- **Quiet-but-audible low end**: 1–10% uses tiny (non-zero) gain values instead of
  snapping below the browser's normal minimum.
- **Bass Boost** — a proper `BiquadFilterNode` low-shelf at 180 Hz, with an
  on/off toggle and a 0–12 dB intensity control. Not fake overall-amplification.
- **Literal 600% boost**: 100% = unity, 600% = +15.6 dB of real gain. No
  limiter or compressor is inserted, so the boost is exactly as loud as it
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
├─ Volume ≤ 100%: element.volume (native, 0–1)
                                                ├─ Volume > 100% or Bass: Web Audio graph
                                                │    media element → lowshelf → gain
                                                │    → speakers   (gain = volume, literal)
                                                └─ settings persisted per host (chrome.storage.local)
```

- The engine runs in **every frame** (`all_frames`) so embedded players are
  covered too. The top frame answers the popup; subframes just apply.
- Only the active Web Audio path is ever engaged — below 100% without bass the
  page stays fully native (zero latency, zero interference).
- An `AudioContext` is created lazily and resumed on a page gesture when needed;
  while suspended, the native path keeps sound working until the user interacts.

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

This launches a real Chromium with the extension loaded, drives the actual popup,
and asserts: native + Web Audio volume control, Bass Boost, **fullscreen enter /
exit / re-enter while controlled**, no DOM mutation, dynamic media, and settings
survival across reloads.

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
| `content/content.js` | Audio engine: binding, graphs, observer, persistence |
| `popup/popup.html/css/js` | The popup UI |
| `background/service-worker.js` | Minimal placeholder worker |
| `test/harness.html` | Local tone-video + fullscreen test page |
| `test/automated.mjs` | End-to-end browser automation |
| `test/youtube.mjs` | Live YouTube fullscreen verification |
| `test/probe.mjs` | Any-site engine/binding probe |
| `tools/make-icons.ps1` | Regenerates `icons/*.png` |
| `icons/` | Extension icons |

## Known limits (by design)

- Sites with DRM-locked audio (e.g. some rentals) can't be routed through Web
  Audio; those stay native ≤100%.
- Non-CORS cross-origin media can produce silence when routed through Web Audio;
  below 100% the native path is always used, so normal listening is unaffected.
- The engine targets media elements (`<video>`/`<audio>`); it does not control
  pages that synthesize audio purely inside Web Audio (e.g. game engines).
- Shadow-DOM-hosted media elements aren't scanned.

## Privacy

No tracking, no analytics, no accounts, no network calls, no external services.
All state lives in your browser's local storage.