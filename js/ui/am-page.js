// AM page: controls → SDR.am / SDR.channel → plots, readouts, audio, SNR sweep (on the SDR.page scaffold).
(function () {
  'use strict';
  var ui = SDR.ui, FS = 48000, DEG = Math.PI / 180;
  var PREVIEW_S = 0.25, FULL_S = 2, SWEEP_S = 0.5, ILLUSTRATIVE_FC = 6000;
  var DEFAULTS = { src: 'tone', f: 1000, type: 'DSB-LC', mu: 0.8, noise: true, cnr: 20, phase: 0,
    demod: 'envelope', est: 0, bw: 5000, seed: 1 };

  var page = SDR.page.create({
    defaults: DEFAULTS, fs: FS, run: run, sync: sync,
    receivedTitle: 'Play the in-phase part of the received baseband (DC removed)',
    readouts: [['snr', 'Output SNR (measured)'], ['cnr', 'Input CNR'], ['ideal', 'Ideal coherent SNR'], ['eta', 'Modulation efficiency η']]
  });
  var lv = page.live, commit = page.commit;

  var c = {
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
      title: 'Receiver lowpass cutoff; also sets the 2W bandwidth used to define CNR', onInput: lv.input, onChange: lv.commit })
  };
  var modeWarn = document.createElement('p');
  modeWarn.className = 'warn';
  modeWarn.setAttribute('role', 'alert');
  modeWarn.textContent = '⚠ Over-modulation: μ > 1, the envelope crosses zero.';

  page.group('Source', page.sourceControls({ fMin: 100, fMax: 5000, f: DEFAULTS.f }));
  page.group('Modulation', [c.type, c.mu, modeWarn]);
  page.group('Channel', [c.noise, c.cnr, c.phase, page.seedControl()]);
  page.group('Demodulator', [c.demod, c.est, c.bw]);

  function sync(s) {
    c.mu.setDisabled(s.type !== 'DSB-LC');
    c.cnr.setDisabled(!s.noise);
    c.est.setDisabled(s.demod !== 'coherent');
    modeWarn.hidden = !(s.type === 'DSB-LC' && s.mu > 1);
  }

  // ---------- plots ----------
  var pTime = page.addPlot({ title: 'Message and demodulated output', xLabel: 'time (ms)', yLabel: 'amplitude', xUnit: 'ms', xLim: [0, 20], height: 260 });
  var pEnv = page.addPlot({ title: 'Received AM signal (illustrative carrier ' + ILLUSTRATIVE_FC / 1000 + ' kHz) and its envelope', xLabel: 'time (ms)', yLabel: 'amplitude', xUnit: 'ms', xLim: [0, 20], height: 260 });
  var pPsd = page.addPlot({ title: 'Spectrum at complex baseband (Welch)', xLabel: 'frequency (kHz)', yLabel: 'power per bin (dB)', xUnit: 'kHz', yUnit: 'dB', height: 280 });
  var pIq = page.addPlot({ title: 'Received baseband I/Q', xLabel: 'I', yLabel: 'Q', equalAspect: true, height: 320 });
  page.addSweep({
    title: 'Sweep CNR from −5 to 40 dB with both detectors at the current settings',
    plot: { title: 'Output SNR vs CNR', xLabel: 'CNR (dB)', yLabel: 'output SNR (dB)', xUnit: 'dB', yUnit: 'dB', height: 300 },
    task: sweepTask
  });

  // ---------- simulation ----------
  function meanSq(a) { var p = 0; for (var i = 0; i < a.length; i++) p += a[i] * a[i]; return p / a.length; }

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
    d.snr = SDR.dsp.measureOutputSnr(sim.m, d.y, d.delay);
    return d;
  }

  function run(s, full) {
    var m = page.message(s, Math.round(page.duration(s, full, FULL_S, PREVIEW_S) * FS), s.bw);
    var sim = simulate(m, s, SDR.rng.createRng(s.seed));
    var d = detect(sim, s, s.demod);
    var k = s.type === 'DSB-LC' && s.mu > 0 ? 1 / s.mu : 1; // so the output overlays m(t)
    var y = new Float64Array(d.y.length);
    for (var i = 0; i < y.length; i++) y[i] = d.y[i] * k;
    draw(s, sim, d, y);
    return { original: { x: m, fs: FS }, received: { x: sim.rx.re, fs: FS }, demodulated: { x: y, fs: FS } };
  }

  function timeAxis(n, offset) {
    var t = new Float64Array(n);
    for (var i = 0; i < n; i++) t[i] = ((i - offset) / FS) * 1000;
    return t;
  }

  function draw(s, sim, d, y) {
    var n = sim.m.length, tm = timeAxis(n, 0), i;
    pTime.setData([
      { type: 'line', x: tm, y: sim.m, label: 'message m(t)' },
      { type: 'line', x: timeAxis(y.length, d.delay), y: y, label: 'demodulated' + (s.type === 'DSB-LC' ? ' ÷ μ' : '') }
    ]);

    var env = SDR.cx.abs(sim.rx), pb = new Float64Array(n), negEnv = new Float64Array(n), w = 2 * Math.PI * ILLUSTRATIVE_FC / FS;
    for (i = 0; i < n; i++) {
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

    var noise = SDR.cx.sub(sim.rx, sim.clean);
    var cnrMeas = 10 * Math.log10(sim.refPower / (SDR.cx.power(noise) * (2 * s.bw) / FS));
    var eta = s.type === 'DSB-LC' ? sim.pc / (1 + sim.pc) : 1;
    var dphi = ((s.phase - s.est + 540) % 360) - 180, cosd = Math.cos(dphi * DEG);
    var ideal = s.noise ? s.cnr + sim.idealDb : NaN;
    page.setReadouts({
      snr: fmtDb(d.snr.snrDb),
      cnr: s.noise ? fmtDb(s.cnr) + ' (meas. ' + (isFinite(cnrMeas) ? cnrMeas.toFixed(1) : '–') + ')' : 'noise off',
      eta: (100 * eta).toFixed(1) + ' %',
      ideal: s.noise ? fmtDb(ideal) : '–'
    });
    page.setExplain(explain(s, d.snr.snrDb, ideal, dphi, cosd));
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

  // ---------- SNR sweep (generator, run by SDR.ui.runChunked) ----------
  function* sweepTask(s, plot) {
    var m = page.message(s, Math.round(SWEEP_S * FS), s.bw), cnrs = [];
    for (var v = -5; v <= 40; v += 1) cnrs.push(v);
    var rng = SDR.rng.createRng(s.seed), env = [], coh = [], idealDb = 0;
    for (var i = 0; i < cnrs.length; i++) {
      var sp = Object.assign({}, s, { noise: true, cnr: cnrs[i] });
      var sim = simulate(m, sp, rng);
      idealDb = sim.idealDb;
      yield i / cnrs.length;
      env.push(detect(sim, sp, 'envelope').snr.snrDb);
      yield (i + 0.5) / cnrs.length;
      coh.push(detect(sim, sp, 'coherent').snr.snrDb);
      var xs = cnrs.slice(0, env.length);
      plot.setData([
        { type: 'line', x: cnrs, y: cnrs.map(function (c0) { return c0 + idealDb; }), label: 'ideal coherent', dash: [6, 4], lineWidth: 1.2, color: '#888888' },
        { type: 'line', x: xs, y: env, label: 'envelope' },
        { type: 'line', x: xs, y: coh, label: 'coherent (φ̂ = ' + s.est + '°)' }
      ]);
      yield (i + 1) / cnrs.length;
    }
  }

  page.start();
})();
