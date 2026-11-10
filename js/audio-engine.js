/*!
 * audio-engine.js
 * ---------------------------------------------------------------------------
 * The sound source. Two independent pure-sine oscillators, one hard-panned
 * into each ear, summed into a stereo stream.
 *
 * Signal graph
 *
 *   osc(L) -> gain(L) -\
 *                       > channelMerger(2 ch: 0=L, 1=R) -> master -> destination
 *   osc(R) -> gain(R) -/
 *
 * Using a ChannelMerger (rather than a panner) guarantees total isolation:
 * the left oscillator can only ever reach the left output channel. That
 * isolation is the whole trick behind a binaural beat — the two tones must
 * meet *inside* the listener, not in the hardware.
 *
 * Nothing here touches the DOM. It is a self-contained module attached to
 * window.BB, so it can be reused or tested on its own.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var FADE_TIME   = 0.30;   // s — de-click ramp used on start / stop
  var RETUNE_TIME = 0.025;  // s — time-constant when a frequency changes
  var MAX_GAIN    = 0.32;   // hard ceiling: a full-scale pure sine is LOUD
  var MIN_HZ      = 8;
  var MAX_HZ      = 20000;

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function safeDisconnect(node) {
    if (!node) return;
    try { node.disconnect(); } catch (e) { /* already gone */ }
  }

  /**
   * A tiny wrapper around the Web Audio API that owns exactly two sine tones.
   */
  class BinauralEngine {
    constructor() {
      this.ctx = null;
      this._nodes = null;      // { oscs:[L,R], gains:[L,R], merger, master }
      this._playing = false;
      this._volume = 0.45;
      this._left = 200;
      this._right = 210;
      this._sessionFade = 1;   // sleep-timer fade, 0..1
      this._solo = 'both';     // 'both' | 'left' | 'right'
      this._fadePlan = null;   // scheduled sleep fade, see scheduleSessionFade()
    }

    /** Is the Web Audio API available at all? */
    static isSupported() {
      return typeof (global.AudioContext || global.webkitAudioContext) === 'function';
    }

    /**
     * Perceived-loudness curve. A linear gain slider feels far too jumpy at
     * the top end, so we use a power curve and cap the ceiling.
     */
    static gainForVolume(volume) {
      var v = clamp(volume, 0, 1);
      return Math.pow(v, 1.6) * MAX_GAIN;
    }

    get isPlaying() { return this._playing; }
    get frequencies() { return { left: this._left, right: this._right }; }
    get solo() { return this._solo; }
    get hasScheduledFade() { return !!this._fadePlan; }
    get contextState() { return this.ctx ? this.ctx.state : 'closed'; }

    _ensureContext() {
      if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) throw new Error('This browser has no Web Audio support.');
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch (e) {
        this.ctx = new Ctor(); // older Safari rejects the options object
      }
      return this.ctx;
    }

    /**
     * Start both tones.
     * @param {{left:number, right:number, volume?:number}} options
     * @returns {Promise<void>} resolves once the context is actually running
     */
    async start(options) {
      var opts = options || {};
      var left = clamp(opts.left != null ? opts.left : this._left, MIN_HZ, MAX_HZ);
      var right = clamp(opts.right != null ? opts.right : this._right, MIN_HZ, MAX_HZ);
      if (opts.volume != null) this._volume = clamp(opts.volume, 0, 1);

      var ctx = this._ensureContext();

      // Mobile browsers start the context suspended; a user gesture unlocks it.
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { /* ignore */ }
      }

      this._left = left;
      this._right = right;

      if (this._playing) {
        // Already running — treat this as a retune.
        this.setFrequencies(left, right);
        this.setVolume(this._volume);
        return;
      }

      var now = ctx.currentTime;
      var merger = ctx.createChannelMerger(2);
      var master = ctx.createGain();
      var fade = ctx.createGain();      // sleep timer rides on this, not on master
      var gainL = ctx.createGain();
      var gainR = ctx.createGain();
      var oscL = ctx.createOscillator();
      var oscR = ctx.createOscillator();

      // Pure sine waves only — every harmonic would muddy the beat.
      oscL.type = 'sine';
      oscR.type = 'sine';
      oscL.frequency.setValueAtTime(left, now);
      oscR.frequency.setValueAtTime(right, now);

      // A soloed ear starts silent instead of being muted a moment later,
      // which would otherwise leak a click into the wrong channel.
      gainL.gain.setValueAtTime(this._solo === 'right' ? 0 : 1, now);
      gainR.gain.setValueAtTime(this._solo === 'left' ? 0 : 1, now);

      // Each tone into its own merger input => hard left / hard right.
      oscL.connect(gainL).connect(merger, 0, 0);
      oscR.connect(gainR).connect(merger, 0, 1);

      merger.connect(master);
      master.connect(fade);
      fade.connect(ctx.destination);
      fade.gain.setValueAtTime(this._sessionFade, now);

      // Fade in from true silence: avoids the "click" of a discontinuity.
      var target = BinauralEngine.gainForVolume(this._volume);
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(target, now + FADE_TIME);

      // Both oscillators start on the same sample, phase 0, so the beat
      // begins constructively (loud) rather than with a random phase offset.
      oscL.start(now);
      oscR.start(now);

      this._nodes = {
        oscs: [oscL, oscR],
        gains: [gainL, gainR],
        merger: merger,
        master: master,
        fade: fade
      };
      this._playing = true;

      // A session may have been armed before the tones were started, so this
      // has to run *after* _nodes exists.
      if (this._fadePlan) this._applyFadePlan();
    }

    /** Fade out and tear the graph down. Safe to call when already stopped. */
    stop() {
      var ctx = this.ctx;
      var nodes = this._nodes;
      this._nodes = null;
      this._playing = false;
      if (!ctx || !nodes) return;

      var now = ctx.currentTime;
      try {
        var g = nodes.master.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + FADE_TIME);
      } catch (e) { /* ignore */ }

      nodes.oscs.forEach(function (osc) {
        try { osc.stop(now + FADE_TIME + 0.02); } catch (e) { /* ignore */ }
      });

      // Release the nodes once the fade has finished playing out.
      global.setTimeout(function () {
        nodes.oscs.forEach(safeDisconnect);
        nodes.gains.forEach(safeDisconnect);
        safeDisconnect(nodes.merger);
        safeDisconnect(nodes.master);
        safeDisconnect(nodes.fade);
      }, (FADE_TIME + 0.25) * 1000);
    }

    /**
     * Retune while playing. Uses a short time-constant instead of a hard jump
     * so dragging a slider glides instead of zippering.
     */
    setFrequencies(left, right) {
      this._left = clamp(left, MIN_HZ, MAX_HZ);
      this._right = clamp(right, MIN_HZ, MAX_HZ);
      if (!this._nodes || !this.ctx) return;
      var now = this.ctx.currentTime;
      this._nodes.oscs[0].frequency.setTargetAtTime(this._left, now, RETUNE_TIME);
      this._nodes.oscs[1].frequency.setTargetAtTime(this._right, now, RETUNE_TIME);
    }

    /**
     * Schedule the end-of-session fade on the *audio* clock.
     *
     * Doing it this way matters: browsers throttle timers in background tabs to
     * as little as once a minute, which would turn a graceful fade into a hard
     * cut precisely when the user is falling asleep. An AudioParam ramp runs on
     * the audio thread and is never throttled.
     *
     * @param {number} startIn seconds from now until the fade begins
     * @param {number} duration fade length in seconds
     */
    scheduleSessionFade(startIn, duration) {
      this._fadePlan = {
        startIn: Math.max(0, Number(startIn) || 0),
        duration: Math.max(0.1, Number(duration) || 0.1)
      };
      this._applyFadePlan();
    }

    /** Abandon any scheduled fade and restore full level immediately. */
    clearSessionFade() {
      this._fadePlan = null;
      this._sessionFade = 1;
      if (!this._nodes || !this.ctx) return;
      var g = this._nodes.fade.gain;
      var now = this.ctx.currentTime;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);     // hold wherever the fade got to
        g.setTargetAtTime(1, now, 0.05);    // then ease back up, no click
      } catch (e) { /* ignore */ }
    }

    _applyFadePlan() {
      if (!this._fadePlan || !this._nodes || !this.ctx) return;
      var plan = this._fadePlan;
      var g = this._nodes.fade.gain;
      var now = this.ctx.currentTime;
      var STEPS = 64;
      var curve = new Float32Array(STEPS);
      for (var i = 0; i < STEPS; i++) {
        // cos(pi/2 * t): holds level, then eases away. Matches SleepTimer.
        curve[i] = Math.cos((i / (STEPS - 1)) * Math.PI / 2);
      }
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(1, now);
        if (plan.startIn > 0) g.setValueAtTime(1, now + plan.startIn);
        g.setValueCurveAtTime(curve, now + plan.startIn, plan.duration);
      } catch (e) {
        // Very old engines: drop the plan so the caller can fall back to
        // stepping the gain from its interval instead.
        this._fadePlan = null;
      }
    }

    /**
     * Sleep-timer fade, 0..1, applied after the volume control so the user's
     * own level is never overwritten by the session running out. Used as a
     * fallback when the audio-clock schedule is unavailable.
     */
    setSessionFade(factor) {
      this._sessionFade = clamp(factor, 0, 1);
      if (!this._nodes || !this.ctx) return;
      var now = this.ctx.currentTime;
      this._nodes.fade.gain.setTargetAtTime(this._sessionFade, now, 0.12);
    }

    /**
     * Mute one ear without touching the other — the channel check.
     * @param {'both'|'left'|'right'} mode
     */
    setSolo(mode) {
      this._solo = (mode === 'left' || mode === 'right') ? mode : 'both';
      if (!this._nodes || !this.ctx) return;
      var now = this.ctx.currentTime;
      this._nodes.gains[0].gain.setTargetAtTime(this._solo === 'right' ? 0 : 1, now, 0.015);
      this._nodes.gains[1].gain.setTargetAtTime(this._solo === 'left' ? 0 : 1, now, 0.015);
    }

    /** 0..1 master volume. */
    setVolume(volume) {
      this._volume = clamp(volume, 0, 1);
      if (!this._nodes || !this.ctx) return;
      var now = this.ctx.currentTime;
      this._nodes.master.gain.setTargetAtTime(
        BinauralEngine.gainForVolume(this._volume), now, 0.05
      );
    }

    /** Nudge a suspended context back to life (e.g. after tab switching). */
    async resumeIfNeeded() {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended' && this._playing) {
        try { await this.ctx.resume(); } catch (e) { /* ignore */ }
      }
    }
  }

  global.BB = global.BB || {};
  global.BB.BinauralEngine = BinauralEngine;
  global.BB._audio = { FADE_TIME: FADE_TIME, MAX_GAIN: MAX_GAIN, MIN_HZ: MIN_HZ, MAX_HZ: MAX_HZ };
})(window);
