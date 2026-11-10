/*!
 * wav.js
 * ---------------------------------------------------------------------------
 * 16-bit PCM WAV encoding. A pure function: hand it anything that looks like an
 * AudioBuffer (numberOfChannels, length, sampleRate, getChannelData) and get
 * back an ArrayBuffer. No Web Audio, no DOM, no Blob — so it can be unit tested
 * in Node with a four-sample fake.
 *
 * Header layout (all little-endian, as WAV requires):
 *
 *   0  "RIFF"       4  chunk size = 36 + data bytes
 *   8  "WAVE"
 *  12  "fmt "       16  subchunk size (16)
 *  20  audioFormat (1 = PCM)   22  channels
 *  24  sampleRate              28  byteRate
 *  32  blockAlign              34  bitsPerSample (16)
 *  36  "data"       40  data bytes
 *  44  interleaved samples
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var HEADER_BYTES = 44;
  var BYTES_PER_SAMPLE = 2;

  function writeString(view, offset, text) {
    for (var i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  function toInt16(sample) {
    var s = sample;
    if (s > 1) s = 1; else if (s < -1) s = -1;
    // -1 maps to -32768, +1 to 32767: the standard asymmetric mapping.
    return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }

  /** @returns {ArrayBuffer} a complete .wav file */
  function encodeWav(buffer) {
    var channels = Math.max(1, buffer.numberOfChannels | 0);
    var frames = buffer.length | 0;
    var sampleRate = Math.round(buffer.sampleRate);
    var blockAlign = channels * BYTES_PER_SAMPLE;
    var dataBytes = frames * blockAlign;
    var out = new ArrayBuffer(HEADER_BYTES + dataBytes);
    var view = new DataView(out);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);          // subchunk size for PCM
    view.setUint16(20, 1, true);           // 1 = uncompressed PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);          // bits per sample

    writeString(view, 36, 'data');
    view.setUint32(40, dataBytes, true);

    var data = [];
    for (var c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

    var offset = HEADER_BYTES;
    for (var i = 0; i < frames; i++) {
      for (var ch = 0; ch < channels; ch++) {
        view.setInt16(offset, toInt16(data[ch][i]), true);
        offset += BYTES_PER_SAMPLE;
      }
    }
    return out;
  }

  /** Rough file size, for showing the user what they are about to allocate. */
  function estimateBytes(seconds, sampleRate, channels) {
    return HEADER_BYTES + Math.ceil(seconds * sampleRate) * channels * BYTES_PER_SAMPLE;
  }

  function formatBytes(bytes) {
    var mb = bytes / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(mb >= 10 ? 0 : 1) + ' MB';
    return Math.round(bytes / 1024) + ' kB';
  }

  global.BB = global.BB || {};
  global.BB.encodeWav = encodeWav;
  global.BB.estimateBytes = estimateBytes;
  global.BB.formatBytes = formatBytes;
  global.BB.WAV_HEADER_BYTES = HEADER_BYTES;
})(window);
