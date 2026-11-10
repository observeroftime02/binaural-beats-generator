/*!
 * app.js — the glue
 * ---------------------------------------------------------------------------
 * Deliberately dumb: it renders the state model into the DOM and forwards user
 * input back into it. Nothing here computes a frequency; that all lives in
 * state.js. One direction of data flow keeps the UI from ever disagreeing with
 * the audio:
 *
 *      input ──▶ state ──▶ render() ──▶ DOM + engine + visualiser
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var BB = global.BB || {};
  var doc = global.document;

  var STORE_KEY = 'binaural-lab/v1';
  var BAND_LOG = { min: 0.5, max: 40 };   // log domain used by the band strip

  /* ------------------------------------------------------------- utilities */
  function $(id) { return doc.getElementById(id); }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function trimNum(v) {
    var n = Math.round(Number(v) * 100) / 100;
    return String(n);
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setValue(node, value) {
    if (!node) return;
    var s = String(value);
    if (node.value !== s) node.value = s;
  }

  /** Write a number field unless the user is currently typing in it. */
  function writeNum(node, value, skip) {
    if (!node) return;
    if (node === skip || doc.activeElement === node) return;
    setValue(node, value);
  }

  function beatLabel(hz) {
    if (Math.abs(hz) < 0.005) return 'no beat';
    return trimNum(hz) + ' Hz';
  }

  /* ------------------------------------------------------- persistent state */
  function readSaved() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;   // private mode, file:// restrictions, corrupt JSON…
    }
  }

  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = global.setTimeout(function () {
      saveTimer = null;
      try {
        global.localStorage.setItem(STORE_KEY, JSON.stringify(state.toJSON()));
      } catch (e) { /* storage unavailable — not worth bothering the user */ }
    }, 200);
  }

  /* ------------------------------------------------------------- instances */
  var LATENCY_KEY = 'binaural-lab/latency';

  function readLatencyPref() {
    try {
      return global.localStorage.getItem(LATENCY_KEY) === 'interactive'
        ? 'interactive' : 'playback';
    } catch (e) {
      return 'playback';
    }
  }

  var state = new BB.BinauralState(readSaved());
  var engine = new BB.BinauralEngine({ latencyHint: readLatencyPref() });

  /* Node lists are cached: render() runs on every slider input event, and
     querySelectorAll on each one is a surprisingly large amount of work to do
     while the audio thread needs the main thread to stay responsive. */
  var uiNodes = { segButtons: [], segments: [], chips: [] };

  function cacheNodes() {
    uiNodes.segButtons = doc.querySelectorAll('.segmented__btn');
    uiNodes.segments = doc.querySelectorAll('.bandstrip__seg');
    uiNodes.chips = doc.querySelectorAll('.chip');
  }

  var diagHandle = null;

  var playBtn = $('play');
  var workspace = doc.querySelector('.workspace');
  var sleepTimer = new BB.SleepTimer(60);   // 60 s fade-out at the end
  var timerHandle = null;
  var noticeHandle = null;
  var viz = new BB.BeatVisualizer($('beat-canvas'));
  var gauge = new BB.PeriodGauge($('period-dial'));

  /**
   * Label for the wave canvas. Says "slowed" whenever the on-screen motion is
   * capped — the crest count still shows the real rate, the drift does not.
   */
  function beatTag(beat) {
    if (beat < 0.05) return 'beat wave · no beat';
    var tag = 'beat wave · ' + trimNum(beat) + ' Hz';
    if (beat > BB.MOTION_CAP + 0.05) tag += ' · slowed';
    return tag;
  }

  var presetById = {};
  BB.presets.forEach(function (p) { presetById[p.id] = p; });

  var lastBandKey = null;

  /* ---------------------------------------------------------- band strip UI */
  function bandOffset(hz) {
    var lo = Math.log(BAND_LOG.min);
    var hi = Math.log(BAND_LOG.max);
    var v = clamp(hz, BAND_LOG.min, BAND_LOG.max);
    return ((Math.log(v) - lo) / (hi - lo)) * 100;
  }

  function buildBandStrip() {
    var strip = $('band-strip');
    if (!strip) return;
    strip.innerHTML = '';

    var lo = Math.log(BAND_LOG.min);
    var hi = Math.log(BAND_LOG.max);
    var span = hi - lo;

    BB.BANDS.forEach(function (band) {
      var a = Math.log(Math.max(band.min, BAND_LOG.min));
      var b = Math.log(Math.min(band.max, BAND_LOG.max));
      var seg = doc.createElement('div');
      seg.className = 'bandstrip__seg';
      seg.dataset.band = band.key;
      seg.style.setProperty('--w', (((b - a) / span) * 100).toFixed(2) + '%');
      seg.textContent = band.greek || band.label.charAt(0);
      seg.title = band.label + ' · ' + band.min + '–' + band.max + ' Hz';
      strip.appendChild(seg);
    });

    var marker = doc.createElement('div');
    marker.className = 'bandstrip__marker';
    marker.id = 'band-marker';
    strip.appendChild(marker);
  }

  /* ------------------------------------------------------------- presets UI */
  function buildPresets() {
    var grid = $('preset-grid');
    if (!grid) return;
    grid.innerHTML = '';

    BB.presets.forEach(function (preset) {
      var chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.preset = preset.id;
      chip.title = preset.blurb;

      var row = doc.createElement('span');
      row.className = 'chip__row';

      var name = doc.createElement('span');
      name.className = 'chip__name';
      name.textContent = preset.name;

      var beat = doc.createElement('span');
      beat.className = 'chip__beat';
      beat.textContent = beatLabel(preset.beat);

      row.appendChild(name);
      row.appendChild(beat);

      var blurb = doc.createElement('span');
      blurb.className = 'chip__blurb';
      blurb.textContent = preset.blurb;

      chip.appendChild(row);
      chip.appendChild(blurb);
      chip.addEventListener('click', function () { state.applyPreset(preset); });

      grid.appendChild(chip);
    });
  }

  /* ----------------------------------------------------------------- render */
  function paintSlider(el) {
    if (!el) return;
    var min = parseFloat(el.min);
    var max = parseFloat(el.max);
    var v = parseFloat(el.value);
    if (!isFinite(min) || !isFinite(max) || !isFinite(v) || max === min) return;
    var pct = ((v - min) / (max - min)) * 100;
    el.style.setProperty('--fill', clamp(pct, 0, 100).toFixed(2) + '%');
  }

  function updateStatus() {
    var out = $('status');
    // Drives the slow ambient drift behind the canvas (CSS only, no strobe).
    if (doc.body) doc.body.classList.toggle('is-playing', engine.isPlaying);

    if (!engine.isPlaying) {
      setText(out, 'idle');
      return;
    }

    var b = state.beatHz;
    var body = b < 0.05
      ? 'playing · unison, no beat'
      : 'playing · ' + state.left.toFixed(2) + ' Hz / ' + state.right.toFixed(2) + ' Hz';

    var solo = engine.solo;
    if (solo === 'left') setText(out, 'left ear only · ' + body);
    else if (solo === 'right') setText(out, 'right ear only · ' + body);
    else setText(out, body);
  }

  /** Short-lived message in the hint row (export results, session notices). */
  function notice(message, ms) {
    var el = $('notice');
    if (!el) return;
    setText(el, message);
    el.hidden = false;
    if (noticeHandle) global.clearTimeout(noticeHandle);
    noticeHandle = global.setTimeout(function () {
      noticeHandle = null;
      el.hidden = true;
    }, ms || 7000);
  }

  /* ------------------------------------------------------------ diagnostics */
  function refreshDiagnostics() {
    var d = engine.diagnostics;
    var load = d.load || { supported: false };

    setText($('diag-state'), d.state);
    setText($('diag-rate'), d.sampleRate ? (d.sampleRate / 1000).toFixed(1) + ' kHz' : '—');
    setText($('diag-latency'), d.baseLatency
      ? (d.baseLatency * 1000).toFixed(1) + ' ms'
      : '—');

    if (load.supported) {
      setText($('diag-load'),
        Math.round(load.average * 100) + '% avg · ' + Math.round(load.peak * 100) + '% peak');
      setText($('diag-underrun'), (load.underrun * 100).toFixed(1) + '%');
    } else {
      setText($('diag-load'), 'not reported');
      setText($('diag-underrun'), '—');
    }

    var sel = $('latency-mode');
    if (sel && sel.value !== d.latencyHint) sel.value = d.latencyHint;
  }

  /* ------------------------------------------------------------- ear check */
  /**
   * Mute one ear without touching the other. Deliberately not a hold-to-listen
   * gesture: a toggle is operable by keyboard and does not scroll the page on
   * touch. The card for the silent ear dims, and playback always starts back in
   * stereo, so it cannot be left on by accident.
   */
  function setSolo(mode) {
    engine.setSolo(mode);
    if (workspace) workspace.dataset.solo = mode;
    [['solo-left', 'left'], ['solo-right', 'right']].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      var on = mode === pair[1];
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.classList.toggle('is-on', on);
    });
    updateStatus();
  }

  /* ----------------------------------------------------------- sleep timer */
  function paintTimer() {
    var count = $('timer-count');
    if (!count) return;
    if (!sleepTimer.active) {
      count.hidden = true;
      count.textContent = '';
      return;
    }
    count.hidden = false;
    setText(count, BB.formatCountdown(sleepTimer.remainingMs(Date.now())));
  }

  function tickTimer() {
    var now = Date.now();
    if (!sleepTimer.active) { stopTimerTicking(); return; }
    paintTimer();
    // Only step the gain by hand when the audio-clock schedule is unavailable.
    if (!engine.hasScheduledFade) engine.setSessionFade(sleepTimer.fadeFactor(now));
    if (sleepTimer.isDone(now)) endSession();
  }

  function startTimerTicking() {
    if (timerHandle) return;
    timerHandle = global.setInterval(tickTimer, 250);
  }

  function stopTimerTicking() {
    if (!timerHandle) return;
    global.clearInterval(timerHandle);
    timerHandle = null;
  }

  function beginSession(minutes) {
    sleepTimer.start(minutes, Date.now());

    // Put the fade on the audio clock: a background tab throttles timers to
    // once a minute, which would otherwise turn the fade into a hard cut.
    var total = minutes * 60;
    var fade = Math.min(sleepTimer.fadeSeconds, total);
    engine.scheduleSessionFade(Math.max(0, total - fade), fade);

    paintTimer();
    startTimerTicking();
    // Setting a session is a clear "run this for N minutes" gesture.
    if (!engine.isPlaying) startAudio();
  }

  function cancelSession() {
    stopTimerTicking();
    sleepTimer.stop();
    engine.clearSessionFade();
    var sel = $('timer-select');
    if (sel) sel.value = '0';
    paintTimer();
  }

  function endSession() {
    stopTimerTicking();
    sleepTimer.stop();          // stop first, so stopAudio does not re-cancel
    engine.clearSessionFade();
    var sel = $('timer-select');
    if (sel) sel.value = '0';
    paintTimer();
    stopAudio();
    notice('session finished');
  }

  /* ---------------------------------------------------------------- export */
  var EXPORT_MIN_MINUTES = 1;
  var EXPORT_MAX_MINUTES = 120;   // 2 h is already ~1.4 GB of 16-bit stereo

  function readCustomMinutes() {
    var input = $('export-custom');
    var mins = parseFloat(input && input.value);
    if (!isFinite(mins)) mins = 60;
    return clamp(Math.round(mins), EXPORT_MIN_MINUTES, EXPORT_MAX_MINUTES);
  }

  function exportSeconds() {
    var sel = $('export-length');
    if (sel && sel.value === 'custom') return readCustomMinutes() * 60;
    var seconds = parseFloat(sel && sel.value);
    return isFinite(seconds) && seconds > 0 ? seconds : 180;
  }

  function exportLengthLabel(seconds) {
    if (seconds < 60) return Math.round(seconds) + ' s';
    var mins = seconds / 60;
    return (mins % 1 === 0 ? mins : mins.toFixed(1)) + ' min';
  }

  function updateExportEstimate() {
    var out = $('export-estimate');
    if (!out) return;
    var seconds = exportSeconds();
    var bytes = BB.exporter.estimatedBytes(seconds);
    var heavy = bytes > 250 * 1024 * 1024;

    setText(out, '≈ ' + BB.formatBytes(bytes));
    out.classList.toggle('is-heavy', heavy);
    out.title = exportLengthLabel(seconds) + ' WAV · ' + BB.formatBytes(bytes) +
      (heavy ? ' — large download; very long files can exceed browser memory.' : '');
  }

  /** Show the custom-minutes field only when the select asks for it. */
  function syncExportControls(focus) {
    var sel = $('export-length');
    var wrap = $('export-custom-wrap');
    var custom = $('export-custom');
    var isCustom = !!sel && sel.value === 'custom';

    if (wrap) wrap.hidden = !isCustom;
    if (custom) custom.disabled = !isCustom;
    if (isCustom && focus && custom && typeof custom.focus === 'function') {
      custom.focus();
      if (typeof custom.select === 'function') custom.select();
    }
    updateExportEstimate();
  }

  async function exportWav() {
    var btn = $('export-btn');
    var seconds = exportSeconds();

    if (!BB.exporter.isSupported()) {
      notice('this browser cannot render audio offline');
      return;
    }

    var original = btn ? btn.textContent : 'WAV';
    if (btn) { btn.disabled = true; btn.textContent = 'rendering…'; }
    notice('rendering ' + exportLengthLabel(seconds) + ' · ' +
      BB.formatBytes(BB.exporter.estimatedBytes(seconds)) + '…', 60000);

    try {
      var result = await BB.exporter.renderWav({
        left: state.left,
        right: state.right,
        volume: state.volume,
        seconds: seconds
      }, function (progress) {
        var pct = Math.round((progress.rendered / progress.total) * 100);
        if (btn) btn.textContent = pct + '%';
        notice('rendering ' + exportLengthLabel(seconds) + ' · ' + pct + '% · ' +
          BB.formatBytes(progress.bytes) + '…', 60000);
      });

      var name = BB.exporter.filename({
        left: state.left, right: state.right, seconds: seconds
      });
      var bytes = BB.exporter.save(result.parts, name);
      notice('saved ' + name + ' · ' + BB.formatBytes(bytes));
    } catch (err) {
      notice('export failed: ' + (err && err.message ? err.message : err));
      if (global.console) global.console.error(err);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  function render(skip) {
    var left = state.left;
    var right = state.right;
    var beat = state.beatHz;
    var band = state.band;

    /* --- theme follows the band --------------------------------------- */
    doc.documentElement.dataset.band = band.key;
    if (band.key !== lastBandKey) {
      lastBandKey = band.key;
      viz.refreshPalette();
    }

    /* --- headline numbers --------------------------------------------- */
    setText($('beat-value'), beat.toFixed(2));

    var hi = Math.max(left, right);
    var lo = Math.min(left, right);
    setText($('beat-math'), beat < 0.005
      ? 'both ears · ' + left.toFixed(2) + ' Hz'
      : hi.toFixed(2) + ' − ' + lo.toFixed(2) + ' Hz');

    setText($('band-pill'), band.label);
    setText($('band-note'), band.note);

    /* --- carrier controls --------------------------------------------- */
    writeNum($('left-num'), trimNum(left), skip);
    writeNum($('right-num'), trimNum(right), skip);
    setValue($('left-range'), left);
    setValue($('right-range'), right);

    /* --- target controls ---------------------------------------------- */
    writeNum($('beat-num'), trimNum(state.data.beat), skip);
    writeNum($('centre-num'), trimNum(state.data.centre), skip);
    setValue($('beat-range'), state.data.beat);
    setValue($('centre-range'), state.data.centre);
    setText($('target-left'), left.toFixed(2));
    setText($('target-right'), right.toFixed(2));

    /* --- volume ------------------------------------------------------- */
    var volPct = Math.round(state.volume * 100);
    setValue($('volume-range'), volPct);
    setText($('volume-out'), volPct + '%');

    /* --- mode indicator ----------------------------------------------- */
    if (workspace) workspace.dataset.mode = state.mode;
    setText($('mode-hint'), state.mode === 'target'
      ? 'Beat and centre decide; the two ear faders are calculated from them.'
      : 'The two ear faders decide; beat and centre simply follow them.');
    Array.prototype.forEach.call(uiNodes.segButtons, function (btn) {
      var active = btn.dataset.mode === state.mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    /* --- band strip ---------------------------------------------------- */
    var marker = $('band-marker');
    if (marker) marker.style.left = bandOffset(beat).toFixed(2) + '%';
    Array.prototype.forEach.call(uiNodes.segments, function (seg) {
      seg.classList.toggle('is-current', seg.dataset.band === band.key);
    });

    /* --- presets -------------------------------------------------------- */
    Array.prototype.forEach.call(uiNodes.chips, function (chip) {
      var p = presetById[chip.dataset.preset];
      var active = p &&
        Math.abs(left - p.left) < 0.005 &&
        Math.abs(right - p.right) < 0.005;
      chip.classList.toggle('is-active', !!active);
    });

    /* --- slider fills --------------------------------------------------- */
    ['left-range', 'right-range', 'beat-range', 'centre-range', 'volume-range']
      .forEach(function (id) { paintSlider($(id)); });

    /* --- the live beat wave ---------------------------------------------- */
    // One second wide, one crest per beat: count the waves, read the hertz.
    setText($('stage-tag'), beatTag(beat));
    setText($('period-cap'), 'period · ' + BB.periodLabel(beat));
    viz.setBeat(beat);
    gauge.setBeat(beat);

    /* --- audio ------------------------------------------------------------ */
    engine.setFrequencies(left, right);
    engine.setVolume(state.volume);

    updateStatus();
  }

  /* -------------------------------------------------------------- transport */
  async function startAudio() {
    if (!BB.BinauralEngine.isSupported()) {
      setText($('status'), 'this browser has no Web Audio support');
      return;
    }
    // A session always begins in stereo, so a forgotten ear check can never
    // make the first ten seconds of a new session sound broken.
    if (engine.solo !== 'both') setSolo('both');
    if (playBtn) playBtn.disabled = true;
    setText($('status'), 'starting…');

    try {
      await engine.start({
        left: state.left,
        right: state.right,
        volume: state.volume
      });
      viz.setPlaying(true);
      if (playBtn) {
        playBtn.classList.add('is-playing');
        playBtn.setAttribute('aria-pressed', 'true');
      }
      setText($('play-label'), 'Stop tones');
      updateStatus();
    } catch (err) {
      setText($('status'), 'could not start audio');
      if (global.console) global.console.error(err);
    } finally {
      if (playBtn) playBtn.disabled = false;
    }
  }

  function stopAudio() {
    engine.stop();
    viz.setPlaying(false);
    // Pressing stop ends the session, timer included.
    if (sleepTimer.active) cancelSession();
    if (playBtn) {
      playBtn.classList.remove('is-playing');
      playBtn.setAttribute('aria-pressed', 'false');
    }
    setText($('play-label'), 'Play tones');
    updateStatus();
  }

  function toggleAudio() {
    if (engine.isPlaying) stopAudio();
    else startAudio();
  }

  /* ---------------------------------------------------------------- binding */
  function bindRange(id, apply) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', function () {
      apply(parseFloat(el.value));
    });
  }

  function bindNumber(id, readCurrent, apply) {
    var el = $(id);
    if (!el) return;

    el.addEventListener('input', function () {
      var v = parseFloat(el.value);
      if (!isFinite(v)) return;                 // mid-typing, wait
      var min = parseFloat(el.min);
      var max = parseFloat(el.max);
      if (isFinite(min) && v < min) return;     // let them finish typing
      if (isFinite(max) && v > max) return;
      apply(v);
    });

    function commit() {
      var v = parseFloat(el.value);
      if (!isFinite(v)) v = readCurrent();
      apply(v);
      el.value = trimNum(readCurrent());
    }

    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    });
  }

  function initBindings() {
    /* carriers */
    bindRange('left-range', function (v) { state.setTone('left', v, { force: true }); });
    bindRange('right-range', function (v) { state.setTone('right', v, { force: true }); });
    bindNumber('left-num', function () { return state.left; },
      function (v) { state.setTone('left', v, { force: true }); });
    bindNumber('right-num', function () { return state.right; },
      function (v) { state.setTone('right', v, { force: true }); });

    /* beat target */
    bindRange('beat-range', function (v) { state.setBeat(v); });
    bindRange('centre-range', function (v) { state.setCentre(v); });
    bindNumber('beat-num', function () { return state.data.beat; },
      function (v) { state.setBeat(v); });
    bindNumber('centre-num', function () { return state.data.centre; },
      function (v) { state.setCentre(v); });

    /* volume */
    bindRange('volume-range', function (v) { state.setVolume(v / 100); });

    /* mode switch */
    Array.prototype.forEach.call(uiNodes.segButtons, function (btn) {
      btn.addEventListener('click', function () { state.setMode(btn.dataset.mode); });
    });

    /* ear check */
    var soloL = $('solo-left');
    if (soloL) soloL.addEventListener('click', function () {
      setSolo(engine.solo === 'left' ? 'both' : 'left');
    });
    var soloR = $('solo-right');
    if (soloR) soloR.addEventListener('click', function () {
      setSolo(engine.solo === 'right' ? 'both' : 'right');
    });

    /* sleep timer */
    var timerSelect = $('timer-select');
    if (timerSelect) {
      timerSelect.addEventListener('change', function () {
        var mins = parseFloat(timerSelect.value) || 0;
        if (mins > 0) {
          beginSession(mins);
          notice('fades out over the final minute');
        } else {
          cancelSession();
        }
      });
    }

    /* wav export */
    var exportBtn = $('export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportWav);

    var exportLength = $('export-length');
    if (exportLength) {
      exportLength.addEventListener('change', function () { syncExportControls(true); });
    }

    var exportCustom = $('export-custom');
    if (exportCustom) {
      exportCustom.addEventListener('input', updateExportEstimate);
      exportCustom.addEventListener('change', function () {
        exportCustom.value = String(readCustomMinutes());
        updateExportEstimate();
      });
    }

    /* diagnostics: buffer strategy + live audio-thread stats */
    var latencySelect = $('latency-mode');
    if (latencySelect) {
      latencySelect.value = readLatencyPref();
      latencySelect.addEventListener('change', function () {
        engine.setLatencyMode(latencySelect.value);
        try {
          global.localStorage.setItem(LATENCY_KEY, latencySelect.value);
        } catch (e) { /* storage unavailable */ }
        refreshDiagnostics();
        notice('buffer mode takes effect next time you press play');
      });
    }

    var diag = $('diagnostics');
    if (diag) {
      diag.addEventListener('toggle', function () {
        if (diag.open) {
          refreshDiagnostics();
          if (!diagHandle) diagHandle = global.setInterval(refreshDiagnostics, 1000);
        } else if (diagHandle) {
          global.clearInterval(diagHandle);
          diagHandle = null;
        }
      });
    }

    /* transport */
    if (playBtn) playBtn.addEventListener('click', toggleAudio);
    var swap = $('swap');
    if (swap) swap.addEventListener('click', function () { state.swapEars(); });
    var reset = $('reset');
    if (reset) reset.addEventListener('click', function () { state.reset(); });

    /* keyboard: space = play/stop, escape = stop */
    doc.addEventListener('keydown', function (e) {
      var t = e.target;
      var tag = t && t.tagName;
      // A focused range still responds to the keyboard; a text field must not.
      var typing = (tag === 'INPUT' && t.type !== 'range') ||
                   tag === 'TEXTAREA' || tag === 'SELECT' ||
                   (t && t.isContentEditable);

      if ((e.code === 'Space' || e.key === ' ') && !typing && tag !== 'BUTTON') {
        e.preventDefault();
        toggleAudio();
      } else if (e.key === 'Escape' && engine.isPlaying) {
        stopAudio();
      }
    });

    /* a suspended context (backgrounded tab) should come back quietly */
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden) engine.resumeIfNeeded();
    });

    /* persist */
    state.subscribe(function () {
      scheduleSave();
    });
  }

  /* ------------------------------------------------------------------- boot */
  function boot() {
    buildBandStrip();
    buildPresets();
    cacheNodes();
    initBindings();

    state.subscribe(function (s, reason) {
      // The control that fired is the one we must not overwrite mid-typing.
      var active = doc.activeElement;
      render(active && active.classList && active.classList.contains('num') ? active : null);
    });

    render();
    updateStatus();
    paintTimer();
    syncExportControls(false);
    refreshDiagnostics();

    if (!BB.exporter.isSupported()) {
      var exportBtn = $('export-btn');
      if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.title = 'This browser cannot render audio offline';
      }
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for debugging / future extensions from the console.
  global.BBApp = {
    state: state, engine: engine, render: render, viz: viz, gauge: gauge,
    timer: sleepTimer, setSolo: setSolo, exportWav: exportWav, notice: notice,
    exportSeconds: exportSeconds, diagnostics: refreshDiagnostics
  };
})(window);
