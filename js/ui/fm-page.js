/**
 * @file FM page wiring (DOM): controls → SDR.fm / SDR.channel → spectrum, time, instantaneous frequency, I/Q,
 * readouts, audio and the SNR-vs-γ sweep.
 */
(function () {
  'use strict';
  var ui = SDR.ui, FSA = 48000, FSR = 384000, DEG = Math.PI / 180;
  var PREVIEW_S = 0.05, FULL_S = 0.5, AUDIO_S = 3, SWEEP_S = 0.05; // plots use ≤ 0.5 s; audio renders separately on Play
  var DEFAULTS = { src: 'tone', f: 1000, dev: 10000, W: 5000, emph: 'off', ifMode: 'carson', ifBw: 30000,
    noise: true, cnr: 20, foff: 0, phase: 0, demod: 'disc', loopBw: 30000, bessel: true, betas: '1, 2, 5', seed: 1 };
  Object.assign(DEFAULTS, SDR.page.EXTRA_DEFAULTS);

  var page = SDR.page.create({
    defaults: DEFAULTS, fs: FSA, run: run, sync: sync, renderAudio: renderAudio, maxFileSeconds: 5,
    receivedTitle: 'Play the in-phase part of the received RF baseband (resampled to 48 kHz)',
    tour: [{ sel: '#controls', text: 'Start from a preset (Narrowband, Broadcast, beta = 1 or 5, mobile flutter), then adjust deviation, bandwidth and CNR.' },
      { sel: '.readouts', text: 'Beta, Carson bandwidth, measured 98% bandwidth, output SNR against theory, and clicks per second.' },
      { sel: '.plots .card.plot', text: 'The spectrum: Carson band, the deviation lines and the IF filter edges. Turn on Bessel to see the J_n(beta)^2 line heights.' },
      { sel: '#sweep-start', text: 'Sweep CNR for several beta values to see FM trade bandwidth for SNR, and where each one hits threshold.' }],
    readouts: [['beta', 'β = Δf / W'], ['carson', 'Carson B_T = 2(Δf + W)'], ['obw', 'Occupied BW (98%)'],
      ['cnr', 'Input CNR (in B_T)'], ['snr', 'Output SNR (measured)'], ['theory', 'Theory above threshold'], ['clicks', 'Clicks / s']]
  });
  var lv = page.live, commit = page.commit;

  function slider(o) { o.onInput = lv.input; o.onChange = lv.commit; return ui.slider(o); }
  var c = {
    dev: slider({ key: 'dev', label: 'Peak deviation Δf', min: 1000, max: 100000, log: true, unit: 'Hz', value: DEFAULTS.dev,
      title: 'Peak frequency deviation: |m| ≤ 1 swings the carrier by ±Δf' }),
    W: slider({ key: 'W', label: 'Audio bandwidth W', min: 1000, max: 15000, step: 100, unit: 'Hz', value: DEFAULTS.W,
      title: 'Message bandwidth: receiver audio lowpass cutoff, and W in β = Δf/W and Carson\'s rule' }),
    emph: ui.select({ key: 'emph', label: 'Pre/de-emphasis', value: DEFAULTS.emph, onChange: commit,
      title: 'Boost high audio frequencies before modulation and cut them after detection, where FM noise is strongest',
      options: [{ value: 'off', label: 'Off' }, { value: '75', label: '75 µs (US)' }, { value: '50', label: '50 µs (EU)' }] }),
    bessel: ui.toggle({ key: 'bessel', label: 'Show Bessel line heights', checked: DEFAULTS.bessel, onChange: commit,
      title: 'Overlay the theoretical tone-FM line powers J_n(β)² on the spectrum (tone source only)' }),
    ifMode: ui.select({ key: 'ifMode', label: 'IF bandwidth', value: DEFAULTS.ifMode, onChange: commit,
      title: 'Pre-detection filter bandwidth. Carson\'s rule passes ~98% of the FM power.',
      options: [{ value: 'carson', label: 'Carson (auto)' }, { value: 'manual', label: 'Manual' }] }),
    ifBw: slider({ key: 'ifBw', label: 'IF bandwidth (manual)', min: 4000, max: 300000, log: true, unit: 'Hz', value: DEFAULTS.ifBw,
      title: 'Total pre-detection bandwidth (passband ±bw/2). Too narrow distorts; too wide lets in noise and lowers the threshold margin.' }),
    noise: ui.toggle({ key: 'noise', label: 'Add channel noise', checked: DEFAULTS.noise, onChange: commit, title: 'Add complex white Gaussian noise in the channel' }),
    cnr: slider({ key: 'cnr', label: 'CNR (in B_T)', min: -5, max: 40, step: 0.5, unit: 'dB', value: DEFAULTS.cnr,
      title: 'Carrier power (1) over noise power inside the IF bandwidth B_T' }),
    foff: slider({ key: 'foff', label: 'Carrier frequency offset', min: -20000, max: 20000, step: 100, unit: 'Hz', value: DEFAULTS.foff,
      title: 'Receiver tuning error: appears as a DC shift in the discriminator output' }),
    phase: slider({ key: 'phase', label: 'Carrier phase offset', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.phase,
      title: 'Rotates the I/Q ring; an FM detector does not care' }),
    demod: ui.select({ key: 'demod', label: 'Demodulator', value: DEFAULTS.demod, onChange: commit,
      title: 'Discriminator: phase difference between samples. PLL: a phase-locked loop whose frequency tracks the signal.',
      options: [{ value: 'disc', label: 'Discriminator' }, { value: 'pll', label: 'PLL' }] }),
    loopBw: slider({ key: 'loopBw', label: 'PLL loop bandwidth', min: 1000, max: 150000, log: true, unit: 'Hz', value: DEFAULTS.loopBw,
      title: 'Wider tracks larger Δf·f_m but lets in more noise. Needs roughly ≥ 6.7·√(Δf·f_m).' })
  };

  function suggestLoop(dev, s) {
    var fm = s.src === 'tone' ? s.f : s.W / 2;
    return Math.min(150000, Math.max(2000, Math.round(3.33 * Math.sqrt(4 * dev * fm) / 1000) * 1000));
  }
  function preset(devFn, W) {
    return function () {
      var s = page.state();
      if (W) c.W.set(W, true);
      var dev = devFn(W || s.W);
      c.dev.set(dev, true);
      c.loopBw.set(suggestLoop(c.dev.get(), page.state()), true);
      commit();
    };
  }
  var presets = document.createElement('div');
  presets.className = 'btn-row';
  [['Narrowband', 'Δf = 5 kHz, W = 3 kHz', preset(function () { return 5000; }, 3000)],
    ['Broadcast', 'Δf = 75 kHz, W = 15 kHz', preset(function () { return 75000; }, 15000)],
    ['β = 1', 'Δf = W (keeps W)', preset(function (W) { return W; })],
    ['β = 5', 'Δf = 5·W (keeps W)', preset(function (W) { return Math.min(100000, 5 * W); })]
  ].forEach(function (p) { presets.appendChild(ui.button({ label: p[0], title: p[1], onClick: p[2] }).el); });
  // Mobile flutter: broadcast FM through Rayleigh fading at fd ≈ 50 Hz (a car at ~55 km/h on 100 MHz). Listen to it.
  presets.appendChild(ui.button({ label: 'FM mobile flutter', title: 'Broadcast FM, Rayleigh fading with 50 Hz Doppler, CNR 25 dB: press ▶ Play demodulated', onClick: function () {
    c.W.set(15000, true); c.dev.set(75000, true); c.loopBw.set(suggestLoop(75000, page.state()), true); c.cnr.set(25, true); c.noise.set(true, true);
    page.controls.forEach(function (k) {
      if (k.key === 'fadeOn') k.set(true, true); if (k.key === 'fadeModel') k.set('rayleigh', true); if (k.key === 'fadeHz') k.set(50, true);
    });
    commit();
  } }).el);

  page.group('Source', page.sourceControls({ fMin: 100, fMax: 15000, f: DEFAULTS.f }));
  page.group('Modulation', [presets, c.dev, c.W, c.emph, c.bessel]);
  page.group('Receiver filter', [c.ifMode, c.ifBw]);
  page.group('Channel', [c.noise, c.cnr, c.foff, c.phase, page.seedControl()]);
  page.extraChannelSections();
  page.group('Demodulator', [c.demod, c.loopBw]);

  function bwOf(s) { return s.ifMode === 'carson' ? SDR.fm.carson(s.dev, s.W) : s.ifBw; }
  function tauOf(s) { return s.emph === 'off' ? 0 : +s.emph * 1e-6; }

  function sync(s) {
    c.cnr.setDisabled(!s.noise);
    c.ifBw.setDisabled(s.ifMode !== 'manual');
    c.loopBw.el.hidden = s.demod !== 'pll';
    c.bessel.setDisabled(s.src !== 'tone');
  }

  // ---------- plots ----------
  var pSpec = page.addPlot({ title: 'FM spectrum (RF baseband, fs = 384 kHz)', xLabel: 'frequency (kHz)', yLabel: 'power per bin (dB)', xUnit: 'kHz', yUnit: 'dB', height: 300 });
  var pTime = page.addPlot({ title: 'Message and demodulated output', xLabel: 'time (ms)', yLabel: 'amplitude', xUnit: 'ms', xLim: [0, 20], height: 260 });
  var pInst = page.addPlot({ title: 'Instantaneous frequency (before audio filter)', xLabel: 'time (ms)', yLabel: 'frequency (kHz)', xUnit: 'ms', yUnit: 'kHz', xLim: [0, 20], height: 260 });
  var pIq = page.addPlot({ title: 'I/Q after the IF filter', xLabel: 'I', yLabel: 'Q', equalAspect: true, height: 320 });
  var betasCtl = ui.text({ key: 'betas', label: 'β values', value: DEFAULTS.betas, title: 'Up to four modulation indices to sweep, comma-separated (W stays fixed, Δf = β·W)' });
  page.addSweep({
    title: 'Sweep CNR from −5 to 30 dB for each β (tone or current source, ideal channel, current demodulator and emphasis)',
    extra: [betasCtl],
    plot: { title: 'Output SNR vs baseband SNR γ', xLabel: 'γ (dB)   [CNR in B_T = γ − 10·log10(B_T/W)]', yLabel: 'output SNR (dB)', xUnit: 'dB', yUnit: 'dB', height: 340 },
    task: sweepTask
  });

  // ---------- simulation ----------
  function meanSq(a) { var p = 0; for (var i = 0; i < a.length; i++) p += a[i] * a[i]; return p / a.length; }

  function simulate(mA, s, rng) {
    var bt = bwOf(s), tau = tauOf(s);
    var tx = SDR.fm.transmit(mA, { fsA: FSA, fsR: FSR, deviation: s.dev, tau: tau });
    var ch = SDR.channel.freqOffset(SDR.channel.phaseOffset(tx.x, s.phase * DEG), s.foff, FSR);
    var ex = page.extraChannel(s, FSR, 64, 1);   // fading / phase noise before the noise, ADC after
    if (ex.pre.length) ch = SDR.channel.apply(ch, ex.pre, rng);
    var rx = s.noise ? SDR.channel.addAwgnCnr(ch, s.cnr, bt, FSR, rng, { refPower: 1 }) : ch;
    if (ex.post.length) rx = SDR.channel.apply(rx, ex.post, rng);
    return { mA: mA, tx: tx, ch: ch, rx: rx, bt: bt, tau: tau };
  }

  function receive(sim, s) {
    var r = SDR.fm.receive(sim.rx, { fsA: FSA, fsR: FSR, deviation: s.dev, W: s.W, ifBw: sim.bt, demod: s.demod,
      loopBw: s.loopBw, tau: sim.tau, txDelay: sim.tx.delay });
    r.snr = SDR.dsp.measureOutputSnr(sim.mA, r.y, r.delay);
    return r;
  }

  function run(s, full) {
    var dur = full ? FULL_S : PREVIEW_S; // a file source uses its first `dur` seconds for the plots
    var mA = page.message(s, Math.round(dur * FSA), s.W);
    var sim = simulate(mA, s, SDR.rng.createRng(s.seed));
    var r = receive(sim, s);
    var clicks = s.noise ? SDR.fm.countClicks(r.ifOut, SDR.fm.ifFilter(sim.ch, { fsR: FSR, bw: sim.bt }).y, 2 * r.ifDelay) : 0;
    draw(s, sim, r, clicks / dur, full ? 8192 : 2048); // coarser spectrum while dragging keeps previews ~30 fps
  }

  function renderAudio(s) {
    var mA = page.message(s, Math.round(page.duration(s, true, AUDIO_S, AUDIO_S) * FSA), s.W);
    var sim = simulate(mA, s, SDR.rng.createRng(s.seed)), r = receive(sim, s);
    var recv = SDR.filters.decimateFiltered(sim.rx.re, FSR / FSA).y;
    return { original: { x: mA, fs: FSA }, received: { x: recv, fs: FSA }, demodulated: { x: r.y, fs: FSA } };
  }

  function timeAxis(n, fs, offset) {
    var t = new Float64Array(n);
    for (var i = 0; i < n; i++) t[i] = ((i - offset) / fs) * 1000;
    return t;
  }

  function fmtDb(v) { return isFinite(v) ? v.toFixed(1) + ' dB' : '–'; }
  function fmtHz(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 1e5 ? 0 : 1) + ' kHz' : Math.round(v) + ' Hz'; }

  function draw(s, sim, r, clicksPerSec, nfft) {
    var i, kHz = 1 / 1000, carsonBw = SDR.fm.carson(s.dev, s.W);

    // Spectrum
    var rxP = SDR.dsp.welchPSD(sim.rx, FSR, { nfft: nfft }), txP = SDR.dsp.welchPSD(sim.ch, FSR, { nfft: nfft });
    var fk = Array.from(rxP.freqs, function (f) { return f * kHz; });
    var series = [
      { type: 'line', x: fk, y: rxP.psdDb, label: s.noise ? 'received (with noise)' : 'received', lineWidth: 1.1 },
      { type: 'line', x: fk, y: txP.psdDb, label: 'transmitted', lineWidth: 1.1 }
    ];
    if (s.bessel && s.src === 'tone') {
      var bt = s.dev / s.f, K = Math.min(80, Math.ceil(bt + 6)), bx = [], by = [];
      for (var k = -K; k <= K; k++) {
        var p = Math.pow(SDR.mathx.besselJ(k, bt), 2);
        if (p > 1e-9) { bx.push((k * s.f + s.foff) * kHz); by.push(10 * Math.log10(p)); }
      }
      series.push({ type: 'scatter', x: bx, y: by, label: 'J_n(β)² (theory, β = ' + bt.toPrecision(3) + ')', radius: 3.5, color: SDR.plot.PALETTE[3] });
    }
    var half = Math.max(carsonBw, sim.bt, 2 * s.dev) / 2 * kHz;
    pSpec.setOptions({
      xLim: [-1.4 * half, 1.4 * half], yLim: [-85, 5],
      annotations: [
        { type: 'band', x0: -carsonBw / 2 * kHz, x1: carsonBw / 2 * kHz, label: 'Carson B_T = ' + fmtHz(carsonBw) },
        { type: 'vline', x: -s.dev * kHz, label: '−Δf' }, { type: 'vline', x: s.dev * kHz, label: '+Δf' },
        { type: 'vline', x: -sim.bt / 2 * kHz, label: 'IF', color: SDR.plot.PALETTE[2] }, { type: 'vline', x: sim.bt / 2 * kHz, label: 'IF', color: SDR.plot.PALETTE[2] }
      ]
    });
    pSpec.setData(series);

    // Time domain (audio rate)
    pTime.setData([
      { type: 'line', x: timeAxis(sim.mA.length, FSA, 0), y: sim.mA, label: 'message m(t)' },
      { type: 'line', x: timeAxis(r.y.length, FSA, r.delay), y: r.y, label: 'demodulated' }
    ]);

    // Instantaneous frequency (RF rate), with the ideal m(t)·Δf for reference
    var nR = r.inst.length, inst = new Float64Array(nR), ideal = new Float64Array(sim.tx.mR.length);
    for (i = 0; i < nR; i++) inst[i] = r.inst[i] * s.dev * kHz;
    for (i = 0; i < ideal.length; i++) ideal[i] = (sim.tx.mR[i] * s.dev + s.foff) * kHz;
    var span = (s.dev + Math.abs(s.foff)) * kHz * 1.6; // fixed home range: the start-up spike would otherwise set the scale
    pInst.setOptions({ yLim: [-span, span] });
    pInst.setData([
      { type: 'line', x: timeAxis(ideal.length, FSR, sim.tx.delay), y: ideal, label: 'ideal Δf·m(t) + offset', color: '#888888', lineWidth: 1 },
      { type: 'line', x: timeAxis(nR, FSR, sim.tx.delay + r.ifDelay), y: inst, label: s.demod === 'pll' ? 'PLL frequency' : 'discriminator', lineWidth: 1.2 }
    ]);

    // I/Q
    // After the IF filter, so only in-band noise shows (the raw input carries noise across all 384 kHz).
    // Golden-ratio sample positions: a fixed stride can alias with the message period and show clusters, not a ring.
    var n = r.ifOut.re.length, i0 = 2 * r.ifDelay, iq = { x: [], y: [] };
    for (var k = 0; k < 3000 && n > i0; k++) {
      var j = i0 + Math.floor(((k * 0.6180339887) % 1) * (n - i0));
      iq.x.push(r.ifOut.re[j]); iq.y.push(r.ifOut.im[j]);
    }
    pIq.setData([{ type: 'scatter', x: iq.x, y: iq.y, radius: 1.6, alpha: 0.6, label: 'IF output samples' }]);

    // Readouts
    var pm = meanSq(sim.mA), theory = s.noise ? 10 * Math.log10(SDR.fm.theorySnr({ pm: pm, deviation: s.dev, W: s.W, bt: sim.bt, cnr: Math.pow(10, s.cnr / 10) })) : NaN;
    var obw = SDR.dsp.occupiedBandwidth(sim.ch, FSR, { psd: txP });
    page.setReadouts({
      beta: SDR.fm.beta(s.dev, s.W).toPrecision(3),
      carson: fmtHz(carsonBw) + (s.ifMode === 'manual' ? ' (IF ' + fmtHz(sim.bt) + ')' : ''),
      obw: fmtHz(obw),
      cnr: s.noise ? fmtDb(s.cnr) : 'noise off',
      snr: fmtDb(r.snr.snrDb),
      theory: s.noise ? fmtDb(theory) + (sim.tau ? ' (no emph.)' : '') : '–',
      clicks: s.noise ? Math.round(clicksPerSec).toString() : '0'
    });
    page.setExplain(explain(s, r.snr.snrDb, theory, clicksPerSec, sim));
  }

  function explain(s, snr, theory, cps, sim) {
    var extra = s.foff ? ' Frequency offset ' + fmtHz(Math.abs(s.foff)) + ' appears as a DC shift of ' + (s.foff / s.dev).toFixed(2) + ' (in message units) before DC removal.' : '';
    var clipped = Math.abs(s.foff) + SDR.fm.carson(s.dev, s.W) / 2 > sim.bt / 2 + 1000;
    if (clipped) return 'The signal no longer fits the IF filter (offset or narrow IF bandwidth): its outer sidebands are cut, which distorts the output.' + extra;
    if (!s.noise) return 'Noise off: the output is limited only by filtering and distortion.' + extra;
    if (s.fadeOn && cps >= 1) return 'Mobile fading: the average CNR is ' + s.cnr + ' dB, but every deep fade drops it through the FM threshold, so clicks arrive in bursts (' +
      Math.round(cps) + '/s) and the output flutters. Press ▶ Play demodulated to hear it.' + extra;
    var deficit = theory - snr, state;
    if (!sim.tau) state = deficit < 1.5 ? 'above' : deficit < 5 ? 'near' : 'below';
    else state = cps < 2 ? 'above' : cps < 0.02 * s.W ? 'near' : 'below'; // theory excludes emphasis gain, so judge by clicks
    if (state !== 'above' && cps < 1) {
      return 'Output SNR is ' + deficit.toFixed(1) + ' dB below theory with no clicks, so this is distortion rather than threshold' +
        (s.demod === 'pll' ? ' (try a wider PLL loop bandwidth).' : '.') + extra;
    }
    var msg = state === 'above' ? 'Above threshold: output SNR follows theory' + (sim.tau ? ' plus the emphasis gain' : ' (within ' + Math.max(0, deficit).toFixed(1) + ' dB)') + '. FM is trading bandwidth for SNR.'
      : state === 'near' ? 'Near threshold: clicks starting (' + Math.round(cps) + '/s). Each click is the noise briefly overpowering the carrier and adding a 2π phase slip.'
      : 'Below threshold: clicks dominate (' + Math.round(cps) + '/s) and output SNR has collapsed' + (sim.tau ? '' : ' (' + deficit.toFixed(1) + ' dB below theory)') + '.';
    return msg + extra;
  }

  // ---------- SNR sweep ----------
  function parseBetas(str) {
    var b = String(str).split(/[\s,;]+/).map(parseFloat).filter(function (v) { return isFinite(v) && v >= 0.1 && v <= 20; }).slice(0, 4);
    return b.length ? b : [1, 2, 5];
  }

  function* sweepTask(s, plot) {
    var betas = parseBetas(s.betas), W = s.W, cnrs = [];
    for (var v = -5; v <= 30; v += 1) cnrs.push(v);
    var mA = page.message(s, Math.round(SWEEP_S * FSA), W), pm = meanSq(mA), rng = SDR.rng.createRng(s.seed);
    var meas = betas.map(function () { return { x: [], y: [] }; }), ann = [], gAll = [];
    var total = betas.length * cnrs.length, done = 0;
    betas.forEach(function (b, bi) {
      var bt = SDR.fm.carson(b * W, W);
      ann.push({ type: 'vline', x: 10 + 10 * Math.log10(bt / W), label: 'thr β=' + b, color: SDR.plot.PALETTE[bi] });
    });
    function redraw() {
      var series = [], lo = Infinity, hi = -Infinity;
      gAll.forEach(function (g) { lo = Math.min(lo, g); hi = Math.max(hi, g); });
      betas.forEach(function (b, bi) {
        var col = SDR.plot.PALETTE[bi], bt = SDR.fm.carson(b * W, W), off = 10 * Math.log10(3 * pm * b * b);
        var gx = cnrs.map(function (cn) { return cn + 10 * Math.log10(bt / W); });
        series.push({ type: 'line', x: gx, y: gx.map(function (g) { return g + off; }), color: col, dash: [6, 4], lineWidth: 1 });
        series.push({ type: 'line', x: meas[bi].x, y: meas[bi].y, color: col, label: 'β = ' + b + ' (dashed: theory)' });
      });
      if (lo <= hi) series.push({ type: 'line', x: [lo, hi], y: [lo, hi], color: '#888888', dash: [2, 3], label: 'AM coherent (DSB-SC) = γ' });
      plot.setOptions({ annotations: ann });
      plot.setData(series);
    }
    for (var bi = 0; bi < betas.length; bi++) {
      var sp = Object.assign({}, s, { dev: betas[bi] * W, ifMode: 'carson', foff: 0, phase: 0, noise: true });
      var bt = SDR.fm.carson(sp.dev, W);
      var tx = SDR.fm.transmit(mA, { fsA: FSA, fsR: FSR, deviation: sp.dev, tau: tauOf(sp) });
      yield done / total;
      for (var ci = 0; ci < cnrs.length; ci++) {
        sp.cnr = cnrs[ci];
        var sim = { mA: mA, tx: tx, ch: tx.x, bt: bt, tau: tauOf(sp) };
        sim.rx = SDR.channel.addAwgnCnr(tx.x, sp.cnr, bt, FSR, rng, { refPower: 1 });
        yield (done + 0.3) / total;
        var r = receive(sim, sp), g = sp.cnr + 10 * Math.log10(bt / W);
        meas[bi].x.push(g); meas[bi].y.push(r.snr.snrDb); gAll.push(g);
        done++;
        redraw();
        yield done / total;
      }
    }
  }

  page.start();
})();
