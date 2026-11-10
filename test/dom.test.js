/*!
 * dom.test.js — run with:  node test/dom.test.js
 * ---------------------------------------------------------------------------
 * A dependency-free integration test. It parses the real index.html with a
 * ~150 line mini-DOM, loads the real scripts against it, fakes the Web Audio
 * API, and then drives the UI the way a user would: move a slider, click a
 * preset, switch modes, press play.
 *
 * The point is to catch the boring-but-fatal stuff: an id typo, a null
 * reference, a wiring mistake in the audio graph — none of which a syntax
 * check or a logic unit test can see.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ========================================================================== *
 *  Mini DOM
 * ========================================================================== */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...n) { n.forEach(x => x && this.set.add(x)); }
  remove(...n) { n.forEach(x => this.set.delete(x)); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this.set.has(n) : !!force;
    if (on) this.set.add(n); else this.set.delete(n);
    return on;
  }
  get value() { return Array.from(this.set).join(' '); }
}

/** Emulates CSSStyleDeclaration closely enough for `el.style.left = '5%'`
 *  and `el.style.setProperty('--fill', '50%')` to be interchangeable. */
function makeStyle() {
  const props = {};
  return new Proxy(props, {
    get(target, key) {
      if (key === 'setProperty') return (name, value) => { target[name] = String(value); };
      if (key === 'getPropertyValue') return (name) => target[name] || '';
      if (key === 'removeProperty') return (name) => { delete target[name]; };
      return target[key];
    },
    set(target, key, value) { target[key] = String(value); return true; }
  });
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source',
  'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.style = makeStyle();
    this.children = [];
    this.parentNode = null;
    this.text = '';
    this.listeners = {};
    this.classList = new ClassList();
    this.id = '';
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.type = '';
    this.title = '';
    this.disabled = false;
  }

  get className() { return this.classList.value; }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  setAttribute(name, value) {
    value = value == null ? '' : String(value);
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    else if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
    else if (['value', 'min', 'max', 'step', 'type', 'title'].includes(name)) {
      this[name] = value;
    }
  }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (child) child.parentNode = null;
    return child;
  }

  get textContent() {
    if (this.text) return this.text;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this.text = String(v); this.children = []; }

  set innerHTML(v) {
    if (v !== '') throw new Error('mini-DOM only supports innerHTML = ""');
    this.children = [];
    this.text = '';
  }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  /** Bubble a fake event up through the ancestors, like a real browser. */
  dispatch(type, extra) {
    const ev = Object.assign({
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {}
    }, extra || {});
    let node = this;
    while (node) {
      (node.listeners[type] || []).forEach(fn => fn.call(node, ev));
      node = node.parentNode;
    }
    return ev;
  }

  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { doc.activeElement = this; }
  blur() {
    if (doc.activeElement === this) doc.activeElement = null;
    this.dispatch('blur');
  }

  getBoundingClientRect() {
    // Counted so tests can prove the animation loop never re-reads layout.
    this.rectReads = (this.rectReads || 0) + 1;
    return { width: 800, height: 190, top: 0, left: 0, right: 800, bottom: 190 };
  }
  getContext() {
    if (!this._ctx) this._ctx = makeCanvasContext();
    return this._ctx;
  }

  querySelectorAll(selector) {
    const out = [];
    const test = compileSelector(selector);
    const walk = (node) => {
      for (const child of node.children) {
        if (test(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function compileSelector(selector) {
  const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
  return (el) => parts.some(part => {
    const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(part);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const tokens = m[2].match(/[.#][\w-]+/g) || [];
    return tokens.every(tok => tok[0] === '.'
      ? el.classList.contains(tok.slice(1))
      : el.id === tok.slice(1));
  });
}

/**
 * Every 2D context call is a no-op, but the calls are recorded in `calls` so
 * tests can assert on what was actually drawn. Gradients return a stub.
 */
function makeCanvasContext() {
  const target = { calls: [] };
  return new Proxy(target, {
    get(t, key) {
      if (key === 'canvas') return null;
      if (key === 'calls') return t.calls;
      if (!(key in t)) {
        t[key] = (...args) => {
          t.calls.push([key].concat(args));
          if (key === 'createLinearGradient' || key === 'createRadialGradient') {
            return { addColorStop() {} };
          }
          if (key === 'measureText') return { width: 10 };
          return undefined;
        };
      }
      return t[key];
    },
    set(t, key, value) { t[key] = value; return true; }
  });
}

class Document extends El {
  constructor() {
    super('#document');
    this.readyState = 'loading';
    this.activeElement = null;
    this.hidden = false;
    this.documentElement = null;
    this.body = null;
  }
  createElement(tag) { const el = new El(tag); el.ownerDocument = this; return el; }
  getElementById(id) {
    let found = null;
    const walk = (node) => {
      for (const child of node.children) {
        if (!found && child.id === id) found = child;
        if (!found) walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelectorAll(sel) {
    const out = [];
    const test = compileSelector(sel);
    const walk = (node) => {
      for (const child of node.children) {
        if (test(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/* ------------------------------------------------------------ html parsing */
function parseHTML(src, doc) {
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m;

  const pushText = (raw) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const top = stack[stack.length - 1];
    top.text = (top.text || '') + text + ' ';
  };

  while ((m = re.exec(src))) {
    if (m.index > last) pushText(src.slice(last, m.index));
    last = re.lastIndex;

    if (!m[1] && !m[2]) continue;               // comment or doctype

    if (m[1]) {                                  // closing tag
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }

    const tag = m[2].toLowerCase();
    const el = doc.createElement(tag);
    applyAttributes(el, m[3] || '');
    stack[stack.length - 1].appendChild(el);
    if (!VOID_TAGS.has(tag) && !m[4]) stack.push(el);
  }
  if (last < src.length) pushText(src.slice(last));
}

function applyAttributes(el, raw) {
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] || ''));
    el.setAttribute(m[1], value);
  }
}

/* ========================================================================== *
 *  Fake Web Audio API
 * ========================================================================== */

class Param {
  constructor(value, name) {
    this.value = value;
    this.name = name;
    this.calls = [];
  }
  setValueAtTime(v, t) { this.value = v; this.calls.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.value = v; this.calls.push(['ramp', v, t]); return this; }
  setTargetAtTime(v, t, c) { this.value = v; this.calls.push(['target', v, t, c]); return this; }
  setValueCurveAtTime(curve, t, d) {
    this.value = curve[curve.length - 1];
    this.calls.push(['curve', t, d, curve.length]);
    return this;
  }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
}

class AudioNodeStub {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = []; }
  connect(dest, output, input) {
    this.outputs.push({ dest, output, input });
    return dest;                        // the real API returns the destination
  }
  disconnect() { this.outputs.length = 0; }
}

class GainStub extends AudioNodeStub {
  constructor(ctx) { super(ctx, 'gain'); this.gain = new Param(1, 'gain'); }
}
class OscStub extends AudioNodeStub {
  constructor(ctx) {
    super(ctx, 'oscillator');
    this.type = 'sine';
    this.frequency = new Param(440, 'frequency');
    this.started = false;
    this.stopped = false;
  }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class MergerStub extends AudioNodeStub {
  constructor(ctx, channels) { super(ctx, 'merger'); this.channels = channels; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new AudioNodeStub(this, 'destination');
    this.nodes = [];
  }
  createGain() { const n = new GainStub(this); this.nodes.push(n); return n; }
  createOscillator() { const n = new OscStub(this); this.nodes.push(n); return n; }
  createChannelMerger(ch) { const n = new MergerStub(this, ch); this.nodes.push(n); return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

/** Offline rendering: hands back a tiny buffer so the WAV encoder stays cheap. */
class FakeOfflineAudioContext extends FakeAudioContext {
  constructor(channels, length, sampleRate) {
    super();
    this.channelCount = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }
  startRendering() {
    const frames = Math.min(this.length, 16);
    const channel = () => {
      const data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) data[i] = Math.sin(i * 0.7) * 0.25;
      return data;
    };
    const data = [channel()];
    if (this.channelCount > 1) data.push(channel());
    this.rendered = {
      numberOfChannels: this.channelCount,
      length: frames,
      sampleRate: this.sampleRate,
      getChannelData: (i) => data[i]
    };
    return Promise.resolve(this.rendered);
  }
}

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts || [];
    this.type = (options && options.type) || '';
    this.size = this.parts.reduce((n, p) => n + (p && p.byteLength ? p.byteLength : 0), 0);
  }
}

/* ========================================================================== *
 *  Sandbox
 * ========================================================================== */

const doc = new Document();
parseHTML(read('index.html'), doc);
doc.documentElement = doc.querySelector('html');
doc.body = doc.querySelector('body');

let now = 1000;
const rafCallbacks = new Map();
let rafId = 0;
const timers = [];
const intervals = [];

const storage = new Map();

const windowStub = {
  console,
  document: doc,
  devicePixelRatio: 1,
  performance: { now: () => now },
  getComputedStyle: (el) => el.style,
  requestAnimationFrame: (fn) => {
    const id = ++rafId;
    rafCallbacks.set(id, fn);
    return id;
  },
  cancelAnimationFrame: (id) => { rafCallbacks.delete(id); },
  setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; },
  clearInterval: () => {},
  Blob: FakeBlob,
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  OfflineAudioContext: FakeOfflineAudioContext,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  },
  AudioContext: FakeAudioContext,
  addEventListener: (type, fn) => doc.addEventListener(type, fn),
  location: { href: 'file:///home/user/binaural_beats/index.html' }
};
windowStub.window = windowStub;
windowStub.globalThis = windowStub;

const sandbox = vm.createContext(windowStub);

for (const file of ['js/presets.js', 'js/state.js', 'js/audio-engine.js',
                    'js/visualizer.js', 'js/timer.js', 'js/wav.js',
                    'js/export.js', 'js/app.js']) {
  vm.runInContext(read(file), sandbox, { filename: file });
}

/* ========================================================================== *
 *  Test harness
 * ========================================================================== */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('async tests must be awaited explicitly');
    }
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > (tol == null ? 1e-9 : tol)) {
    throw new Error(`${label || 'value'}: expected ~${expected}, got ${actual}`);
  }
}

const $ = (id) => doc.getElementById(id);
const byClass = (sel) => doc.querySelectorAll(sel);

function setInput(el, value) {
  el.value = String(value);
  return el.dispatch('input');
}

function flushFrames(n) {
  for (let i = 0; i < n; i++) {
    now += 16;
    // Snapshot then clear, like a real frame: callbacks queued during the
    // frame (including self-rescheduling ones) run on the *next* frame.
    const pending = Array.from(rafCallbacks.values());
    rafCallbacks.clear();
    pending.forEach(fn => fn(now));
  }
}

function flushTimers() {
  const queue = timers.splice(0, timers.length);
  queue.forEach(fn => fn());
}

const tick = () => new Promise(r => setImmediate(r));

/* ========================================================================== *
 *  Boot
 * ========================================================================== */

doc.dispatch('DOMContentLoaded');

test('boot: the page renders the stored default 200 / 210 Hz pair', () => {
  eq($('beat-value').textContent, '10.00');
  eq($('band-pill').textContent, 'Alpha');
  eq($('left-num').value, '200');
  eq($('right-num').value, '210');
  eq($('beat-math').textContent, '210.00 − 200.00 Hz');
});

test('boot: the theme attribute follows the band', () => {
  eq(doc.documentElement.dataset.band, 'alpha');
});

test('boot: band strip has one segment per band plus a marker', () => {
  eq($('band-strip').children.length, 6);
  eq(byClass('.bandstrip__seg').length, 5);
  eq($('band-marker').style.getPropertyValue('left').endsWith('%'), true);
});

test('boot: eight preset chips are generated', () => {
  eq($('preset-grid').children.length, 8);
  eq(byClass('.chip').length, 8);
});

test('boot: sliders start painted with a fill percentage', () => {
  eq($('left-range').style.getPropertyValue('--fill'), '18.37%'); // (200-20)/980
});

test('boot: nothing is playing yet', () => {
  eq($('play').classList.contains('is-playing'), false);
  eq($('play').getAttribute('aria-pressed'), 'false');
  eq($('status').textContent, 'idle');
});

/* ========================================================================== *
 *  Manual interaction
 * ========================================================================== */

test('manual: moving the right slider changes the beat readout', () => {
  setInput($('right-range'), '206');
  eq($('beat-value').textContent, '6.00');
  eq($('band-pill').textContent, 'Theta');
  eq($('right-num').value, '206');
  eq(doc.documentElement.dataset.band, 'theta');
  eq($('beat-math').textContent, '206.00 − 200.00 Hz');
});

test('manual: typing into a number box commits the value', () => {
  setInput($('left-num'), '204');
  eq($('beat-value').textContent, '2.00');
  eq($('left-range').value, '204');
  eq($('band-pill').textContent, 'Delta');
});

test('manual: out-of-range typing is held until commit, then clamped', () => {
  const el = $('right-num');
  setInput(el, '19');            // below min: ignored while typing
  eq($('right-num').value, '19', 'field keeps what was typed');
  eq($('beat-value').textContent, '2.00', 'state untouched');

  el.value = '19';
  el.dispatch('change');         // committing clamps to 20
  eq(el.value, '20');
  eq($('right-range').value, '20');
});

test('manual: swap ears flips the carriers, keeps the beat', () => {
  $('left-num').value = '200';
  $('left-num').dispatch('change');
  $('right-num').value = '210';
  $('right-num').dispatch('change');

  $('swap').click();
  eq($('left-num').value, '210');
  eq($('right-num').value, '200');
  eq($('beat-value').textContent, '10.00');
});

test('presets: clicking alpha sets 210 / 220 and highlights itself', () => {
  const chip = byClass('.chip').find(c => c.dataset.preset === 'alpha');
  chip.click();
  eq($('left-num').value, '210');
  eq($('right-num').value, '220');
  eq($('beat-value').textContent, '10.00');
  eq(chip.classList.contains('is-active'), true);
  eq(byClass('.chip').filter(c => c.classList.contains('is-active')).length, 1);
});

test('presets: unison really is unison', () => {
  byClass('.chip').find(c => c.dataset.preset === 'unison').click();
  eq($('left-num').value, '220');
  eq($('right-num').value, '220');
  eq($('beat-value').textContent, '0.00');
  eq($('band-pill').textContent, 'Unison');
  eq($('period-cap').textContent, 'period · —');
  eq($('stage-tag').textContent, 'beat wave · no beat');
});

test('gauge: the arc sweep is proportional to the beat period', () => {
  const ctx = $('period-dial').getContext('2d');
  flushFrames(2);                     // drain anything queued
  ctx.calls.length = 0;

  byClass('.chip').find(c => c.dataset.preset === 'alpha').click();   // 10 Hz => 100 ms
  flushFrames(2);

  const arcs = ctx.calls.filter(c => c[0] === 'arc');
  eq(arcs.length >= 2, true, 'a track and a sweep were drawn');

  // [name, cx, cy, r, start, end] — skip the full-circle track and the dot
  const sweep = arcs.filter(a => a[3] > 10 && (a[5] - a[4]) < Math.PI * 2 - 0.01)[0];
  eq(!!sweep, true, 'the period arc exists');

  const LO = Math.log(0.02), HI = Math.log(2);
  const expected = ((Math.log(0.1) - LO) / (HI - LO)) * Math.PI * 2;
  near(sweep[5] - sweep[4], expected, 0.02, 'sweep angle for 100 ms');
});

test('envelope: the canvas is drawn as a filled, mirrored curve', () => {
  const ctx = $('beat-canvas').getContext('2d');
  flushFrames(2);
  ctx.calls.length = 0;

  setInput($('beat-num'), '6');       // forces a redraw
  flushFrames(2);

  const names = ctx.calls.map(c => c[0]);
  eq(names.includes('lineTo'), true, 'the curve was traced');
  eq(names.includes('fill'), true, 'and filled');
  eq(ctx.calls.filter(c => c[0] === 'lineTo').length > 100, true, 'sampled densely');
});

test('monitoring: the stage label tracks the beat rate', () => {
  byClass('.chip').find(c => c.dataset.preset === 'alpha').click();
  eq($('stage-tag').textContent, 'beat wave · 10 Hz · slowed');
  eq($('period-cap').textContent, 'period · 100 ms');

  byClass('.chip').find(c => c.dataset.preset === 'delta').click();   // 2.5 Hz
  eq($('stage-tag').textContent, 'beat wave · 2.5 Hz', 'under the cap: no caveat');

  byClass('.chip').find(c => c.dataset.preset === 'gamma').click();
  eq($('stage-tag').textContent, 'beat wave · 40 Hz · slowed');
  eq($('period-cap').textContent, 'period · 25 ms');

  byClass('.chip').find(c => c.dataset.preset === 'swell').click();
  eq($('stage-tag').textContent, 'beat wave · 0.4 Hz');
  eq($('period-cap').textContent, 'period · 2.50 s');
});

test('wave: one crest per beat, but the drift never exceeds 3 Hz', () => {
  const viz = sandbox.BBApp.viz;

  byClass('.chip').find(c => c.dataset.preset === 'alpha').click();   // 10 Hz
  eq(viz.beat, 10, 'wave follows the beat');
  eq(viz.visualRate, 3, '10 Hz is slowed to the 3 Hz cap');

  byClass('.chip').find(c => c.dataset.preset === 'swell').click();   // 0.4 Hz
  eq(viz.visualRate, 0.4, 'slow beats run at their true rate');

  byClass('.chip').find(c => c.dataset.preset === 'delta').click();   // 2.5 Hz
  eq(viz.visualRate, 2.5, 'still under the cap');
});

test('wave: the phase advances while playing and freezes when stopped', () => {
  const viz = sandbox.BBApp.viz;
  byClass('.chip').find(c => c.dataset.preset === 'theta').click();   // 6 Hz -> capped at 3

  viz.setPlaying(true);
  const before = viz.phase;
  flushFrames(10);                     // ~0.16 s of simulated time
  const moved = viz.phase;
  eq(moved !== before, true, 'the wave moved');
  near(Math.abs(moved - before), 0.16 * 3, 0.05, 'advance matches the capped rate');

  viz.setPlaying(false);
  const frozen = viz.phase;
  flushFrames(10);
  eq(viz.phase, frozen, 'a stopped wave stays put');
});

/* ========================================================================== *
 *  Target mode (the bonus feature)
 * ========================================================================== */

test('target: switching modes keeps the current tones', () => {
  byClass('.chip').find(c => c.dataset.preset === 'alpha').click();
  byClass('.segmented__btn').find(b => b.dataset.mode === 'target').click();

  eq(doc.querySelector('.workspace').dataset.mode, 'target');
  eq($('left-num').value, '210');
  eq($('right-num').value, '220');
  eq($('beat-num').value, '10');
  eq($('centre-num').value, '215');
});

test('target: entering a beat rate derives both carriers symmetrically', () => {
  setInput($('beat-num'), '6');
  eq($('left-num').value, '212');
  eq($('right-num').value, '218');
  eq($('beat-value').textContent, '6.00');
  eq($('target-left').textContent, '212.00');
  eq($('target-right').textContent, '218.00');
});

test('target: moving the centre pitch slides both carriers', () => {
  setInput($('centre-range'), '400');
  eq($('left-num').value, '397');
  eq($('right-num').value, '403');
  eq($('beat-value').textContent, '6.00');
});

test('target: fractional beats survive the round trip', () => {
  setInput($('beat-num'), '7.83');
  eq($('beat-value').textContent, '7.83');
  near(parseFloat($('left-num').value), 396.085, 0.011, 'left');
  near(parseFloat($('right-num').value), 403.915, 0.011, 'right');
});

test('target: dragging a carrier hands the wheel back to manual', () => {
  setInput($('left-range'), '300');
  eq(doc.querySelector('.workspace').dataset.mode, 'manual');
  eq(doc.querySelectorAll('.segmented__btn')
    .find(b => b.dataset.mode === 'manual').getAttribute('aria-checked'), 'true');
  eq($('left-num').value, '300');
});

/* ========================================================================== *
 *  Mode hint, ear check, export plumbing
 * ========================================================================== */

test('mode hint explains which numbers are in charge', () => {
  byClass('.segmented__btn').find(b => b.dataset.mode === 'target').click();
  eq($('mode-hint').textContent.indexOf('calculated') > -1, true,
     'target mode promises the faders are computed');

  byClass('.segmented__btn').find(b => b.dataset.mode === 'manual').click();
  eq($('mode-hint').textContent.indexOf('simply follow') > -1, true,
     'manual mode says the faders lead');
});

test('ear check: solo is a toggle and reports itself', () => {
  const engine = sandbox.BBApp.engine;

  $('solo-left').click();
  eq(engine.solo, 'left');
  eq($('solo-left').getAttribute('aria-pressed'), 'true');
  eq(doc.querySelector('.workspace').dataset.solo, 'left');

  $('solo-right').click();
  eq(engine.solo, 'right');
  eq($('solo-left').getAttribute('aria-pressed'), 'false');
  eq($('solo-right').getAttribute('aria-pressed'), 'true');

  $('solo-right').click();                       // toggle itself off
  eq(engine.solo, 'both');
  eq(doc.querySelector('.workspace').dataset.solo, 'both');
});

test('performance: drawing never re-reads layout', () => {
  const viz = sandbox.BBApp.viz;
  const canvas = $('beat-canvas');

  viz.setPlaying(true);
  flushFrames(4);                          // first frame measures once
  const before = canvas.rectReads || 0;

  flushFrames(40);                         // ~0.6 s of animation
  eq((canvas.rectReads || 0) - before, 0,
     'getBoundingClientRect must not be called from the draw loop');

  viz.setPlaying(false);
});

test('engine: the stable buffer is the default', () => {
  eq(sandbox.BBApp.engine.diagnostics.latencyHint, 'playback');
});

test('export: filename carries both carriers, the beat and the length', () => {
  eq(sandbox.BB.exporter.filename({ left: 200, right: 210, seconds: 180 }),
     'binaural-200.00-210.00Hz-beat-10.00Hz-180s.wav');
  eq(sandbox.BB.exporter.filename({ left: 400, right: 440, seconds: 60 }),
     'binaural-400.00-440.00Hz-beat-40.00Hz-60s.wav');
});

/* ========================================================================== *
 *  Audio graph
 * ========================================================================== */

async function audioTests() {
  // Reset to a known pair and start playback.
  byClass('.chip').find(c => c.dataset.preset === 'alpha').click();
  $('play').click();
  await tick();
  await tick();

  const ctx = sandbox.BBApp.engine.ctx;
  const oscs = ctx ? ctx.nodes.filter(n => n.kind === 'oscillator') : [];
  const mergers = ctx ? ctx.nodes.filter(n => n.kind === 'merger') : [];

  // The session fade sits between the master gain and the destination.
  const gains = () => ctx.nodes.filter(n => n.kind === 'gain');
  const fadeGain = () => gains().find(n => n.outputs.some(o => o.dest === ctx.destination));
  const masterGain = () => gains().find(n => n.outputs.some(o => o.dest === fadeGain()));

  check('audio: one context, two sine oscillators, one merger', () => {
    eq(oscs.length, 2, 'oscillator count');
    eq(oscs.every(o => o.type === 'sine'), true, 'all oscillators are sine');
    eq(mergers.length, 1, 'merger count');
    eq(mergers[0].channels, 2, 'merger channels');
  });

  check('audio: the two oscillators carry the two selected frequencies', () => {
    near(oscs[0].frequency.value, 210, 0.001, 'left frequency');
    near(oscs[1].frequency.value, 220, 0.001, 'right frequency');
  });

  check('audio: each tone is hard-wired to its own stereo channel', () => {
    const toMerger = (osc) => osc.outputs[0].dest.outputs[0];
    eq(toMerger(oscs[0]).input, 0, 'left lands on channel 0');
    eq(toMerger(oscs[1]).input, 1, 'right lands on channel 1');
    eq(toMerger(oscs[0]).dest.channels, 2);
  });

  check('audio: oscillators start only once the gain has faded in', () => {
    eq(oscs[0].started, true);
    eq(oscs[1].started, true);
    const master = masterGain();
    eq(!!master, true, 'a master gain is connected to the destination');
    const calls = master.gain.calls.map(c => c[0]);
    eq(calls[0], 'set', 'gain starts at 0');
    eq(calls[1], 'ramp', 'then ramps up');
    near(master.gain.calls[0][1], 0, 1e-9, 'starting gain');
  });

  check('audio: the transport and status reflect playback', () => {
    eq($('play').classList.contains('is-playing'), true);
    eq($('play').getAttribute('aria-pressed'), 'true');
    eq($('play-label').textContent, 'Stop tones');
    eq($('status').textContent.startsWith('playing'), true);
  });

  check('audio: changing a frequency while playing retunes, not restarts', () => {
    const before = oscs.length;
    setInput($('right-range'), '260');
    near(oscs[1].frequency.value, 260, 0.001, 'retuned frequency');
    eq(oscs.length, before, 'no new oscillators were created');
  });

  check('audio: the volume slider reaches the master gain', () => {
    setInput($('volume-range'), '20');
    const master = masterGain();
    const expected = windowStub.BB.BinauralEngine.gainForVolume(0.2);
    near(master.gain.value, expected, 1e-9, 'master gain');
    eq($('volume-out').textContent, '20%');
  });

  check('audio: stopping fades out and shuts the oscillators down', () => {
    $('play').click();
    eq(oscs[0].stopped, true);
    eq(oscs[1].stopped, true);
    eq($('play').classList.contains('is-playing'), false);
    eq($('status').textContent, 'idle');
  });

  check('persistence: the session is written to localStorage', () => {
    flushTimers();
    const raw = storage.get('binaural-lab/v1');
    eq(typeof raw, 'string', 'something was stored');
    const saved = JSON.parse(raw);
    eq(saved.right, 260);
    eq(saved.volume, 0.2);
    eq(saved.mode, 'manual');
  });

  check('animation: the frame loop survives a few hundred frames', () => {
    byClass('.chip').find(c => c.dataset.preset === 'theta').click();
    flushFrames(120);
    const viz = doc.getElementById('beat-canvas');
    eq(viz.width, 800, 'canvas was sized from the DOM');
  });

  await checkAsync('ear check: a new session always starts in stereo', async () => {
    const engine = sandbox.BBApp.engine;
    if (engine.isPlaying) $('play').click();

    $('solo-left').click();
    eq(engine.solo, 'left');

    $('play').click();
    await tick();
    eq(engine.solo, 'both', 'solo is cleared when playback starts');
    eq($('solo-left').getAttribute('aria-pressed'), 'false');

    $('solo-left').click();
    eq(engine._nodes.gains[1].gain.value, 0, 'right channel muted');
    eq(engine._nodes.gains[0].gain.value, 1, 'left channel untouched');

    $('play').click();                             // stop again
    eq(engine.isPlaying, false);
  });

  await checkAsync('session: a duration starts playback and counts down', async () => {
    const sel = $('timer-select');
    sel.value = '10';
    sel.dispatch('change');
    await tick();

    eq(sandbox.BBApp.timer.active, true, 'timer armed');
    eq($('timer-count').hidden, false, 'countdown is visible');
    eq($('timer-count').textContent, '10:00');
    eq(sandbox.BBApp.engine.isPlaying, true, 'choosing a session starts the tones');
    eq(sandbox.BBApp.engine.hasScheduledFade, true, 'fade runs on the audio clock');

    // 10 min session, 60 s fade => the curve starts at +9 min
    const fadeCalls = sandbox.BBApp.engine._nodes.fade.gain.calls.filter(c => c[0] === 'curve');
    eq(fadeCalls.length, 1, 'one curve scheduled');
    near(fadeCalls[0][1], 540, 1, 'fade starts after 9 minutes');
    near(fadeCalls[0][2], 60, 0.01, 'fade lasts a minute');

    sel.value = '0';
    sel.dispatch('change');
    eq(sandbox.BBApp.timer.active, false, 'cancelled');
    eq($('timer-count').hidden, true);
    eq(sandbox.BBApp.engine.hasScheduledFade, false, 'the scheduled fade is dropped');

    $('play').click();
    eq(sandbox.BBApp.engine.isPlaying, false);
  });

  await checkAsync('export: renders and hands over a wav download', async () => {
    byClass('.chip').find(c => c.dataset.preset === 'alpha').click();   // 210 / 220
    $('export-length').value = '180';
    $('export-btn').click();

    await tick(); await tick(); await tick();

    eq($('notice').hidden, false, 'a notice was shown');
    eq($('notice').textContent.indexOf(
      'saved binaural-210.00-220.00Hz-beat-10.00Hz-180s.wav'), 0,
      'notice says: ' + $('notice').textContent);
    eq($('export-btn').disabled, false, 'the button comes back');
    eq($('export-btn').textContent.trim(), 'WAV');
  });

  await checkAsync('keyboard: space toggles playback when nothing else has focus', async () => {
    doc.dispatch('keydown', { code: 'Space', key: ' ', target: doc.body });
    await tick();
    eq($('status').textContent.startsWith('playing'), true, 'space started playback');

    doc.dispatch('keydown', { code: 'Space', key: ' ', target: doc.body });
    eq($('status').textContent, 'idle', 'space stopped it again');
  });

  await checkAsync('keyboard: space inside a number field is left alone', async () => {
    const ev = doc.dispatch('keydown', { code: 'Space', key: ' ', target: $('left-num') });
    await tick();
    eq(ev.defaultPrevented, false);
    eq($('status').textContent, 'idle');
  });

  await checkAsync('engine: a redundant retune schedules no automation', async () => {
    byClass('.chip').find(c => c.dataset.preset === 'alpha').click();   // 210 / 220
    $('play').click();
    await tick();

    const osc = sandbox.BBApp.engine._nodes.oscs[0];
    const before = osc.frequency.calls.length;

    sandbox.BBApp.engine.setFrequencies(210, 220);        // unchanged
    eq(osc.frequency.calls.length, before, 'nothing scheduled for an unchanged value');

    sandbox.BBApp.engine.setFrequencies(212, 220);        // real change
    eq(osc.frequency.calls.length > before, true, 'a real change still schedules');

    $('play').click();
    await tick();
  });

  // Keep last: swapping the buffer mode closes an idle AudioContext.
  await checkAsync('diagnostics: the panel reports state and the buffer mode', async () => {
    sandbox.BBApp.diagnostics();
    eq(typeof $('diag-state').textContent, 'string');
    eq($('diag-state').textContent.length > 0, true, 'state is shown');
    eq($('diag-load').textContent.length > 0, true, 'load row is filled in');

    const sel = $('latency-mode');
    eq(sel.value, 'playback');

    sel.value = 'interactive';
    sel.dispatch('change');
    eq(sandbox.BBApp.engine.diagnostics.latencyHint, 'interactive');
    eq(storage.get('binaural-lab/latency'), 'interactive', 'choice is remembered');

    sel.value = 'playback';
    sel.dispatch('change');
    eq(sandbox.BBApp.engine.diagnostics.latencyHint, 'playback');
  });
}

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

/* ========================================================================== *
 *  Run
 * ========================================================================== */

(async () => {
  try {
    await Promise.all([]);
    // let boot's DOMContentLoaded handlers settle, then exercise the async paths
    await tick();
    await audioTests();
  } catch (err) {
    failures.push({ name: 'suite crashed', message: err.stack || err.message });
  }

  console.log('');
  for (const f of failures) {
    console.log('  FAIL  ' + f.name + '\n        ' + f.message);
  }
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
