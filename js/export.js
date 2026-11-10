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
 * Long exports are rendered in 100-second chunks. Keeping one AudioBuffer in
 * memory for a one-hour file would be wasteful (the float buffer alone is
 * ~23 MB per minute), so each chunk is encoded to 16-bit PCM and dropped, and
 * only the finished bytes are kept. The UI caps the request; the renderer
 * itself just follows whatever length it is handed.
 *
 * Phase continuity across chunks: UI frequencies have two decimal places, so
 * 100 seconds always contains a whole number of cycles for both tones. Each
 * chunk therefore starts its oscillators at phase zero without a seam at the
 * boundary. Half-second fades at each end of the whole file keep it from
 * starting or ending with a click when it is looped.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var SAMPLE_RATE = 48000;
  var EDGE_FADE = 0.5;
  var CHUNK_SECONDS = 100;
  var CHUNK_FRAMES = CHUNK_SECONDS * SAMPLE_RATE;

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

  function clampFrequency(hz) {
    var n = Number(hz);
    if (!isFinite(n)) n = 200;
    // The UI's resolution is 0.01 Hz, and the chunk boundary maths relies on
    // that: 100 s * 0.01 Hz is exactly one cycle.
    return Math.round(n * 100) / 100;
  }

  function peakFor(volume) {
    return global.BB.BinauralEngine.gainForVolume(volume);
  }

  /** Envelope of the finished file at a global time, in seconds. */
  function envelope(time, duration, fade, peak) {
    if (time <= 0 || time >= duration) return 0;
    if (time < fade) return peak * (time / fade);
    if (time > duration - fade) return peak * ((duration - time) / fade);
    return peak;
  }

  /**
   * Render one slice of the file. `startFrame` is its global sample offset;
   * the oscillator phase restarts at zero, which is only seamless because the
   * chunk length is a whole number of cycles at hundredth-hertz resolution.
   */
  function renderChunk(opts, startFrame, frames, totalFrames, fade) {
    return new Promise(function (resolve, reject) {
      var Offline = offlineCtor();
      if (typeof Offline !== 'function') {
        reject(new Error('This browser cannot render audio offline.'));
        return;
      }

      var totalSeconds = totalFrames / SAMPLE_RATE;
      var start = startFrame / SAMPLE_RATE;
      var duration = frames / SAMPLE_RATE;

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
      oscL.frequency.setValueAtTime(clampFrequency(opts.left), 0);
      oscR.frequency.setValueAtTime(clampFrequency(opts.right), 0);

      var peak = peakFor(opts.volume);
      var fadeOutStart = totalSeconds - fade;

      // Start wherever the global envelope happens to be at this slice's edge.
      master.gain.setValueAtTime(envelope(start, totalSeconds, fade, peak), 0);

      if (start < fade) {
        // The fade-in is always inside the first chunk (fade <= duration / 4).
        master.gain.linearRampToValueAtTime(peak, fade - start);
      }

      if (start < fadeOutStart && fadeOutStart < start + duration) {
        master.gain.setValueAtTime(peak, fadeOutStart - start);
        master.gain.linearRampToValueAtTime(0, totalSeconds - start);
      } else if (start >= fadeOutStart) {
        // The final chunk begins inside the fade-out.
        master.gain.linearRampToValueAtTime(0, totalSeconds - start);
      }

      // Same topology as the live engine: never mixed, hard left / hard right.
      oscL.connect(merger, 0, 0);
      oscR.connect(merger, 0, 1);
      merger.connect(master);
      master.connect(ctx.destination);

      oscL.start(0);
      oscR.start(0);
      oscL.stop(duration);
      oscR.stop(duration);

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

  /**
   * Render the whole file into WAV-sized pieces: a 44-byte header followed by
   * one 16-bit PCM blob per chunk. Pass the array straight to a Blob, or to
   * save(), and the browser can assemble it without copying it into one huge
   * ArrayBuffer.
   *
   * @param {{left:number, right:number, volume:number, seconds:number}} opts
   * @param {function({rendered:number,total:number,bytes:number}):void} [onProgress]
   * @returns {Promise<{parts:ArrayBuffer[], bytes:number, seconds:number}>}
   */
  async function renderWav(opts, onProgress) {
    var seconds = Math.max(1, Number(opts.seconds) || 60);
    var totalFrames = Math.ceil(seconds * SAMPLE_RATE);
    var totalSeconds = totalFrames / SAMPLE_RATE;
    var fade = Math.min(EDGE_FADE, totalSeconds / 4);
    var parts = [];
    var dataBytes = 0;

    for (var startFrame = 0; startFrame < totalFrames; startFrame += CHUNK_FRAMES) {
      var frames = Math.min(CHUNK_FRAMES, totalFrames - startFrame);
      var buffer = await renderChunk(opts, startFrame, frames, totalFrames, fade);
      var pcm = global.BB.encodePcm(buffer);

      parts.push(pcm);
      dataBytes += pcm.byteLength;

      if (typeof onProgress === 'function') {
        try {
          onProgress({
            rendered: startFrame + frames,
            total: totalFrames,
            bytes: dataBytes + global.BB.WAV_HEADER_BYTES
          });
        } catch (e) { /* a watcher must not break the render */ }
      }
    }

    parts.unshift(global.BB.wavHeader(dataBytes, SAMPLE_RATE, 2));
    return {
      parts: parts,
      bytes: dataBytes + global.BB.WAV_HEADER_BYTES,
      seconds: totalSeconds
    };
  }

  /** Single-buffer render, kept for callers that want an AudioBuffer. */
  function renderSession(opts) {
    var seconds = Math.max(1, Number(opts.seconds) || 60);
    var totalFrames = Math.ceil(seconds * SAMPLE_RATE);
    var totalSeconds = totalFrames / SAMPLE_RATE;
    var fade = Math.min(EDGE_FADE, totalSeconds / 4);
    return renderChunk(opts, 0, totalFrames, totalFrames, fade);
  }

  /** "binaural-200.00-210.00Hz-10.00Hz-180s.wav" */
  function filename(opts) {
    var fmt = function (n) { return Number(n).toFixed(2); };
    var beat = Math.abs(opts.right - opts.left);
    return 'binaural-' + fmt(opts.left) + '-' + fmt(opts.right) +
           'Hz-beat-' + fmt(beat) + 'Hz-' + Math.round(opts.seconds) + 's.wav';
  }

  /**
   * Hand the rendered pieces to the browser as a download.
   * @param {ArrayBuffer[]|AudioBuffer} parts
   * @returns {number} size in bytes
   */
  function save(parts, name) {
    var list = Array.isArray(parts) ? parts : [global.BB.encodeWav(parts)];
    var blob = new global.Blob(list, { type: 'audio/wav' });
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
    CHUNK_SECONDS: CHUNK_SECONDS,
    isSupported: isSupported,
    estimatedBytes: estimatedBytes,
    renderSession: renderSession,
    renderWav: renderWav,
    filename: filename,
    save: save
  };
})(window);
