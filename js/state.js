/*!
 * state.js
 * ---------------------------------------------------------------------------
 * The single source of truth for the whole app, with no DOM and no audio in
 * sight. Everything else (app.js) is a projection of this object:
 *
 *      state  ──▶  audio engine   (frequencies, volume)
 *             ├─▶  readout / UI   (numbers, band, sliders)
 *             └─▶  visualiser     (beat rate)
 *
 * Two ways to drive it:
 *
 *   manual mode   the two carrier frequencies are authoritative, the beat is
 *                 derived from their difference.
 *   target mode   the beat frequency and centre pitch are authoritative, the
 *                 carriers are derived as centre ± beat/2.
 *
 * Touching a control promotes its group to "authoritative", so the app can
 * never show a stale number. Because it is pure, it can be unit tested in
 * Node without a browser.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var LIMITS = {
    tone:   { min: 20, max: 1000 },
    beat:   { min: 0,  max: 40   },  // 0 Hz is legal: it is "unison"
    centre: { min: 30, max: 800  },
    volume: { min: 0,  max: 1    }
  };

  var DEFAULTS = {
    left: 200,
    right: 210,
    volume: 0.45,
    mode: 'manual',   // 'manual' | 'target'
    beat: 10,
    centre: 210
  };

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function round2(n) { return Math.round(Number(n) * 100) / 100; }

  class BinauralState {
    constructor(initial) {
      this.limits = LIMITS;
      this._subs = [];
      this.data = {
        left: DEFAULTS.left,
        right: DEFAULTS.right,
        volume: DEFAULTS.volume,
        mode: DEFAULTS.mode,
        beat: DEFAULTS.beat,
        centre: DEFAULTS.centre
      };
      if (initial) this.hydrate(initial);
      // Keep the derived numbers coherent with whatever we loaded.
      if (this.data.mode === 'target') {
        this._applyTarget();
      } else {
        this._syncTargetFromTones();
      }
    }

    /* ------------------------------------------------------------ events */
    subscribe(fn) {
      var self = this;
      this._subs.push(fn);
      return function () {
        var i = self._subs.indexOf(fn);
        if (i >= 0) self._subs.splice(i, 1);
      };
    }

    _emit(reason) {
      for (var i = 0; i < this._subs.length; i++) {
        try { this._subs[i](this, reason); } catch (e) {
          if (global.console) global.console.error(e);
        }
      }
    }

    /* ----------------------------------------------------------- derived */
    /** The perceived beat rate in Hz (always the absolute difference). */
    get beatHz() {
      return round2(Math.abs(this.data.right - this.data.left));
    }

    /** Band object for the current beat rate. */
    get band() {
      var classify = global.BB && global.BB.classify;
      if (typeof classify === 'function') return classify(this.beatHz);
      return { key: 'unknown', label: '—', note: '' };
    }

    get mode() { return this.data.mode; }
    get volume() { return this.data.volume; }
    get left() { return this.data.left; }
    get right() { return this.data.right; }

    /** Tones implied by the target controls (what target mode would apply). */
    get targetTones() {
      var b = this.data.beat;
      var c = this.data.centre;
      return {
        left: clamp(round2(c - b / 2), LIMITS.tone.min, LIMITS.tone.max),
        right: clamp(round2(c + b / 2), LIMITS.tone.min, LIMITS.tone.max)
      };
    }

    /* ------------------------------------------------------------ setters */
    setTone(side, hz, options) {
      var opts = options || {};
      var value = clamp(round2(hz), LIMITS.tone.min, LIMITS.tone.max);
      if (side !== 'left' && side !== 'right') return;
      if (this.data[side] === value && !opts.force) return;

      this.data[side] = value;
      // A hand-tuned carrier means manual mode is authoritative again.
      if (this.data.mode !== 'manual') this.data.mode = 'manual';
      this._syncTargetFromTones();
      this._emit('tones');
    }

    setTones(left, right, options) {
      var l = clamp(round2(left), LIMITS.tone.min, LIMITS.tone.max);
      var r = clamp(round2(right), LIMITS.tone.min, LIMITS.tone.max);
      var changed = l !== this.data.left || r !== this.data.right;
      this.data.left = l;
      this.data.right = r;
      if (this.data.mode !== 'manual') this.data.mode = 'manual';
      this._syncTargetFromTones();
      if (changed || (options && options.force)) this._emit('tones');
    }

    setVolume(v) {
      var value = clamp(Number(v), 0, 1);
      var value2 = Math.round(value * 100) / 100;
      if (this.data.volume === value2) return;
      this.data.volume = value2;
      this._emit('volume');
    }

    /** Switch modes, adopting the other group's current values. */
    setMode(mode) {
      if (mode !== 'manual' && mode !== 'target') return;
      if (this.data.mode === mode) return;
      this.data.mode = mode;
      if (mode === 'target') {
        this._syncTargetFromTones();
        this._applyTarget();
      }
      this._emit('mode');
    }

    /** Target mode: set the beat rate, carriers follow. */
    setBeat(hz) {
      var value = clamp(round2(hz), LIMITS.beat.min, LIMITS.beat.max);
      if (this.data.mode === 'manual') this.data.mode = 'target';
      if (this.data.beat === value && this.data.mode === 'target') return;
      this.data.beat = value;
      this._applyTarget();
      this._emit('target');
    }

    /** Target mode: set the centre pitch, carriers follow. */
    setCentre(hz) {
      var value = clamp(round2(hz), LIMITS.centre.min, LIMITS.centre.max);
      if (this.data.mode === 'manual') this.data.mode = 'target';
      if (this.data.centre === value && this.data.mode === 'target') return;
      this.data.centre = value;
      this._applyTarget();
      this._emit('target');
    }

    /** Target mode: set both at once (used by the presets). */
    setTarget(beat, centre) {
      this.data.mode = 'target';
      this.data.beat = clamp(round2(beat), LIMITS.beat.min, LIMITS.beat.max);
      this.data.centre = clamp(round2(centre), LIMITS.centre.min, LIMITS.centre.max);
      this._applyTarget();
      this._emit('target');
    }

    applyPreset(preset) {
      if (!preset) return;
      var l = clamp(round2(preset.left), LIMITS.tone.min, LIMITS.tone.max);
      var r = clamp(round2(preset.right), LIMITS.tone.min, LIMITS.tone.max);
      if (this.data.mode === 'target') {
        // Stay in target mode: express the preset as beat + centre, which
        // reproduces the very same pair of tones.
        this.data.beat = clamp(round2(Math.abs(r - l)), LIMITS.beat.min, LIMITS.beat.max);
        this.data.centre = clamp(round2((l + r) / 2), LIMITS.centre.min, LIMITS.centre.max);
        this._applyTarget();
      } else {
        this.data.left = l;
        this.data.right = r;
        this._syncTargetFromTones();
      }
      this.data.presetId = preset.id || null;
      this._emit('preset');
    }

    swapEars() {
      var l = this.data.left;
      this.data.left = this.data.right;
      this.data.right = l;
      if (this.data.mode === 'target') this._syncTargetFromTones();
      this._emit('tones');
    }

    reset() {
      this.data.left = DEFAULTS.left;
      this.data.right = DEFAULTS.right;
      this.data.volume = DEFAULTS.volume;
      this.data.mode = DEFAULTS.mode;
      this.data.presetId = null;
      this._syncTargetFromTones();
      this._emit('reset');
    }

    /* ------------------------------------------------------------ internal */
    /** beat + centre <- the current carrier pair */
    _syncTargetFromTones() {
      this.data.centre = clamp(round2((this.data.left + this.data.right) / 2),
        LIMITS.centre.min, LIMITS.centre.max);
      this.data.beat = clamp(round2(Math.abs(this.data.right - this.data.left)),
        LIMITS.beat.min, LIMITS.beat.max);
    }

    /** the carrier pair <- beat + centre */
    _applyTarget() {
      var c = this.data.centre;
      var b = this.data.beat;
      this.data.left = clamp(round2(c - b / 2), LIMITS.tone.min, LIMITS.tone.max);
      this.data.right = clamp(round2(c + b / 2), LIMITS.tone.min, LIMITS.tone.max);

      // If a carrier hit the range limit, the achievable beat is smaller than
      // the requested one. Report what we actually produced so the readout and
      // the target field can never disagree.
      this.data.beat = clamp(round2(this.data.right - this.data.left),
        LIMITS.beat.min, LIMITS.beat.max);
    }

    /* ------------------------------------------------------ persistence */
    toJSON() {
      return {
        left: this.data.left,
        right: this.data.right,
        volume: this.data.volume,
        mode: this.data.mode,
        beat: this.data.beat,
        centre: this.data.centre
      };
    }

    hydrate(raw) {
      if (!raw || typeof raw !== 'object') return;
      if (isFinite(Number(raw.left))) {
        this.data.left = clamp(round2(raw.left), LIMITS.tone.min, LIMITS.tone.max);
      }
      if (isFinite(Number(raw.right))) {
        this.data.right = clamp(round2(raw.right), LIMITS.tone.min, LIMITS.tone.max);
      }
      if (isFinite(Number(raw.volume))) {
        this.data.volume = clamp(Number(raw.volume), 0, 1);
      }
      if (isFinite(Number(raw.beat))) {
        this.data.beat = clamp(round2(raw.beat), LIMITS.beat.min, LIMITS.beat.max);
      }
      if (isFinite(Number(raw.centre))) {
        this.data.centre = clamp(round2(raw.centre), LIMITS.centre.min, LIMITS.centre.max);
      }
      if (raw.mode === 'target' || raw.mode === 'manual') {
        this.data.mode = raw.mode;
      }
    }
  }

  global.BB = global.BB || {};
  global.BB.BinauralState = BinauralState;
  global.BB.LIMITS = LIMITS;
})(window);
