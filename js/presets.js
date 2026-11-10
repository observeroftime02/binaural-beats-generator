/*!
 * presets.js
 * ---------------------------------------------------------------------------
 * Domain data, kept separate from both the audio engine and the UI:
 *
 *   - BANDS      the delta/theta/alpha/beta/gamma taxonomy
 *   - classify() turn a beat frequency into a band + human explanation
 *   - PRESETS    ready-made configurations that show the effect off
 *   - split()    the "beat target" maths (centre +/- beat/2)
 *
 * Pure data and pure functions — no DOM, no audio, trivially testable.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ bands */
  /**
   * Ranges follow the conventional EEG bands. `max` is exclusive so the bands
   * tile the number line without gaps.
   */
  var BANDS = [
    { key: 'delta', label: 'Delta', greek: 'δ', min: 0.5, max: 4,
      note: '0.5–4 Hz · deep, dreamless sleep and slow-wave rest' },
    { key: 'theta', label: 'Theta', greek: 'θ', min: 4, max: 8,
      note: '4–8 Hz · meditation, drifting, hypnagogic states' },
    { key: 'alpha', label: 'Alpha', greek: 'α', min: 8, max: 13,
      note: '8–13 Hz · relaxed but awake, eyes closed' },
    { key: 'beta', label: 'Beta', greek: 'β', min: 13, max: 30,
      note: '13–30 Hz · alert, engaged, task-focused' },
    { key: 'gamma', label: 'Gamma', greek: 'γ', min: 30, max: 100,
      note: '30 Hz+ · high attention and cross-region binding' }
  ];

  var UNISON = {
    key: 'unison',
    label: 'Unison',
    greek: '·',
    min: 0,
    max: 0,
    note: 'Both ears get the same tone — nothing beats. This is the control.'
  };

  var SUB = {
    key: 'sub',
    label: 'Sub-delta',
    greek: 'σ',
    min: 0,
    max: 0.5,
    note: 'Below 0.5 Hz · one slow swell every few seconds'
  };

  /**
   * @param {number} hz absolute difference between the two tones
   * @returns {{key:string,label:string,note:string,min:number,max:number}}
   */
  function classify(hz) {
    var b = Math.abs(Number(hz) || 0);
    if (b < 0.05) return UNISON;
    if (b < 0.5) return SUB;
    for (var i = 0; i < BANDS.length; i++) {
      if (b >= BANDS[i].min && b < BANDS[i].max) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  /* ----------------------------------------------------- beat <-> carriers */
  /**
   * Place two carriers symmetrically around a centre pitch so that the
   * difference is exactly `beat`. Symmetry keeps the *timbre* of the two ears
   * matched, which makes the beat easier to hear and less fatiguing.
   */
  function split(beat, centre) {
    var b = Math.abs(Number(beat) || 0);
    var c = Number(centre) || 0;
    return {
      left: round2(c - b / 2),
      right: round2(c + b / 2)
    };
  }

  /** Centre pitch of two tones, i.e. the midpoint a split() would use. */
  function centreOf(left, right) {
    return round2((Number(left) + Number(right)) / 2);
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  /* ---------------------------------------------------------------- presets */
  /**
   * Carrier pitches are deliberately in the 170–450 Hz region: low enough to
   * feel smooth, high enough that the ear resolves them well. Beat rates walk
   * up through every band so the presets can be compared back to back.
   */
  var PRESETS = [
    {
      id: 'swell', name: 'Slow swell', band: 'sub', beat: 0.4,
      left: 174, right: 174.4,
      blurb: 'One broad swell every 2.5 s — the beat as a pulse, not a tone.'
    },
    {
      id: 'delta', name: 'Delta sleep', band: 'delta', beat: 2.5,
      left: 180, right: 182.5,
      blurb: 'Slow rolling waves. The classic wind-down setting.'
    },
    {
      id: 'theta', name: 'Theta drift', band: 'theta', beat: 6,
      left: 200, right: 206,
      blurb: 'Loose, drifting, meditative. Good for breath work.'
    },
    {
      id: 'schumann', name: 'Schumann 7.83', band: 'theta', beat: 7.83,
      left: 220, right: 227.83,
      blurb: 'A famous "earth resonance" number. Sits at the theta/alpha edge.'
    },
    {
      id: 'alpha', name: 'Alpha focus', band: 'alpha', beat: 10,
      left: 210, right: 220,
      blurb: 'The most commonly reported "awake but calm" beat rate.'
    },
    {
      id: 'beta', name: 'Beta alert', band: 'beta', beat: 16,
      left: 250, right: 266,
      blurb: 'Faster, more insistent pulsing. Pairs with focused work.'
    },
    {
      id: 'gamma', name: 'Gamma buzz', band: 'gamma', beat: 40,
      left: 400, right: 440,
      blurb: 'Fast enough to blur into a roughness. A good stress test.'
    },
    {
      id: 'unison', name: 'Unison control', band: 'unison', beat: 0,
      left: 220, right: 220,
      blurb: 'Identical tones: no beat at all. Compare it to the rest.'
    }
  ];

  global.BB = global.BB || {};
  global.BB.BANDS = BANDS;
  global.BB.classify = classify;
  global.BB.split = split;
  global.BB.centreOf = centreOf;
  global.BB.round2 = round2;
  global.BB.presets = PRESETS;
})(window);
