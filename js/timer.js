/*!
 * timer.js
 * ---------------------------------------------------------------------------
 * A sleep timer, kept deliberately dumb: it owns no clock and no audio, it
 * just answers questions about a moment in time. That makes it trivial to unit
 * test (pass in `now`) and impossible to get out of sync with the audio graph.
 *
 * The fade curve is cos(pi/2 * progress): it holds level for most of the final
 * window and then eases away, which is far less noticeable than a linear ramp
 * when you are half asleep.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var DEFAULT_FADE_SECONDS = 60;

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  class SleepTimer {
    constructor(fadeSeconds) {
      this.fadeSeconds = (fadeSeconds == null) ? DEFAULT_FADE_SECONDS : fadeSeconds;
      this.active = false;
      this.minutes = 0;
      this.endsAt = 0;
    }

    /**
     * Start a session. Returns false (and stays off) for 0 / nonsense.
     * @param {number} minutes
     * @param {number} now epoch milliseconds
     */
    start(minutes, now) {
      var m = Number(minutes);
      if (!isFinite(m) || m <= 0) { this.stop(); return false; }
      this.minutes = m;
      this.endsAt = Number(now || 0) + m * 60000;
      this.active = true;
      return true;
    }

    stop() {
      this.active = false;
      this.minutes = 0;
      this.endsAt = 0;
    }

    remainingMs(now) {
      if (!this.active) return 0;
      return Math.max(0, this.endsAt - Number(now || 0));
    }

    /** Is the session still running (including its fade)? */
    isDone(now) {
      return this.active && this.remainingMs(now) <= 0;
    }

    /** 1 = untouched, 0 = silent. Only dips inside the final fade window. */
    fadeFactor(now) {
      if (!this.active) return 1;
      var fadeMs = Math.max(1, this.fadeSeconds * 1000);
      var remaining = this.remainingMs(now);
      if (remaining <= 0) return 0;      // exact silence, not cos(pi/2)≈6e-17
      if (remaining >= fadeMs) return 1;
      var progress = clamp(1 - remaining / fadeMs, 0, 1);
      return Math.cos(progress * Math.PI / 2);
    }

    /** True once the fade has begun, so the UI can say so. */
    isFading(now) {
      if (!this.active) return false;
      return this.remainingMs(now) < this.fadeSeconds * 1000;
    }
  }

  /** "18:24" / "0:07" — minutes:seconds, rounded up so it never sits on 0:00. */
  function formatCountdown(ms) {
    var total = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  global.BB = global.BB || {};
  global.BB.SleepTimer = SleepTimer;
  global.BB.formatCountdown = formatCountdown;
})(window);
