/*!
 * logic.test.js — run with:  node test/logic.test.js
 * ---------------------------------------------------------------------------
 * The state model and domain maths are DOM-free, so they can be exercised in
 * plain Node. No test framework, no dependencies: just assertions.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* --------------------------------------------------------------- harness */
const root = path.join(__dirname, '..');
const sandbox = { console: console, window: {} };
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['js/presets.js', 'js/state.js', 'js/timer.js', 'js/wav.js']) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const BB = sandbox.window.BB;
const State = BB.BinauralState;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${expected}, got ${actual}`);
  }
}

function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > (tol == null ? 1e-9 : tol)) {
    throw new Error(`${label || 'value'}: expected ~${expected}, got ${actual}`);
  }
}

/* ---------------------------------------------------------- domain maths */
test('classify: band boundaries land where documented', () => {
  eq(BB.classify(0).key, 'unison');
  eq(BB.classify(0.2).key, 'sub');
  eq(BB.classify(0.5).key, 'delta');
  eq(BB.classify(3.99).key, 'delta');
  eq(BB.classify(4).key, 'theta');
  eq(BB.classify(7.83).key, 'theta');
  eq(BB.classify(8).key, 'alpha');
  eq(BB.classify(10).key, 'alpha');
  eq(BB.classify(13).key, 'beta');
  eq(BB.classify(29.9).key, 'beta');
  eq(BB.classify(30).key, 'gamma');
  eq(BB.classify(40).key, 'gamma');
});

test('split: beat + centre -> symmetric carriers', () => {
  const s = BB.split(10, 220);
  eq(s.left, 215);
  eq(s.right, 225);
  eq(BB.centreOf(s.left, s.right), 220);
});

test('split: fractional beat rates survive rounding', () => {
  const s = BB.split(7.83, 223.915);
  near(s.left, 220, 0.006);
  near(s.right, 227.83, 0.006);
});

test('every preset beat matches |right - left|', () => {
  for (const p of BB.presets) {
    near(Math.abs(p.right - p.left), p.beat, 0.001, `${p.id} beat`);
    eq(BB.classify(p.beat).key, p.band, `${p.id} band`);
  }
});

/* -------------------------------------------------------------- defaults */
test('defaults: 200 / 210 is a 10 Hz beat in alpha', () => {
  const st = new State();
  eq(st.left, 200);
  eq(st.right, 210);
  eq(st.beatHz, 10);
  eq(st.band.key, 'alpha');
});

/* ----------------------------------------------------------- manual mode */
test('manual: moving one carrier updates the derived beat', () => {
  const st = new State();
  st.setTone('right', 206);
  eq(st.beatHz, 6);
  eq(st.band.key, 'theta');
  eq(st.data.beat, 6, 'target control follows along');
  eq(st.data.centre, 203, 'centre follows along');
});

test('manual: tones are clamped to the legal range', () => {
  const st = new State();
  st.setTone('left', 5);
  eq(st.left, 20);
  st.setTone('left', 5000);
  eq(st.left, 1000);
});

test('manual: swapping ears keeps the beat but flips the carriers', () => {
  const st = new State();
  st.setTones(200, 210);
  st.swapEars();
  eq(st.left, 210);
  eq(st.right, 200);
  eq(st.beatHz, 10);
});

/* ----------------------------------------------------------- target mode */
test('target: setting the beat moves both carriers symmetrically', () => {
  const st = new State();
  st.setCentre(220);
  st.setBeat(6);
  eq(st.mode, 'target');
  eq(st.left, 217);
  eq(st.right, 223);
  eq(st.beatHz, 6);
});

test('target: switching modes is lossless for reachable settings', () => {
  const st = new State();
  st.setTones(180, 182.5);
  const before = { l: st.left, r: st.right };
  st.setMode('target');
  eq(st.left, before.l);
  eq(st.right, before.r);
  st.setMode('manual');
  eq(st.left, before.l);
  eq(st.right, before.r);
});

test('target: zero beat is allowed and means unison', () => {
  const st = new State();
  st.setCentre(200);
  st.setBeat(0);
  eq(st.left, 200);
  eq(st.right, 200);
  eq(st.beatHz, 0);
  eq(st.band.key, 'unison');
});

test('target: a clamped carrier reports the beat it can actually reach', () => {
  const st = new State();
  st.setCentre(30);
  st.setBeat(40);            // would need a 10 Hz carrier, below the floor
  eq(st.left, 20);
  eq(st.beatHz, st.data.beat, 'readout and target field agree');
  eq(st.data.beat, 30);
});

test('target: beat rate is clamped to 0..40', () => {
  const st = new State();
  st.setBeat(999);
  eq(st.data.beat, 40);
  st.setBeat(-5);
  eq(st.data.beat, 0);
});

test('target: dragging a carrier hands control back to manual', () => {
  const st = new State();
  st.setBeat(6);
  eq(st.mode, 'target');
  st.setTone('left', 300);
  eq(st.mode, 'manual');
  eq(st.left, 300);
});

/* --------------------------------------------------------------- presets */
test('preset: applied in manual mode sets both carriers exactly', () => {
  const st = new State();
  const p = BB.presets.find(x => x.id === 'schumann');
  st.applyPreset(p);
  eq(st.mode, 'manual');
  eq(st.left, 220);
  eq(st.right, 227.83);
  near(st.beatHz, 7.83, 0.0001);
});

test('preset: applied in target mode reproduces the same two tones', () => {
  const st = new State();
  st.setMode('target');
  for (const p of BB.presets) {
    st.applyPreset(p);
    near(st.left, p.left, 0.011, `${p.id} left`);
    near(st.right, p.right, 0.011, `${p.id} right`);
    near(st.beatHz, p.beat, 0.011, `${p.id} beat`);
  }
});

/* ------------------------------------------------------------ persistence */
test('hydrate: junk and out-of-range values are sanitised', () => {
  const st = new State({ left: 'abc', right: 99999, volume: 4, mode: 'nonsense', beat: -1 });
  eq(st.left, 200, 'bad number falls back to default');
  eq(st.right, 1000, 'upper clamp');
  eq(st.volume, 1, 'volume clamp');
  eq(st.mode, 'manual', 'bad mode rejected');
});

test('hydrate: a saved target-mode session restores exactly', () => {
  const st = new State({ mode: 'target', beat: 7.83, centre: 220, volume: 0.3 });
  eq(st.mode, 'target');
  eq(st.left, 216.09);
  eq(st.right, 223.92);
  near(st.beatHz, 7.83, 0.01);
});

test('toJSON round-trips through hydrate', () => {
  const a = new State();
  a.setTones(174, 175);
  a.setVolume(0.66);
  const b = new State(a.toJSON());
  eq(b.left, 174);
  eq(b.right, 175);
  eq(b.volume, 0.66);
});

/* ---------------------------------------------------------------- events */
test('subscribers hear about real changes only', () => {
  const st = new State();
  let calls = 0;
  const off = st.subscribe(() => calls++);
  st.setTone('left', 200);   // no change
  eq(calls, 0, 'no-op emits nothing');
  st.setTone('left', 210);
  eq(calls, 1, 'real change emits once');
  st.setVolume(0.9);
  eq(calls, 2);
  off();
  st.setVolume(0.1);
  eq(calls, 2, 'unsubscribe works');
});

test('reset returns to the shipped defaults', () => {
  const st = new State();
  st.setTones(400, 440);
  st.setVolume(0);
  st.reset();
  eq(st.left, 200);
  eq(st.right, 210);
  eq(st.volume, 0.45);
  eq(st.mode, 'manual');
});

/* ----------------------------------------------------------- sleep timer */
const SleepTimer = BB.SleepTimer;

function fakeBuffer(channels, sampleRate, data) {
  return {
    numberOfChannels: channels,
    length: data[0].length,
    sampleRate,
    getChannelData: (i) => data[i]
  };
}

test('timer: off means no countdown and no fade', () => {
  const t = new SleepTimer(60);
  eq(t.active, false);
  eq(t.remainingMs(1000), 0);
  eq(t.fadeFactor(1000), 1);
  eq(t.isDone(1000), false);
});

test('timer: counts down in real time', () => {
  const t = new SleepTimer(60);
  t.start(10, 0);
  eq(t.active, true);
  eq(t.remainingMs(0), 600000);
  eq(t.remainingMs(300000), 300000);
  eq(t.remainingMs(600000), 0);
  eq(t.isDone(599000), false);
  eq(t.isDone(600000), true);
});

test('timer: holds full level until the final fade window', () => {
  const t = new SleepTimer(60);
  t.start(10, 0);
  eq(t.fadeFactor(0), 1, 'start');
  eq(t.fadeFactor(300000), 1, 'halfway');
  eq(t.fadeFactor(540000), 1, 'exactly 60 s left');
  near(t.fadeFactor(570000), Math.cos(Math.PI / 4), 1e-9, 'halfway through the fade');
  eq(t.fadeFactor(600000), 0, 'silent at the end');
});

test('timer: the fade is monotonic and never leaves 0..1', () => {
  const t = new SleepTimer(60);
  t.start(5, 0);
  let previous = 1;
  for (let ms = 240000; ms <= 300000; ms += 5000) {
    const f = t.fadeFactor(ms);
    if (f > previous + 1e-12) throw new Error('fade went back up at ' + ms);
    if (f < 0 || f > 1) throw new Error('fade out of range at ' + ms);
    previous = f;
  }
});

test('timer: a zero or negative request switches it off', () => {
  const t = new SleepTimer(60);
  eq(t.start(0, 0), false);
  eq(t.active, false);
  t.start(30, 0);
  eq(t.active, true);
  t.stop();
  eq(t.active, false);
  eq(t.fadeFactor(0), 1, 'no fade once cancelled');
});

test('timer: a fade longer than the session just starts fading at once', () => {
  const t = new SleepTimer(60);
  t.start(0.5, 0);          // 30 s session, 60 s fade
  eq(t.fadeFactor(0) < 1, true);
  eq(t.fadeFactor(30000), 0);
});

test('timer: countdown formatting', () => {
  eq(BB.formatCountdown(600000), '10:00');
  eq(BB.formatCountdown(65000), '1:05');
  eq(BB.formatCountdown(7000), '0:07');
  eq(BB.formatCountdown(0), '0:00');
  eq(BB.formatCountdown(-5), '0:00');
});

/* --------------------------------------------------------------- wav export */
test('wav: header describes the stream correctly', () => {
  const buffer = fakeBuffer(2, 44100, [
    new Float32Array([0, 0.5, -0.5, 1]),
    new Float32Array([-1, 0.25, 0, -0.25])
  ]);
  const bytes = BB.encodeWav(buffer);
  const view = new DataView(bytes);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1),
    view.getUint8(o + 2), view.getUint8(o + 3));

  eq(tag(0), 'RIFF');
  eq(view.getUint32(4, true), 36 + 16, 'RIFF size');
  eq(tag(8), 'WAVE');
  eq(tag(12), 'fmt ');
  eq(view.getUint32(16, true), 16, 'fmt chunk size');
  eq(view.getUint16(20, true), 1, 'PCM');
  eq(view.getUint16(22, true), 2, 'channels');
  eq(view.getUint32(24, true), 44100, 'sample rate');
  eq(view.getUint32(28, true), 44100 * 4, 'byte rate');
  eq(view.getUint16(32, true), 4, 'block align');
  eq(view.getUint16(34, true), 16, 'bit depth');
  eq(tag(36), 'data');
  eq(view.getUint32(40, true), 16, 'data size');
  eq(bytes.byteLength, 44 + 16);
});

test('wav: samples are interleaved and scaled to 16-bit', () => {
  const buffer = fakeBuffer(2, 44100, [
    new Float32Array([0, 0.5, -0.5, 1]),
    new Float32Array([-1, 0.25, 0, -0.25])
  ]);
  const view = new DataView(BB.encodeWav(buffer));
  const sample = (i) => view.getInt16(44 + i * 2, true);

  eq(sample(0), 0, 'L frame 0');
  eq(sample(1), -32768, 'R frame 0 (full negative)');
  eq(sample(2), 16384, 'L frame 1');
  eq(sample(3), 8192, 'R frame 1');
  eq(sample(4), -16384, 'L frame 2');
  eq(sample(5), 0, 'R frame 2');
  eq(sample(6), 32767, 'L frame 3 (full positive)');
  eq(sample(7), -8192, 'R frame 3');
});

test('wav: out-of-range samples clip instead of wrapping', () => {
  const buffer = fakeBuffer(1, 8000, [new Float32Array([2, -3, 0.00001])]);
  const view = new DataView(BB.encodeWav(buffer));
  eq(view.getInt16(44, true), 32767);
  eq(view.getInt16(46, true), -32768);
  eq(view.getInt16(48, true), 0);
});

test('wav: size estimates line up with the encoder', () => {
  const seconds = 2;
  const frames = 48000 * seconds;
  const data = [new Float32Array(frames), new Float32Array(frames)];
  const actual = BB.encodeWav(fakeBuffer(2, 48000, data)).byteLength;
  eq(BB.estimateBytes(seconds, 48000, 2), actual);
  eq(BB.formatBytes(1024 * 1024), '1.0 MB');
  eq(BB.formatBytes(2048), '2 kB');
});

/* --------------------------------------------------------------- results */
console.log('');
for (const f of failures) console.log('  FAIL  ' + f.name + '\n        ' + f.message);
console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
