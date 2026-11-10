/*!
 * export.js
 * ---------------------------------------------------------------------------
 * Renders the current tone pair to a WAV file entirely offline.
 *
 * Why OfflineAudioContext instead of MediaRecorder: it renders faster than real
 * time, sample-exactly, with no microphone/permission weirdness, and the file
 * is a plain PCM WAV that every player and phone understands. The graph is a
 * deliberate copy of the live one (two sines, one per channel) so what lands in
 * the file is what you hear — minus any ear-soloing, because a one-eared
 * binaural file would be useless.
 *
 * Half-second fades at each edge keep the file from starting or ending with a
 * click when it is looped.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 48000;
  var EDGE_FADE = 0.5;

  function offlineCtor() {
    return global.OfflineAudioContext || global.webkitOfflineAudioContext;
  }

  function isSupported() {
    return typeof offlineCtor() === 'function';
  }

  /** Bytes a render of this length will produce, so the UI can warn. */
  function estimatedBytes(seconds) {
    return global.BB.estimateBytes(seconds, SAMPLE_RATE, 2);
  }

  /**
   * @param {{left:number, right:number, volume:number, seconds:number}} opts
   * @returns {Promise<AudioBuffer>}
   */
  function renderSession(opts) {
    return new Promise(function (resolve, reject) {
      var Offline = offlineCtor();
      if (typeof Offline !== 'function') {
        reject(new Error('This browser cannot render audio offline.'));
        return;
      }

      var seconds = Math.max(1, Number(opts.seconds) || 60);
      var frames = Math.ceil(seconds * SAMPLE_RATE);
      var ctx;

      try {
        ctx = new Offline(2, frames, SAMPLE_RATE);
      } catch (err) {
        reject(err);
        return;
      }

      var merger = ctx.createChannelMerger(2);
      var master = ctx.createGain();
      var oscL = ctx.createOscillator();
      var oscR = ctx.createOscillator();

      oscL.type = 'sine';
      oscR.type = 'sine';
      oscL.frequency.setValueAtTime(Number(opts.left), 0);
      oscR.frequency.setValueAtTime(Number(opts.right), 0);

      var peak = global.BB.BinauralEngine.gainForVolume(opts.volume);
      var fade = Math.min(EDGE_FADE, seconds / 4);

      master.gain.setValueAtTime(0, 0);
      master.gain.linearRampToValueAtTime(peak, fade);
      master.gain.setValueAtTime(peak, Math.max(fade, seconds - fade));
      master.gain.linearRampToValueAtTime(0, seconds);

      // Same topology as the live engine: never mixed, hard left / hard right.
      oscL.connect(merger, 0, 0);
      oscR.connect(merger, 0, 1);
      merger.connect(master);
      master.connect(ctx.destination);

      oscL.start(0);
      oscR.start(0);
      oscL.stop(seconds);
      oscR.stop(seconds);

      var rendering;
      try {
        rendering = ctx.startRendering();
      } catch (err) {
        reject(err);
        return;
      }

      if (rendering && typeof rendering.then === 'function') {
        rendering.then(resolve, reject);
      } else {
        // Ancient Safari: callback instead of promise.
        ctx.oncomplete = function (evt) { resolve(evt.renderedBuffer); };
      }
    });
  }

  /** "binaural-200.00-210.00Hz-10.00Hz-180s.wav" */
  function filename(opts) {
    var fmt = function (n) { return Number(n).toFixed(2); };
    var beat = Math.abs(opts.right - opts.left);
    return 'binaural-' + fmt(opts.left) + '-' + fmt(opts.right) +
           'Hz-beat-' + fmt(beat) + 'Hz-' + Math.round(opts.seconds) + 's.wav';
  }

  /**
   * Hand the rendered buffer to the browser as a download.
   * @returns {number} size in bytes
   */
  function save(buffer, name) {
    var bytes = global.BB.encodeWav(buffer);
    var blob = new global.Blob([bytes], { type: 'audio/wav' });
    var url = global.URL.createObjectURL(blob);
    var doc = global.document;
    var link = doc.createElement('a');

    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    doc.body.appendChild(link);
    link.click();
    doc.body.removeChild(link);

    global.setTimeout(function () {
      try { global.URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }, 5000);

    return blob.size;
  }

  global.BB = global.BB || {};
  global.BB.exporter = {
    SAMPLE_RATE: SAMPLE_RATE,
    isSupported: isSupported,
    estimatedBytes: estimatedBytes,
    renderSession: renderSession,
    filename: filename,
    save: save
  };
})(window);
