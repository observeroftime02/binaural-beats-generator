/*!
 * visualizer.js
 * ---------------------------------------------------------------------------
 *   BeatVisualizer  a live, smoothly scrolling wave of the beat itself
 *   PeriodGauge     how long one beat lasts, on a log dial
 *
 * What the wave actually shows
 * ---------------------------------------------------------------------------
 * The canvas is one second wide, so the number of crests on screen *is* the
 * beat rate in hertz: a 10 Hz beat draws ten waves, a 2.5 Hz beat draws two
 * and a half. Crest spacing therefore tells you the frequency without any
 * numbers at all.
 *
 * Why the motion is speed-limited
 * ---------------------------------------------------------------------------
 * A wave scrolling at its true rate is lovely at 0.5-3 Hz and becomes a flicker
 * above roughly 4 Hz — 10 Hz and 40 Hz are squarely inside the range that
 * matters for photosensitive viewers. So the *shape* always reflects the true
 * rate (crest count), while the *phase* advances at most MOTION_CAP times a
 * second. Above 3 Hz you get a dense, slowly drifting ripple instead of a
 * strobe; the stage label says "slowed" whenever that kicks in.
 *
 * Why nothing is measured or allocated per frame
 * ---------------------------------------------------------------------------
 * This loop runs while audio plays. Reading layout (getBoundingClientRect) or
 * building a fresh gradient/path every frame competes with the audio thread for
 * the main thread and the compositor, and the audible symptom of that is
 * exactly a crackle. So: the canvas is measured only when a ResizeObserver
 * says it changed, the sample buffer is reused, the gradient is cached, and
 * the loop is capped at 30 fps — which is indistinguishable for a slow drift.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var WINDOW_S = 1.0;       // seconds of beat across the canvas => crests == Hz
  var MOTION_CAP = 3.0;     // max cycles/second of on-screen movement
  var FRAME_MS = 1000 / 30; // 30 fps: smooth enough, half the main-thread work
  var PERIOD_LO = 0.02;     // s — 50 Hz
  var PERIOD_HI = 2.0;      // s — 0.5 Hz

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function periodLabel(beat) {
    var b = Math.abs(Number(beat) || 0);
    if (b < 0.05) return '—';
    var p = 1 / b;
    if (p >= 1) return p.toFixed(2) + ' s';
    if (p >= 0.1) return Math.round(p * 1000) + ' ms';
    return (p * 1000).toFixed(p < 0.02 ? 1 : 0) + ' ms';
  }

  function periodFraction(beat) {
    var b = Math.abs(Number(beat) || 0);
    if (b < 0.05) return 0;
    var p = clamp(1 / b, PERIOD_LO, PERIOD_HI);
    return (Math.log(p) - Math.log(PERIOD_LO)) /
           (Math.log(PERIOD_HI) - Math.log(PERIOD_LO));
  }

  function readPalette() {
    var cs = global.getComputedStyle(document.documentElement);
    function v(name, fallback) {
      var raw = cs.getPropertyValue(name);
      return (raw && raw.trim()) || fallback;
    }
    return { beat: v('--beat', '#ffb454') };
  }

  function hexA(color, alpha) {
    var c = String(color || '').trim();
    var m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
      return 'rgba(' + parseInt(m[1][0] + m[1][0], 16) + ',' +
        parseInt(m[1][1] + m[1][1], 16) + ',' +
        parseInt(m[1][2] + m[1][2], 16) + ',' + alpha + ')';
    }
    if ((m = /^#([0-9a-f]{6})$/i.exec(c))) {
      var n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' +
        (n & 255) + ',' + alpha + ')';
    }
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
      var parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length >= 3) {
        return 'rgba(' + parts[0] + ',' + parts[1] + ',' + parts[2] + ',' + alpha + ')';
      }
    }
    return 'rgba(255,180,84,' + alpha + ')';
  }

  function prefersStill() {
    try {
      return typeof global.matchMedia === 'function' &&
             global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------- surface */
  /**
   * A canvas plus its size, measured only when something says it changed.
   * `generation` bumps whenever the backing store is resized, which is the
   * signal for anything cached in device pixels (gradients) to be rebuilt.
   */
  class Surface {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = null;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.dirty = true;
      this.generation = 0;
    }

    /** @returns {boolean} true when there is something to draw on */
    ensure() {
      if (!this.dirty && this.ctx) return true;
      this.dirty = false;

      var rect = this.canvas.getBoundingClientRect();
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);

      if (w <= 0 || h <= 0) {   // hidden (the dial is display:none on phones)
        this.ctx = null;
        return false;
      }
      if (this.ctx && w === this.w && h === this.h && dpr === this.dpr) return true;

      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx = this.canvas.getContext('2d');
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.generation++;
      return true;
    }
  }

  /* --------------------------------------------------------- the beat wave */
  class BeatVisualizer {
    constructor(canvas) {
      this.surf = new Surface(canvas);
      this.beat = 10;
      this.playing = false;
      this.palette = readPalette();
      this.phase = 0;          // 0..1 of one beat cycle
      this._raf = null;
      this._queued = false;
      this._last = 0;
      this._grad = null;
      this._gradGen = -1;
      this._ys = new Float32Array(0);

      var self = this;
      if (typeof global.ResizeObserver === 'function') {
        new global.ResizeObserver(function () {
          self.surf.dirty = true;
          self.invalidate();
        }).observe(canvas);
      } else {
        global.addEventListener('resize', function () {
          self.surf.dirty = true;
          self.invalidate();
        });
      }
      this.invalidate();
    }

    /** Cycles per second of on-screen movement for the current beat. */
    get visualRate() {
      return Math.min(Math.abs(this.beat), MOTION_CAP);
    }

    setBeat(hz) {
      var b = Math.abs(Number(hz) || 0);
      if (b === this.beat) return;
      this.beat = b;
      if (!this.playing) this.invalidate();   // the loop repaints on its own
    }

    setPlaying(isPlaying) {
      var p = !!isPlaying;
      if (p === this.playing) return;
      this.playing = p;
      if (p) this._startLoop();
      else this._stopLoop();
      this.invalidate();
    }

    refreshPalette() {
      this.palette = readPalette();
      this._grad = null;
      this.invalidate();
    }

    invalidate() {
      if (this._queued) return;
      this._queued = true;
      var self = this;
      global.requestAnimationFrame(function () {
        self._queued = false;
        self.render();
      });
    }

    _startLoop() {
      if (this._raf || prefersStill() || this.beat < 0.05) return;
      var self = this;
      this._last = (global.performance || Date).now();
      this._lastRender = 0;

      var frame = function (now) {
        // Phase always advances by the true elapsed time, so the wave moves at
        // the right speed whatever the display refresh rate is. Only the
        // *painting* is throttled to FRAME_MS — a slow drift looks identical
        // at 30 fps and costs half the main-thread time.
        var elapsed = now - self._last;
        self._last = now;
        self.phase = (self.phase + (elapsed / 1000) * self.visualRate) % 1;

        if (now - self._lastRender >= FRAME_MS - 1.5) {
          self._lastRender = now;
          self.render();
        }
        self._raf = global.requestAnimationFrame(frame);
      };
      this._raf = global.requestAnimationFrame(frame);
    }

    _stopLoop() {
      if (this._raf) {
        global.cancelAnimationFrame(this._raf);
        this._raf = null;
      }
    }

    /** Stop moving if the rate drops to zero (e.g. the unison preset). */
    _syncLoop() {
      if (this.playing && this.beat >= 0.05) this._startLoop();
      else this._stopLoop();
    }

    render() {
      this._syncLoop();

      var surf = this.surf;
      if (!surf.ensure()) return;

      var ctx = surf.ctx;
      var w = surf.w;
      var h = surf.h;
      var beat = this.beat;
      var mid = h / 2;
      var amp = h / 2 - 16;
      var live = this.playing ? 1 : 0.55;

      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = live;

      /* quarter-second guides — one second of time across the canvas */
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      for (var g = 1; g < 4; g++) {
        var gx = Math.round((w / 4) * g) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, 12);
        ctx.lineTo(gx, h - 12);
        ctx.stroke();
      }

      /* centre axis */
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      if (beat < 0.05) {
        ctx.globalAlpha = live;
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('no beat — both ears hear the same tone', w / 2, mid - 18);
        ctx.globalAlpha = 1;
        return;
      }

      /* one crest per beat cycle, scrolling at a capped rate. The y values go
         into a reused buffer: no per-frame allocation, no garbage to collect
         while the tones are playing. */
      var step = w > 700 ? 2 : 1.5;
      var count = Math.floor(w / step) + 2;
      if (this._ys.length < count) this._ys = new Float32Array(count);

      var ys = this._ys;
      var cycles = beat * WINDOW_S;
      var phase = this.phase;
      var n = 0;
      for (var x = 0; x <= w; x += step) {
        ys[n++] = Math.sin(2 * Math.PI * (cycles * (x / w) - phase)) * amp;
      }

      /* gradient depends only on the palette and the surface height */
      if (this._gradGen !== surf.generation || !this._grad) {
        var grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, hexA(this.palette.beat, 0.16));
        grad.addColorStop(0.5, hexA(this.palette.beat, 0.03));
        grad.addColorStop(1, hexA(this.palette.beat, 0.16));
        this._grad = grad;
        this._gradGen = surf.generation;
      }

      ctx.beginPath();
      ctx.moveTo(0, mid);
      var px = 0;
      for (var i = 0; i < n; i++) {
        ctx.lineTo(px, mid - ys[i]);
        px += step;
      }
      ctx.lineTo(w, mid);
      ctx.closePath();
      ctx.fillStyle = this._grad;
      ctx.fill();

      ctx.strokeStyle = hexA(this.palette.beat, 0.62);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      px = 0;
      for (var k = 0; k < n; k++) {
        if (k === 0) ctx.moveTo(px, mid - ys[k]);
        else ctx.lineTo(px, mid - ys[k]);
        px += step;
      }
      ctx.stroke();

      ctx.globalAlpha = 1;
    }
  }

  /* --------------------------------------------------------- period gauge */
  class PeriodGauge {
    constructor(canvas) {
      this.surf = new Surface(canvas);
      this.beat = 10;
      this.palette = readPalette();
      this._queued = false;

      var self = this;
      if (typeof global.ResizeObserver === 'function') {
        new global.ResizeObserver(function () {
          self.surf.dirty = true;
          self.invalidate();
        }).observe(canvas);
      }
      this.invalidate();
    }

    setBeat(hz) {
      var b = Math.abs(Number(hz) || 0);
      if (b === this.beat) return;
      this.beat = b;
      this.invalidate();
    }

    refreshPalette() {
      this.palette = readPalette();
      this.invalidate();
    }

    invalidate() {
      if (this._queued) return;
      this._queued = true;
      var self = this;
      global.requestAnimationFrame(function () {
        self._queued = false;
        self.render();
      });
    }

    render() {
      if (!this.surf.ensure()) return;

      var ctx = this.surf.ctx;
      var w = this.surf.w;
      var h = this.surf.h;
      var cx = w / 2, cy = h / 2;
      var r = Math.min(w, h) / 2 - 3;
      var frac = periodFraction(this.beat);

      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      if (frac > 0.001) {
        var start = -Math.PI / 2;
        var end = start + frac * Math.PI * 2;
        ctx.strokeStyle = hexA(this.palette.beat, 0.7);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, end);
        ctx.stroke();

        ctx.fillStyle = this.palette.beat;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(end) * r, cy + Math.sin(end) * r, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  global.BB = global.BB || {};
  global.BB.BeatVisualizer = BeatVisualizer;
  global.BB.PeriodGauge = PeriodGauge;
  global.BB.MOTION_CAP = MOTION_CAP;
  global.BB.periodLabel = periodLabel;
  global.BB._viz = { hexA: hexA, periodFraction: periodFraction, FRAME_MS: FRAME_MS };
})(window);
