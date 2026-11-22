// AM page: wires controls → SDR.am / SDR.channel → interactive plots, readouts, audio, SNR sweep.
(function () {
  'use strict';
  var ui = SDR.ui, FS = 48000;
  var PREVIEW_S = 0.25, FULL_S = 2, SWEEP_S = 0.5, ILLUSTRATIVE_FC = 6000;
  var DEG = Math.PI / 180;
  var DEFAULTS = { src: 'tone', f: 1000, type: 'DSB-LC', mu: 0.8, noise: true, cnr: 20, phase: 0,
    demod: 'envelope', est: 0, bw: 5000, seed: 1 };

  var $ = function (id) { return document.getElementById(id); };
  var fileMsg = null;   // uploaded audio, mono at FS
  var last = null;      // last full-length run, for playback

  // ---------- controls ----------
  var panel = $('controls');
  var status = ui.statusBar(null);
  var lv = ui.live({ preview: function () { run(false); }, commit: commit });

  var c = {
    src: ui.select({ key: 'src', label: 'Message', value: DEFAULTS.src, onChange: commit,
      title: 'Message signal m(t), normalized so |m| ≤ 1',
      options: [{ value: 'tone', label: 'Tone' }, { value: 'twotone', label: 'Two-tone (700 + 1900 Hz)' },
        { value: 'chirp', label: 'Chirp (200 Hz → 4 kHz, 1 s)' }, { value: 'file', label: 'Audio file…' }] }),
    f: ui.slider({ key: 'f', label: 'Tone frequency', min: 100, max: 5000, log: true, unit: 'Hz', value: DEFAULTS.f,
      title: 'Frequency of the test tone (log scale)', onInput: lv.input, onChange: lv.commit }),
    type: ui.select({ key: 'type', label: 'AM type', value: DEFAULTS.type, onChange: commit,
      title: 'DSB-LC: 1 + μ·m(t), carrier transmitted. DSB-SC: m(t), suppressed carrier.',
      options: [{ value: 'DSB-LC', label: 'DSB-LC (with carrier)' }, { value: 'DSB-SC', label: 'DSB-SC (suppressed carrier)' }] }),
    mu: ui.slider({ key: 'mu', label: 'Modulation index μ', min: 0, max: 1.5, step: 0.01, value: DEFAULTS.mu,
      title: 'Depth of modulation for DSB-LC. Above 1 the envelope crosses zero (over-modulation).', onInput: lv.input, onChange: lv.commit }),
    noise: ui.toggle({ key: 'noise', label: 'Add channel noise', checked: DEFAULTS.noise, onChange: commit,
      title: 'Add complex white Gaussian noise in the channel' }),
    cnr: ui.slider({ key: 'cnr', label: 'CNR', min: -5, max: 40, step: 0.5, unit: 'dB', value: DEFAULTS.cnr,
      title: 'Carrier (DSB-LC) or signal (DSB-SC) power over noise power in the 2W message bandwidth', onInput: lv.input, onChange: lv.commit }),
    phase: ui.slider({ key: 'phase', label: 'Channel phase offset', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.phase,
      title: 'Carrier phase rotation introduced by the channel (rotates the I/Q scatter)', onInput: lv.input, onChange: lv.commit }),
    demod: ui.select({ key: 'demod', label: 'Detector', value: DEFAULTS.demod, onChange: commit,
      title: 'Envelope: |r(t)|, no carrier phase needed. Coherent: Re{r(t)·e^(−jφ̂)}, needs the carrier phase.',
      options: [{ value: 'envelope', label: 'Envelope' }, { value: 'coherent', label: 'Coherent' }] }),
    est: ui.slider({ key: 'est', label: 'Receiver phase estimate φ̂', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.est,
      title: 'Coherent detector\'s carrier-phase estimate. Output scales by cos(offset − estimate).', onInput: lv.input, onChange: lv.commit }),
    bw: ui.slider({ key: 'bw', label: 'Audio bandwidth W', min: 1000, max: 8000, step: 100, unit: 'Hz', value: DEFAULTS.bw,
      title: 'Receiver lowpass cutoff; also sets the 2W bandwidth used to define CNR', onInput: lv.input, onChange: lv.commit }),
    seed: ui.number({ key: 'seed', label: 'Seed', value: DEFAULTS.seed, min: 0, step: 1, onChange: commit,
      title: 'Random seed for the channel noise; the same seed reproduces the same run' })
  };
  var controls = Object.keys(c).map(function (k) { return c[k]; });

  var file = ui.fileInput({ label: 'Audio file (first 10 s used)', accept: 'audio/*', onFile: loadFile,
    title: 'Any format your browser can decode; mixed to mono and resampled to 48 kHz' });
  var dice = ui.button({ label: '🎲', ariaLabel: 'Random seed', title: 'Pick a random seed', onClick: function () {
    c.seed.set(Math.floor(Math.random() * 1e6), true); commit();
  } });
  c.seed.el.appendChild(dice.el);

  var volume = ui.slider({ label: 'Volume', min: 0, max: 100, step: 1, unit: '%', value: 50,
    title: 'Playback volume', onInput: function (v) { SDR.audio.setVolume(v / 100); } });
  function playBtn(label, title, pick) {
    return ui.button({ label: label, title: title, onClick: function () {
      if (!last) run(true);
      var x = pick(last);
      status.set('Playing ' + label.replace('▶ Play ', '') + '…');
      SDR.audio.setVolume(volume.get() / 100);
      SDR.audio.play(x, FS).then(function () { if (!SDR.audio.isPlaying()) status.set('Ready'); });
    } });
  }

  var modeWarn = document.createElement('p');
  modeWarn.className = 'warn';
  modeWarn.setAttribute('role', 'alert');
  modeWarn.textContent = '⚠ Over-modulation: μ > 1, the envelope crosses zero.';

  panel.appendChild(status.el);
  panel.appendChild(ui.group('Source', [c.src, c.f, file]));
  panel.appendChild(ui.group('Modulation', [c.type, c.mu, modeWarn]));
  panel.appendChild(ui.group('Channel', [c.noise, c.cnr, c.phase, c.seed]));
  panel.appendChild(ui.group('Demodulator', [c.demod, c.est, c.bw]));
  var playRow = document.createElement('div');
  playRow.className = 'btn-row';
  [playBtn('▶ Play original', 'Play the message m(t)', function (r) { return r.m; }),
    playBtn('▶ Play received', 'Play the in-phase part of the received baseband (DC removed)', function (r) { return r.rx.re; }),
    playBtn('▶ Play demodulated', 'Play the detector output', function (r) { return r.y; }),
    ui.button({ label: '■ Stop', title: 'Stop playback', onClick: function () { SDR.audio.stop(); status.set('Stopped'); } })
  ].forEach(function (b) { playRow.appendChild(b.el); });
  panel.appendChild(ui.group('Listen', [playRow, volume]));
  var linkRow = document.createElement('div');
  linkRow.className = 'btn-row';
  linkRow.appendChild(ui.button({ label: 'Reset to defaults', title: 'Restore every control to its default', onClick: function () {
    ui.applyState(controls, DEFAULTS); commit();
  } }).el);
  linkRow.appendChild(ui.button({ label: 'Copy link', title: 'Copy a link that restores this exact setup', onClick: function () {
    ui.writeHash(ui.stateOf(controls));
    ui.copyText(location.href).then(function () { status.set('Link copied', 'ok'); }, function () { status.set('Copy failed. The link is in the address bar.', 'err'); });
  } }).el);
  panel.appendChild(linkRow);

  function syncEnabled() {
    var s = ui.stateOf(controls);
    c.f.setDisabled(s.src !== 'tone');
    file.el.hidden = s.src !== 'file';
    c.mu.setDisabled(s.type !== 'DSB-LC');
    c.cnr.setDisabled(!s.noise);
    c.est.setDisabled(s.demod !== 'coherent');
    modeWarn.hidden = !(s.type === 'DSB-LC' && s.mu > 1);
  }

  // ---------- plots ----------
  var P = SDR.plot.createPlot;
  var pTime = P($('p-time'), { title: 'Message and demodulated output', xLabel: 'time (ms)', yLabel: 'amplitude', xUnit: 'ms', xLim: [0, 20], height: 260 });
  var pEnv = P($('p-env'), { title: 'Received AM signal (illustrative carrier ' + ILLUSTRATIVE_FC / 1000 + ' kHz) and its envelope', xLabel: 'time (ms)', yLabel: 'amplitude', xUnit: 'ms', xLim: [0, 20], height: 260 });
  var pPsd = P($('p-psd'), { title: 'Spectrum at complex baseband (Welch)', xLabel: 'frequency (kHz)', yLabel: 'power per bin (dB)', xUnit: 'kHz', yUnit: 'dB', height: 280 });
  var pIq = P($('p-iq'), { title: 'Received baseband I/Q', xLabel: 'I', yLabel: 'Q', equalAspect: true, height: 320 });
  var pSnr = P($('p-snr'), { title: 'Output SNR vs CNR', xLabel: 'CNR (dB)', yLabel: 'output SNR (dB)', xUnit: 'dB', yUnit: 'dB', height: 300 });

  // ---------- simulation ----------
  function message(s, n) {
    var m = new Float64Array(n), i, t;
    if (s.src === 'file' && fileMsg) {
      var raw = fileMsg.subarray(0, Math.min(n, fileMsg.length));
      var lp = SDR.filters.lowpass({ cutoff: s.bw, fs: FS, transition: 500 });
      var padded = new Float64Array(raw.length + lp.groupDelay);
      padded.set(raw);
      m = SDR.filters.fir(padded, lp.taps).slice(lp.groupDelay); // band-limit to W, delay removed
      var peak = 0;
      for (i = 0; i < m.length; i++) peak = Math.max(peak, Math.abs(m[i]));
      if (peak > 0) for (i = 0; i < m.length; i++) m[i] /= peak;
      return m;
    }
    var src = s.src === 'file' ? 'tone' : s.src;
    for (i = 0; i < n; i++) {
      t = i / FS;
      if (src === 'tone') m[i] = Math.sin(2 * Math.PI * s.f * t);
      else if (src === 'twotone') m[i] = 0.5 * (Math.sin(2 * Math.PI * 700 * t) + Math.sin(2 * Math.PI * 1900 * t));
      else { var tau = t % 1; m[i] = Math.sin(2 * Math.PI * (200 * tau + 1900 * tau * tau)); } // 200→4000 Hz, phase-continuous per 1 s
    }
    return m;
  }

  function meanSq(a) { var p = 0; for (var i = 0; i < a.length; i++) p += a[i] * a[i]; return p / a.length; }

  // Everything except plotting. demodOverride lets the sweep run both detectors on the same rx.
  function simulate(m, s, rng) {
    var x = SDR.am.modulate(m, { type: s.type, mu: s.mu });
    var clean = SDR.channel.phaseOffset(x, s.phase * DEG);
    var refPower = s.type === 'DSB-LC' ? 1 : SDR.cx.power(x);
    var rx = s.noise ? SDR.channel.addAwgnCnr(clean, s.cnr, 2 * s.bw, FS, rng, { refPower: refPower }) : clean;
    var pm = meanSq(m), pc = s.type === 'DSB-LC' ? s.mu * s.mu * pm : pm;
    return { m: m, x: x, clean: clean, rx: rx, refPower: refPower, pm: pm, pc: pc,
      idealDb: 10 * Math.log10((2 * pc) / refPower) }; // ideal coherent: SNRout = CNR + idealDb
  }

  function detect(sim, s, demod) {
    var d = demod === 'envelope'
      ? SDR.am.demodEnvelope(sim.rx, { fs: FS, audioBw: s.bw })
      : SDR.am.demodCoherent(sim.rx, { fs: FS, audioBw: s.bw, phaseEst: s.est * DEG, dcBlock: s.type === 'DSB-LC' });
    d.snr = SDR.am.measureOutputSnr(sim.m, d.y, d.delay);
    return d;
  }

  function run(full) {
    var t0 = performance.now();
    var s = ui.stateOf(controls);
    syncEnabled();
    if (s.src === 'file' && !fileMsg && full) status.set('No audio file loaded yet: showing a tone. Choose a file below.', 'err');
    var dur = full ? (s.src === 'file' && fileMsg ? fileMsg.length / FS : FULL_S) : PREVIEW_S;
    var m = message(s, Math.round(dur * FS));
    var sim = simulate(m, s, SDR.rng.createRng(s.seed));
    var d = detect(sim, s, s.demod);
    var yScale = s.type === 'DSB-LC' && s.mu > 0 ? 1 / s.mu : 1; // so the output overlays m(t)
    var y = new Float64Array(d.y.length);
    for (var i = 0; i < y.length; i++) y[i] = d.y[i] * yScale;
    var r = { m: m, rx: sim.rx, y: y };
    if (full) last = r;
    draw(s, sim, d, y);
    if (full && !(s.src === 'file' && !fileMsg)) status.set('Done in ' + Math.round(performance.now() - t0) + ' ms', 'ok');
  }

  function commit() {
    syncEnabled();
    run(true);
    ui.writeHash(ui.stateOf(controls));
  }

  function timeAxis(n, offset) {
    var t = new Float64Array(n);
    for (var i = 0; i < n; i++) t[i] = ((i - offset) / FS) * 1000;
    return t;
  }

  function draw(s, sim, d, y) {
    var n = sim.m.length, tm = timeAxis(n, 0);
    pTime.setData([
      { type: 'line', x: tm, y: sim.m, label: 'message m(t)' },
      { type: 'line', x: timeAxis(y.length, d.delay), y: y, label: 'demodulated' + (s.type === 'DSB-LC' ? ' ÷ μ' : '') }
    ]);

    var env = SDR.cx.abs(sim.rx), pb = new Float64Array(n), negEnv = new Float64Array(n), w = 2 * Math.PI * ILLUSTRATIVE_FC / FS;
    for (var i = 0; i < n; i++) {
      pb[i] = sim.rx.re[i] * Math.cos(w * i) - sim.rx.im[i] * Math.sin(w * i);
      negEnv[i] = -env[i];
    }
    pEnv.setData([
      { type: 'line', x: tm, y: env, label: 'envelope |r(t)|', lineWidth: 1.5, color: SDR.plot.PALETTE[1] },
      { type: 'line', x: tm, y: negEnv, color: SDR.plot.PALETTE[1], lineWidth: 1.5 },
      { type: 'line', x: tm, y: pb, label: 'Re{r(t)·e^(j2πfct)}', lineWidth: 1, color: SDR.plot.PALETTE[0] }
    ]);

    var nfft = 4096;
    var rxP = SDR.dsp.welchPSD(sim.rx, FS, { nfft: nfft }), txP = SDR.dsp.welchPSD(sim.clean, FS, { nfft: nfft });
    var fk = Array.from(rxP.freqs, function (f) { return f / 1000; });
    var peak = -Infinity;
    for (i = 0; i < nfft; i++) peak = Math.max(peak, txP.psdDb[i]);
    var W = s.bw / 1000, ann = [{ type: 'band', x0: -W, x1: W, label: '2W = ' + (2 * W).toFixed(1) + ' kHz' }];
    if (s.type === 'DSB-LC') ann.push({ type: 'text', x: 0, y: txP.psdDb[nfft / 2], text: 'carrier' });
    if (s.src === 'tone') {
      var at = function (f) { return txP.psdDb[Math.round(f / (FS / nfft)) + nfft / 2]; };
      ann.push({ type: 'text', x: -s.f / 1000, y: at(-s.f), text: 'LSB' }, { type: 'text', x: s.f / 1000, y: at(s.f), text: 'USB' });
    } else {
      ann.push({ type: 'text', x: -W / 2, text: 'LSB' }, { type: 'text', x: W / 2, text: 'USB' });
    }
    pPsd.setOptions({ annotations: ann, xLim: [-1.6 * W, 1.6 * W], yLim: [peak - 90, peak + 8] });
    pPsd.setData([
      { type: 'line', x: fk, y: rxP.psdDb, label: s.noise ? 'received (with noise)' : 'received', lineWidth: 1.2 },
      { type: 'line', x: fk, y: txP.psdDb, label: 'transmitted', lineWidth: 1.2 }
    ]);

    var stride = Math.max(1, Math.floor(n / 3000)), iq = { x: [], y: [] };
    for (i = 0; i < n; i += stride) { iq.x.push(sim.rx.re[i]); iq.y.push(sim.rx.im[i]); }
    pIq.setData([{ type: 'scatter', x: iq.x, y: iq.y, radius: 1.6, alpha: 0.6, label: 'r(t) samples' }]);

    // readouts
    var noise = SDR.cx.sub(sim.rx, sim.clean);
    var cnrMeas = 10 * Math.log10(sim.refPower / (SDR.cx.power(noise) * (2 * s.bw) / FS));
    var eta = s.type === 'DSB-LC' ? sim.pc / (1 + sim.pc) : 1;
    var dphi = ((s.phase - s.est + 540) % 360) - 180, cosd = Math.cos(dphi * DEG);
    var ideal = s.noise ? s.cnr + sim.idealDb : NaN;
    $('r-snr').textContent = fmtDb(d.snr.snrDb);
    $('r-cnr').textContent = s.noise ? fmtDb(s.cnr) + ' (meas. ' + (isFinite(cnrMeas) ? cnrMeas.toFixed(1) : '–') + ')' : 'noise off';
    $('r-eta').textContent = (100 * eta).toFixed(1) + ' %';
    $('r-ideal').textContent = s.noise ? fmtDb(ideal) : '–';
    $('r-explain').textContent = explain(s, d.snr.snrDb, ideal, dphi, cosd);
  }

  function fmtDb(v) { return isFinite(v) ? v.toFixed(1) + ' dB' : '–'; }

  function explain(s, snr, ideal, dphi, cosd) {
    if (s.type === 'DSB-SC' && s.demod === 'envelope') return 'Envelope detector on DSB-SC recovers |m(t)|, not m(t), so the output is badly distorted. Switch to coherent detection.';
    if (s.type === 'DSB-LC' && s.mu > 1 && s.demod === 'envelope') return 'Over-modulation (μ > 1): 1 + μ·m(t) goes negative, the envelope folds over, and the detector distorts. A coherent detector still works.';
    if (s.demod === 'coherent' && Math.abs(cosd) < 0.995) {
      return 'Coherent detection with phase error Δφ = ' + dphi.toFixed(0) + '°: the output is scaled by cos Δφ = ' + cosd.toFixed(3) +
        ' (' + (20 * Math.log10(Math.max(Math.abs(cosd), 1e-6))).toFixed(1) + ' dB signal loss).' + (Math.abs(cosd) < 0.1 ? ' Near quadrature the message almost vanishes.' : '');
    }
    if (!s.noise) return 'Noise is off, so the output SNR is limited only by the receiver filter and any distortion.';
    if (s.demod === 'envelope' && snr < ideal - 3) return 'Envelope detector below threshold: output SNR collapsing (' + (ideal - snr).toFixed(1) + ' dB worse than coherent detection). Noise now dominates the carrier.';
    if (s.demod === 'envelope') return 'Envelope detector above threshold: within ' + Math.max(0, ideal - snr).toFixed(1) + ' dB of ideal coherent detection, without needing the carrier phase.';
    return 'Coherent detection: output SNR tracks CNR one-for-one (ideal ' + fmtDb(ideal) + ').';
  }

  // ---------- audio file ----------
  function loadFile(f) {
    status.set('Decoding audio…');
    var t0 = performance.now();
    SDR.audio.loadFile(f, { fs: FS, maxSeconds: 10 }).then(function (x) {
      var peak = 0;
      for (var i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      if (peak > 0) for (i = 0; i < x.length; i++) x[i] /= peak;
      fileMsg = x;
      c.src.set('file', true);
      commit();
      status.set('Loaded ' + f.name + ' (' + (x.length / FS).toFixed(1) + ' s) in ' + Math.round(performance.now() - t0) + ' ms', 'ok');
    }, function (e) { status.set('Could not decode audio: ' + (e && e.message ? e.message : e), 'err'); });
  }

  // ---------- SNR sweep ----------
  var sweep = null;
  var progress = $('sweep-progress'), btnSweep = $('sweep-start'), btnStop = $('sweep-stop');
  btnSweep.addEventListener('click', startSweep);
  btnStop.addEventListener('click', function () { if (sweep) sweep.cancel = true; });

  function startSweep() {
    if (sweep) return;
    var s = ui.stateOf(controls), m = message(s, Math.round(SWEEP_S * FS));
    var cnrs = [];
    for (var v = -5; v <= 40; v += 1) cnrs.push(v);
    var rng = SDR.rng.createRng(s.seed), env = [], coh = [], idealDb = 0, i = 0, t0 = performance.now();
    sweep = { cancel: false };
    btnSweep.disabled = true; btnStop.disabled = false;
    progress.max = cnrs.length; progress.value = 0; progress.hidden = false;
    status.set('Sweeping CNR…');

    function plotSweep() {
      var xs = cnrs.slice(0, env.length);
      pSnr.setData([
        { type: 'line', x: cnrs, y: cnrs.map(function (c0) { return c0 + idealDb; }), label: 'ideal coherent', dash: [6, 4], lineWidth: 1.2, color: '#888888' },
        { type: 'line', x: xs, y: env, label: 'envelope' },
        { type: 'line', x: xs, y: coh, label: 'coherent (φ̂ = ' + s.est + '°)' }
      ]);
    }

    function step() {
      if (sweep.cancel) return finish('Sweep stopped at ' + cnrs[i] + ' dB');
      var t1 = performance.now();
      while (i < cnrs.length && performance.now() - t1 < 40) { // ~40 ms of work per tick keeps the page responsive
        var sp = Object.assign({}, s, { noise: true, cnr: cnrs[i] });
        var sim = simulate(m, sp, rng);
        idealDb = sim.idealDb;
        env.push(detect(sim, sp, 'envelope').snr.snrDb);
        coh.push(detect(sim, sp, 'coherent').snr.snrDb);
        i++;
      }
      progress.value = i;
      plotSweep();
      if (i < cnrs.length) setTimeout(step, 0);
      else finish('Sweep done in ' + Math.round(performance.now() - t0) + ' ms');
    }
    function finish(msg) {
      sweep = null;
      btnSweep.disabled = false; btnStop.disabled = true; progress.hidden = true;
      status.set(msg, 'ok');
    }
    setTimeout(step, 0);
  }

  // ---------- start ----------
  function loadFromHash() { ui.applyState(controls, ui.readHash(DEFAULTS)); syncEnabled(); run(true); }
  window.addEventListener('hashchange', loadFromHash);
  loadFromHash();
  if (!(ui.stateOf(controls).src === 'file' && !fileMsg)) status.set('Ready', 'ok');
})();
