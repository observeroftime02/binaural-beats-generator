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
 * strobe; the stage label says "slowed" whenever that kicks in, so the picture
 * never claims to be playing at a speed it isn't.
 *
 * Motion only runs while the tones are playing, and it stops entirely for
 * anyone who has asked for reduced motion.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var WINDOW_S = 1.0;       // seconds of beat across the canvas => crests == Hz
  var MOTION_CAP = 3.0;     // max cycles/second of on-screen movement
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

  function fitCanvas(canvas) {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
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

  /* --------------------------------------------------------- the beat wave */
  class BeatVisualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.beat = 10;
      this.playing = false;
      this.palette = readPalette();
      this.phase = 0;          // 0..1 of one beat cycle
      this._raf = null;
      this._queued = false;
      this._last = 0;

      var self = this;
      if (typeof global.ResizeObserver === 'function') {
        new global.ResizeObserver(function () { self.invalidate(); }).observe(canvas);
      } else {
        global.addEventListener('resize', function () { self.invalidate(); });
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
      var step = function (now) {
        var dt = Math.min(0.1, (now - self._last) / 1000);
        self._last = now;
        self.phase = (self.phase + dt * self.visualRate) % 1;
        self.render();
        self._raf = global.requestAnimationFrame(step);
      };
      this._raf = global.requestAnimationFrame(step);
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

      var fit = fitCanvas(this.canvas);
      var ctx = fit.ctx, w = fit.w, h = fit.h, p = this.palette;
      var beat = this.beat;
      var live = this.playing ? 1 : 0.55;
      var mid = h / 2;
      var amp = h / 2 - 16;

      ctx.clearRect(0, 0, w, h);

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
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.09 * live) + ')';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      if (beat < 0.05) {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('no beat — both ears hear the same tone', w / 2, mid - 18);
        return;
      }

      /* one crest per beat cycle, scrolling at a capped rate */
      var cycles = beat * WINDOW_S;
      var pts = [];
      for (var x = 0; x <= w; x += 1.5) {
        var u = x / w;
        var y = Math.sin(2 * Math.PI * (cycles * u - this.phase)) * amp;
        pts.push([x, y]);
      }

      var grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, hexA(p.beat, 0.14 * live));
      grad.addColorStop(0.5, hexA(p.beat, 0.03 * live));
      grad.addColorStop(1, hexA(p.beat, 0.14 * live));

      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (var i = 0; i < pts.length; i++) ctx.lineTo(pts[i][0], mid - pts[i][1]);
      ctx.lineTo(w, mid);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = hexA(p.beat, 0.62 * live);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (var k = 0; k < pts.length; k++) {
        var px = pts[k][0], py = mid - pts[k][1];
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  /* --------------------------------------------------------- period gauge */
  class PeriodGauge {
    constructor(canvas) {
      this.canvas = canvas;
      this.beat = 10;
      this.palette = readPalette();
      this._queued = false;

      var self = this;
      if (typeof global.ResizeObserver === 'function') {
        new global.ResizeObserver(function () { self.invalidate(); }).observe(canvas);
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
      var fit = fitCanvas(this.canvas);
      var ctx = fit.ctx, w = fit.w, h = fit.h, p = this.palette;
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
        ctx.strokeStyle = hexA(p.beat, 0.7);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, end);
        ctx.stroke();

        ctx.fillStyle = p.beat;
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
  global.BB._viz = { hexA: hexA, periodFraction: periodFraction };
})(window);
