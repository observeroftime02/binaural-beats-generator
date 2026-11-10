# Binaural Lab — pure sine binaural beat generator

A single-purpose, dependency-free tone generator. Two independent pure sine
oscillators, one hard-wired to each ear, plus the maths, the readout and the
presets needed to explore binaural beats.

**Open `index.html` in a browser. That is the whole install.**

No server, no build step, no network requests, no libraries. Everything loads
from this folder, including the icon (inline data URI) and the fonts (system
fonts). Put on headphones — the effect does not exist without them.

### Optional: serve it to the network

If you would rather open it on a phone or another machine in the house:

```
serve.bat            Windows - double-click it (or run it from a prompt)
python serve.py      any OS with Python 3
```

That serves this folder at `http://0.0.0.0:7899` and prints the addresses to
use, including the LAN one for other devices. Flags: `--port 8000`,
`--local-only` (bind 127.0.0.1 instead), `--no-browser`. Windows will ask about
the firewall the first time; allow it for private networks if you want phones
to connect. Standard library only — nothing to install.

---

## What it does

* **Two carrier frequencies**, each with a slider *and* a number box
  (20 – 1000 Hz, tweakable in 0.01 Hz steps).
* **Live beat readout** — the big number is `|f_left − f_right|` in Hz, with a
  classification (delta / theta / alpha / beta / gamma), a colour that follows
  the band, and the subtraction spelled out underneath.
* **Beat-target mode (the bonus)** — choose the beat rate you *want* and a
  centre pitch; both carriers are calculated symmetrically as
  `centre ± beat/2`. Move the beat slider and you hear the pulse speed change
  while the pitch stays put.
* **Eight presets**, one per band plus a unison control, so the effect can be
  compared back to back.
* **Session timer** — 5 to 60 minutes. The final minute fades to silence. The
  fade is scheduled on the *audio* clock rather than by a timer callback, so it
  still happens correctly when the tab is throttled or the screen is locked.
* **Ear check** — solo the left or right ear for a few seconds to confirm your
  headphones are on the right way round, and that nothing (Bluetooth mono, an
  OS accessibility setting) is collapsing the stereo image.
* **WAV export** — render the current pair offline and download it, faster than
  real time, with no server and no MediaRecorder. Pick 1, 3, 5, 10, 30 or 60
  minutes, or type any custom length from 1 minute up to 2 hours.
* **A live beat wave** — one second of the *beat itself* across the canvas, so
  the number of crests on screen is the frequency in hertz. The crests always
  show the true rate; the drift is speed-limited so it never turns into a
  flicker. A period dial shows how long one beat lasts.
* **Transport** — play/stop with a de-click fade, master volume, swap ears,
  reset. Your settings are remembered in `localStorage` between visits.

Keyboard: <kbd>Space</kbd> play/stop, <kbd>Esc</kbd> stop, arrow keys nudge
whichever slider has focus.

---

## How it works (the short version)

Both tones are generated at full precision and never mixed:

```
osc(210 Hz) ─▶ gain ─▶ channelMerger(0) ─┐
                                         ├─▶ master gain ─▶ speakers
osc(220 Hz) ─▶ gain ─▶ channelMerger(1) ─┘
```

A `ChannelMergerNode` puts one oscillator on stereo channel 0 and the other on
channel 1, so the isolation is structural rather than a matter of panning
accuracy. Summed arithmetically, two sines give

```
sin(2πf₁t) + sin(2πf₂t) = 2·cos(π·Δf·t) · sin(2π·f_avg·t)
```

— a fast tone at the average pitch inside a slow envelope at the difference.
The canvas draws that slow term as a sine at Δf: one crest per beat, which is
the same pulse you hear, just without the rectified kinks. In a true binaural
setup nothing is summed acoustically: your
brainstem compares the two channels and reports the mismatch, and Δf is what
you perceive as the beat.

### Why the motion is speed-limited

That identity is also why an unconstrained animation is a bad idea. A wave
scrolling at its true rate is lovely at 1 Hz and becomes a flicker at 40 Hz —
and 3 Hz upward is the range that matters for photosensitive viewers. So the
canvas separates the two properties:

* **Shape = truth.** One second of beat across the canvas, one crest per cycle.
  10 Hz draws ten waves; 2.5 Hz draws two and a half. Count the crests and you
  have the frequency, at any rate.
* **Motion = capped.** The phase advances at `min(beat, 3 Hz)`. Delta and theta
  scroll at their real rate; alpha, beta and gamma drift gently instead of
  strobing, and the stage label appends `slowed` whenever that cap is active so
  the picture never overstates itself.

Motion runs only while the tones are playing, and disappears entirely under
`prefers-reduced-motion` — the wave then still shows the correct crest count,
it just stands still.

The presets are honest about the science: the auditory phenomenon is real, the
"brainwave entrainment" claims are weaker than the marketing suggests.

---

## Files

```
binaural_beats/
├── index.html              single page, semantic markup only
├── serve.py                zero-dependency static server (0.0.0.0:7899)
├── serve.bat               Windows double-click launcher
├── css/
│   └── style.css           design tokens, layout, custom controls
├── js/
│   ├── presets.js          band taxonomy, beat↔carrier maths, preset data
│   ├── state.js            the single source of truth (pure, DOM-free)
│   ├── audio-engine.js     Web Audio graph: 2× sine → merger → volume → fade
│   ├── visualizer.js       beat wave canvas, period dial
│   ├── timer.js            sleep timer + fade curve (pure, clock-injected)
│   ├── wav.js              16-bit PCM WAV encoder (pure, testable)
│   ├── export.js           offline render + download
│   └── app.js              DOM binding: input → state → render → audio
├── test/
│   ├── logic.test.js       node test/logic.test.js   (33 assertions)
│   └── dom.test.js         node test/dom.test.js     (47 assertions)
└── README.md
```

### Why classic `<script>` tags and not ES modules?

Because ES modules are blocked by CORS on `file://` URLs. `import`/`export`
would force the page behind a web server, which the brief ruled out. Each
module is instead an IIFE that registers itself on a `window.BB` namespace —
same separation of concerns, still zero-install.

---

## Architecture

One direction of data flow, which is why the numbers on screen can never
disagree with the sound coming out:

```
   user input ──▶ BB.BinauralState ──▶ render() ──┬─▶ DOM
                       │                          ├─▶ BinauralEngine
                       │                          └─▶ BeatVisualizer / PeriodGauge
                       └──▶ localStorage
```

* `state.js` holds two modes and knows how to convert between them:
  * **manual** — the carriers are authoritative, `beat = |L − R|`
  * **target** — beat + centre are authoritative, `L,R = centre ∓ beat/2`
  Touching a control promotes its group to authoritative, so the app always
  shows what it is actually doing. It is pure JavaScript with no DOM or audio
  dependency, which makes it unit-testable in Node.
* `audio-engine.js` owns the graph and nothing else. It fades in and out
  (0.3 s) to avoid clicks, and retunes with a 25 ms time-constant so dragging a
  slider glides instead of zippering.
* `visualizer.js` reads its colours from the CSS custom properties, so the
  canvas palette follows the theme without a second source of truth.
* `app.js` is deliberately dumb: it renders state into the DOM and forwards
  events back into state.

---

## Tests

Both suites are plain Node, no dependencies:

```bash
cd binaural_beats
node test/logic.test.js     # band maths, mode conversions, clamping, presets
node test/dom.test.js       # parses index.html, boots the real app, drives it
```

The DOM suite runs the actual `index.html` and `app.js` against a ~150-line
mini-DOM and a fake `AudioContext`, then checks the real audio graph (two sine
oscillators, correct merger channels), the UI wiring (sliders, number boxes,
presets, mode switch, keyboard) and persistence. It catches id typos and null
dereferences that a syntax check cannot.

---

## Exporting a file

The **WAV** button renders the current pair with an `OfflineAudioContext` — the
same graph as the live engine (two sines, one hard-wired per channel), plus
half-second fades at each edge so the file can be looped without a click. It
renders faster than real time: a three-minute file takes a second or two.

Choose a preset length or **custom…** to type any duration in minutes (1–120).
The size estimate next to the button updates as you change it. Long files are
rendered in 100-second chunks and encoded to 16-bit PCM as they go, so the app
never has to hold a one-hour float buffer in memory. Chunk boundaries are
seamless: at the app's 0.01 Hz resolution, 100 seconds is always a whole number
of cycles for both tones.

Sizes, at 48 kHz / 16-bit stereo: **1 min ≈ 11 MB, 3 min ≈ 33 MB, 5 min ≈ 58 MB,
60 min ≈ 659 MB**. The finished download is still held in browser memory as a
Blob, so the practical limit depends on the device — the custom field stops at
two hours, and the estimate turns amber above 250 MB.

Ear-soloing is deliberately *not* baked into the file: a one-eared binaural beat
is not a thing.

## Crackle, clicks and dropouts

Pure sines have no business sounding scratchy, so noise here was always a
defect. There are only a few mechanisms that can produce it:

1. **Buffer underruns.** The audio callback missed its deadline, leaving a hole
   in the stream. Sounds like crackle, and it correlates with the machine being
   busy — which is why it showed up while dragging sliders or scrolling.
2. **Two graphs at once.** Tap play/stop quickly and the old fade-out overlaps
   the new start: double level (risking clipping) and two nearly identical
   tones fighting each other.
3. **Steps in the gain.** Any automation that jumps instead of ramping is a
   click by definition.
4. **Something outside the page.** Bluetooth link hiccups, a driver switching
   sample rates, or another app taking the audio device exclusively.

What the code does about 1-3:

* the drawing loop no longer reads layout (`getBoundingClientRect`) or allocates
  buffers per frame — both used to run 60 times a second against the main thread
  the audio thread depends on. It measures only when a `ResizeObserver` fires,
  reuses one sample buffer, caches the gradient, and paints at 30 fps;
* the context asks for `latencyHint: 'playback'` (a larger buffer) by default —
  switchable in **Audio diagnostics** if you would rather trade stability for
  latency;
* a restart silences any previous graph before building a new one;
* `setFrequencies` / `setVolume` ignore unchanged values instead of stacking
  automation events;
* the sleep-timer fade glides back to unity instead of stepping there when you
  re-arm it mid-fade.

For 4, open **Audio diagnostics**. Buffer underruns above 0% mean the browser
missed a deadline (raise the buffer). Underruns at 0% while you still hear
noise means the page is producing a clean signal and the problem is downstream —
headphones, cable, Bluetooth, or another application.

## Tweaking it

* **Presets** — add an object to `PRESETS` in `js/presets.js`
  (`{ id, name, band, beat, left, right, blurb }`). The UI is generated.
* **Band ranges** — `BANDS` in the same file; the readout, colours and band
  strip all derive from it.
* **Limits** — `LIMITS` in `js/state.js` (tone 20–1000 Hz, beat 0–40 Hz,
  centre 30–800 Hz).
* **Volume curve / ceiling** — `BinauralEngine.gainForVolume()` and `MAX_GAIN`
  in `js/audio-engine.js`.

Natural next steps, if you want them: a mono "amplitude beat" A/B toggle (route
both oscillators to both channels — a two-line change in the engine), a sleep
timer, or an `OscillatorNode` swap for an `AudioWorkletProcessor` if you ever
need sample-accurate phase control.

---

## Notes and safety

* Headphones are mandatory: two tones in one ear make an amplitude beat, which
  is a different (and much less interesting) phenomenon.
* Sine waves only — harmonics smear the beat.
* Volume is capped well below full scale; keep it moderate anyway, and don't
  fall asleep with headphones at high level.
* Works in current Chrome, Edge, Firefox and Safari. `localStorage` is optional
  and wrapped in `try/catch`, so the page still works in private modes that
  block it.
