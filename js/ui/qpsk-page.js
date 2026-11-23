// QPSK page: controls → SDR.qpsk.runLink → constellations, eye, spectrum, loop traces, correlation,
// error map, readouts; Live mode and a quick BER check (both via SDR.ui.runChunked).
(function () {
  'use strict';
  var ui = SDR.ui, DEG = Math.PI / 180, PAL = SDR.plot.PALETTE;
  var DEFAULTS = { ebn0: 10, sps: 8, rolloff: 0.35, span: 10, nbits: 4000, diff: false, input: 'random', text: 'Hello from Buffalo!',
    noise: true, phase: 30, cfo: 0.01, timing: 0.3, drift: 0,
    cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real', tBnT: 0.01, cBnT: 0.02, zeta: 0.707, seed: 1 };

  var page = SDR.page.create({
    defaults: DEFAULTS, run: run, sync: sync, audio: false,
    readouts: [['ber', 'BER (errors / bits)'], ['theory', 'Theory BER'], ['evm', 'EVM'], ['esn0', 'Es/N0 from EVM / true'],
      ['cfo', 'CFO est / true (Rs)'], ['phase', 'Phase est / true'], ['timing', 'Timing est / true (sym)'], ['lock', 'Lock (timing, carrier)'], ['conv', 'Convergence (symbols)']]
  });
  var lv = page.live, commit = page.commit;
  function slider(o) { o.onInput = lv.input; o.onChange = lv.commit; return ui.slider(o); }
  function mode(key, label, title, withOff) {
    var opts = [{ value: 'real', label: 'Real (estimate)' }, { value: 'ideal', label: 'Ideal (genie)' }];
    if (withOff) opts.push({ value: 'off', label: 'Off (no correction)' });
    return ui.select({ key: key, label: label, value: DEFAULTS[key], options: opts, onChange: commit, title: title });
  }

  var c = {
    ebn0: slider({ key: 'ebn0', label: 'Eb/N0', min: -2, max: 20, step: 0.5, unit: 'dB', value: DEFAULTS.ebn0, title: 'Energy per bit over noise density. Es/N0 = Eb/N0 + 3.01 dB for QPSK.' }),
    sps: slider({ key: 'sps', label: 'Samples / symbol', min: 2, max: 16, step: 1, value: DEFAULTS.sps, title: 'Oversampling of the RRC-shaped signal' }),
    rolloff: slider({ key: 'rolloff', label: 'RRC roll-off β', min: 0.1, max: 1, step: 0.05, value: DEFAULTS.rolloff, title: 'Excess bandwidth: occupied band is (1 + β)·Rs' }),
    span: slider({ key: 'span', label: 'Filter span', min: 4, max: 16, step: 1, unit: 'sym', value: DEFAULTS.span, title: 'RRC length in symbols; short spans leave residual ISI' }),
    nbits: slider({ key: 'nbits', label: 'Payload', min: 200, max: 100000, log: true, unit: 'bits', value: DEFAULTS.nbits, title: 'Random payload length per frame' }),
    diff: ui.toggle({ key: 'diff', label: 'Differential encoding', checked: DEFAULTS.diff, onChange: commit,
      title: 'Encode bits as phase changes: immune to the 4-fold carrier ambiguity, at ~2× the BER' }),
    input: ui.select({ key: 'input', label: 'Payload', value: DEFAULTS.input, onChange: commit, title: 'Random bits or your own text (UTF-8)',
      options: [{ value: 'random', label: 'Random bits' }, { value: 'text', label: 'Text' }] }),
    text: ui.text({ key: 'text', label: 'Text', value: DEFAULTS.text, onChange: commit, title: 'Sent as UTF-8; wrong characters are highlighted after decoding' }),
    noise: ui.toggle({ key: 'noise', label: 'Add noise (AWGN)', checked: DEFAULTS.noise, onChange: commit, title: 'Complex AWGN at the chosen Eb/N0' }),
    phase: slider({ key: 'phase', label: 'Phase offset', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.phase, title: 'Static carrier phase rotation' }),
    cfo: slider({ key: 'cfo', label: 'Carrier frequency offset', min: -0.1, max: 0.1, step: 0.001, unit: 'Rs', value: DEFAULTS.cfo, title: 'Frequency offset as a fraction of the symbol rate' }),
    timing: slider({ key: 'timing', label: 'Timing offset', min: 0, max: 1, step: 0.01, unit: 'sym', value: DEFAULTS.timing, title: 'Fractional delay of the received signal, in symbols' }),
    drift: slider({ key: 'drift', label: 'Clock drift', min: -200, max: 200, step: 1, unit: 'ppm', value: DEFAULTS.drift, title: 'Receiver sample clock offset: the timing error keeps growing' }),
    cfoMode: mode('cfoMode', 'Coarse CFO', 'Real: 4th-power FFT estimate. Ideal: uses the true offset.'),
    timingMode: mode('timingMode', 'Timing recovery', 'Real: Gardner loop + cubic Farrow interpolator. Ideal: samples at the true instants.'),
    carrierMode: mode('carrierMode', 'Carrier recovery', 'Real: decision-directed PLL. Ideal: true phase. Off: no correction.', true),
    frameMode: mode('frameMode', 'Frame sync', 'Real: correlate with the preamble (also resolves the 90° ambiguity). Ideal: true start.'),
    tBnT: slider({ key: 'tBnT', label: 'Timing loop BnT', min: 0.0005, max: 0.1, log: true, value: DEFAULTS.tBnT, title: 'Normalized noise bandwidth: wider tracks faster but jitters more' }),
    cBnT: slider({ key: 'cBnT', label: 'Carrier loop BnT', min: 0.0005, max: 0.2, log: true, value: DEFAULTS.cBnT, title: 'Normalized noise bandwidth of the carrier PLL' }),
    zeta: slider({ key: 'zeta', label: 'Damping ζ', min: 0.3, max: 2, step: 0.01, value: DEFAULTS.zeta, title: 'Loop damping factor (0.707 is the classic choice)' })
  };

  var PRESETS = {
    'Ideal link': { phase: 0, cfo: 0, timing: 0, drift: 0, cfoMode: 'ideal', timingMode: 'ideal', carrierMode: 'ideal', frameMode: 'ideal' },
    'Phase offset only': { phase: 60, cfo: 0, timing: 0, drift: 0 },
    'CFO + timing': { phase: 0, cfo: 0.02, timing: 0.4, drift: 0 },
    'Everything on': { phase: 30, cfo: 0.03, timing: 0.6, drift: 100 },
    'Loop too wide': { phase: 30, cfo: 0.03, timing: 0.6, drift: 100, tBnT: 0.1, cBnT: 0.15 },
    'Loop too narrow': { phase: 30, cfo: 0.03, timing: 0.6, drift: 200, tBnT: 0.0005, cBnT: 0.0005 }
  };
  var presetRow = document.createElement('div');
  presetRow.className = 'btn-row';
  Object.keys(PRESETS).forEach(function (name) {
    presetRow.appendChild(ui.button({ label: name, title: 'Load the "' + name + '" setup', onClick: function () {
      var p = Object.assign({ cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real', tBnT: DEFAULTS.tBnT, cBnT: DEFAULTS.cBnT, zeta: DEFAULTS.zeta }, PRESETS[name]);
      Object.keys(p).forEach(function (k) { c[k].set(p[k], true); });
      commit();
    } }).el);
  });

  page.group('Presets', [presetRow]);
  page.group('Signal', [c.ebn0, c.sps, c.rolloff, c.span, c.nbits, c.diff]);
  page.group('Input', [c.input, c.text]);
  page.group('Channel', [c.noise, c.phase, c.cfo, c.timing, c.drift, page.seedControl()]);
  page.group('Receiver', [c.cfoMode, c.timingMode, c.carrierMode, c.frameMode, c.tBnT, c.cBnT, c.zeta]);

  function sync(s) {
    c.nbits.setDisabled(s.input === 'text');
    c.text.el.hidden = s.input !== 'text';
    c.ebn0.setDisabled(!s.noise);
    c.tBnT.setDisabled(s.timingMode !== 'real');
    c.cBnT.setDisabled(s.carrierMode !== 'real');
    textCard.hidden = s.input !== 'text';
  }

  // ---------- plot column ----------
  // Text in/out (text mode only)
  var textOut = document.createElement('div');
  var textCard = page.addCard(textOut);

  // Live + quick BER check
  var actions = document.createElement('div');
  var actRow = document.createElement('div');
  actRow.className = 'btn-row';
  var liveBtn = ui.button({ label: '▶ Live', cls: 'primary', title: 'Transmit new frames continuously (constellation persists and fades)', onClick: toggleLive });
  var berBtn = ui.button({ label: 'Quick BER check', title: 'Run frames at the current settings until ≥ 100 errors or 10⁶ bits', onClick: toggleBer });
  var actProg = document.createElement('progress');
  actProg.max = 1; actProg.hidden = true;
  actRow.appendChild(liveBtn.el); actRow.appendChild(berBtn.el); actRow.appendChild(actProg);
  var berOut = document.createElement('p');
  berOut.className = 'ber-result';
  actions.appendChild(actRow); actions.appendChild(berOut);
  page.addCard(actions);

  var C = { equalAspect: true, xLim: [-1.6, 1.6], yLim: [-1.6, 1.6], legend: false, height: 230 };
  var pCon = page.addPlotGrid([
    Object.assign({ title: '1. After matched filter (all samples)' }, C),
    Object.assign({ title: '2. After coarse CFO correction' }, C),
    Object.assign({ title: '3. After timing recovery (1/symbol)' }, C),
    Object.assign({ title: '4. After carrier PLL' }, C),
    Object.assign({ title: '5. Payload after ambiguity fix' }, C),
    Object.assign({ title: '6. Decisions (red = bit errors)' }, C)
  ], 3, 'Constellation at each receiver stage. Colour runs from early (blue) to late (yellow), so convergence shows as a spiral settling down.');
  var pEye = page.addPlotGrid([
    { title: 'Eye diagram: I', xLabel: 'time (symbols)', xLim: [-1, 1], yLim: [-1.8, 1.8], legend: false, height: 240 },
    { title: 'Eye diagram: Q', xLabel: 'time (symbols)', xLim: [-1, 1], yLim: [-1.8, 1.8], legend: false, height: 240 }
  ], 2);
  var pSpec = page.addPlot({ title: 'Received spectrum (Welch)', xLabel: 'frequency (× Rs)', yLabel: 'power per bin (dB)', xUnit: 'Rs', yUnit: 'dB', height: 260 });
  var pLoop = page.addPlotGrid([
    { title: 'Timing error (Gardner)', xLabel: 'symbol', legend: false, height: 220 },
    { title: 'Timing estimate (symbols)', xLabel: 'symbol', height: 220 },
    { title: 'Carrier phase (°)', xLabel: 'symbol', height: 220 },
    { title: 'Carrier frequency (× Rs)', xLabel: 'symbol', height: 220 }
  ], 2, 'Loop traces (dashed = true value, dotted line = convergence)');
  var pCorr = page.addPlot({ title: 'Preamble correlation |c| / 64', xLabel: 'symbol index', height: 220, legend: false });
  var pErr = page.addPlot({ title: 'Error map (bit positions)', xLabel: 'bit index', yLim: [-1, 1], height: 120, legend: false });

  // ---------- simulation ----------
  function cfgFrom(s) {
    return {
      nBits: Math.round(s.nbits), bits: s.input === 'text' ? SDR.qpsk.textToBits(s.text || ' ') : null, diff: s.diff,
      sps: Math.round(s.sps), rolloff: s.rolloff, span: Math.round(s.span), ebn0Db: s.ebn0, noise: s.noise,
      channel: { phaseDeg: s.phase, cfoRs: s.cfo, timingSym: s.timing, driftPpm: s.drift },
      rx: { cfo: s.cfoMode, timing: s.timingMode, carrier: s.carrierMode, frame: s.frameMode, timingBnT: s.tBnT, carrierBnT: s.cBnT, zeta: s.zeta }
    };
  }

  function run(s, full) {
    var cfg = cfgFrom(s);
    if (!full && !cfg.bits) cfg.nBits = Math.min(cfg.nBits, 1000); // lighter preview while dragging
    var r = SDR.qpsk.runLink(cfg, SDR.rng.createRng(s.seed));
    draw(s, r, null);
  }

  // Colour-by-time: split points into buckets along a blue → yellow ramp.
  function timeSeries(xs, ys, idx, radius) {
    var NB = 6, out = [], per = Math.ceil(idx.length / NB);
    for (var b = 0; b < NB; b++) {
      var sx = [], sy = [];
      for (var i = b * per; i < Math.min(idx.length, (b + 1) * per); i++) { sx.push(xs[idx[i]]); sy.push(ys[idx[i]]); }
      out.push({ type: 'scatter', x: sx, y: sy, radius: radius || 1.6, alpha: 0.75, color: 'hsl(' + Math.round(220 - (180 * b) / (NB - 1)) + ', 80%, 55%)' });
    }
    return out;
  }
  function spread(n, max, from) {  // up to max indices across [from, n), evenly spaced
    var idx = [], f = from || 0, step = Math.max(1, (n - f) / max);
    for (var x = f; x < n; x += step) idx.push(Math.floor(x));
    return idx;
  }
  function wrap(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
  function seq(n) { var a = new Float64Array(n); for (var i = 0; i < n; i++) a[i] = i; return a; }

  var history = []; // live-mode persistence: last few frames' decisions-stage points

  function draw(s, r, live) {
    var t = r.traces, sps = r.cfg.sps, D = SDR.filters.rrcTaps(r.cfg.rolloff, sps, r.cfg.span).groupDelay, i;
    var decisionAnn = [{ type: 'vline', x: 0 }, { type: 'hline', y: 0 }];
    var ideal = { type: 'scatter', x: [Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2], y: [Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2], radius: 4.5, color: '#888888' };

    // 1–5 constellations
    var nS = t.mf.re.length;
    pCon[0].setData(timeSeries(t.mf.re, t.mf.im, spread(nS - 2 * D, 3000, 2 * D)));
    pCon[1].setData(timeSeries(t.cfoCorrected.re, t.cfoCorrected.im, spread(nS - 2 * D, 3000, 2 * D)));
    pCon[2].setData(timeSeries(t.strobes.re, t.strobes.im, spread(t.strobes.re.length, 3000)));
    pCon[3].setData(timeSeries(t.carrier.re, t.carrier.im, spread(t.carrier.re.length, 3000)));
    pCon[4].setOptions({ annotations: decisionAnn });
    pCon[4].setData(timeSeries(t.payload.re, t.payload.im, spread(t.payload.re.length, 3000)).concat([ideal]));

    // 6 decisions: correct vs wrong symbols (+ fading history in live mode)
    var errSym = new Set();
    t.errorPositions.forEach(function (b) { errSym.add(b >> 1); });
    var ok = { x: [], y: [] }, bad = { x: [], y: [] }, idxs = spread(t.payload.re.length, 3000);
    idxs.forEach(function (k) { var o = errSym.has(k) ? bad : ok; o.x.push(t.payload.re[k]); o.y.push(t.payload.im[k]); });
    var series = [];
    if (live) {
      history.unshift(ok); if (history.length > 6) history.pop();
      for (i = history.length - 1; i >= 1; i--) series.push({ type: 'scatter', x: history[i].x, y: history[i].y, radius: 1.6, alpha: 0.5 * Math.pow(0.6, i), color: PAL[2] });
    }
    series.push({ type: 'scatter', x: ok.x, y: ok.y, radius: 1.6, alpha: 0.75, color: PAL[2] });
    series.push({ type: 'scatter', x: bad.x, y: bad.y, radius: 2.6, color: PAL[3] });
    series.push(ideal);
    pCon[5].setOptions({ annotations: decisionAnn });
    pCon[5].setData(series);
    if (live) { updateReadouts(s, r); return; } // live mode: constellation + readouts only, to keep frames fast

    // Eye diagrams: carrier-corrected samples on the nominal symbol grid, 2 symbols wide
    var cc = t.cfoCorrected, th = t.phaseEst, nT = Math.floor(3800 / (2 * sps + 2)), eI = { x: [], y: [] }, eQ = { x: [], y: [] };
    var k0 = Math.min(200, Math.floor(t.strobes.re.length / 4));
    for (var k = k0; k < k0 + nT; k++) {
      var c0 = k * sps + 2 * D;
      if (c0 + sps >= nS || k >= th.length) break;
      var ct = Math.cos(th[k]), st = Math.sin(th[k]);
      for (var j = -sps; j <= sps; j++) {
        var a = cc.re[c0 + j], b = cc.im[c0 + j];
        eI.x.push(j / sps); eI.y.push(a * ct + b * st);
        eQ.x.push(j / sps); eQ.y.push(b * ct - a * st);
      }
      eI.x.push(NaN); eI.y.push(NaN); eQ.x.push(NaN); eQ.y.push(NaN);
    }
    var tau = t.muEst.length ? t.muEst[t.muEst.length - 1] : 0, tw = tau - Math.round(tau);
    var eyeAnn = [{ type: 'vline', x: tw, label: 'strobe' }, { type: 'vline', x: tw - 1 }, { type: 'vline', x: tw + 1 }];
    pEye[0].setOptions({ annotations: eyeAnn }); pEye[1].setOptions({ annotations: eyeAnn });
    pEye[0].setData([{ type: 'line', x: eI.x, y: eI.y, lineWidth: 1, alpha: 0.3, color: PAL[0] }]);
    pEye[1].setData([{ type: 'line', x: eQ.x, y: eQ.y, lineWidth: 1, alpha: 0.3, color: PAL[1] }]);

    // Spectrum (fs = sps → frequency axis in units of Rs)
    var nfft = Math.min(1024, SDR.mathx.nextPow2(Math.max(64, t.rx.re.length >> 3)));
    var pr = SDR.dsp.welchPSD(t.rx, sps, { nfft: nfft }), pt = SDR.dsp.welchPSD(t.tx, sps, { nfft: nfft }), bw = (1 + r.cfg.rolloff) / 2;
    pSpec.setOptions({ xLim: [-Math.min(sps / 2, 2), Math.min(sps / 2, 2)], annotations: [
      { type: 'band', x0: -bw, x1: bw, label: '(1 + β)·Rs = ' + (2 * bw).toFixed(2) + ' Rs' },
      { type: 'vline', x: -0.5, label: '−Rs/2' }, { type: 'vline', x: 0.5, label: '+Rs/2' }] });
    pSpec.setData([
      { type: 'line', x: pr.freqs, y: pr.psdDb, label: 'received', lineWidth: 1.1 },
      { type: 'line', x: pt.freqs, y: pt.psdDb, label: 'transmitted', lineWidth: 1.1 }
    ]);

    // Loop traces
    var K = t.timingErr.length, xs = seq(K), lk = r.lock;
    pLoop[0].setOptions({ annotations: lk.timing.convergence ? [{ type: 'vline', x: lk.timing.convergence, dash: [2, 3] }] : [] });
    pLoop[0].setData([{ type: 'line', x: xs, y: t.timingErr, lineWidth: 1, color: PAL[0] }]);
    var shift = K ? Math.round(t.muEst[K - 1] - t.muTrue[K - 1]) : 0, muT = new Float64Array(K);
    for (i = 0; i < K; i++) muT[i] = t.muTrue[i] + shift;
    pLoop[1].setOptions({ annotations: [{ type: 'vline', x: lk.timing.convergence }] });
    pLoop[1].setData([{ type: 'line', x: xs, y: t.muEst, label: 'estimate', lineWidth: 1.4 }, { type: 'line', x: xs, y: muT, label: 'true', dash: [6, 4], color: '#888888', lineWidth: 1.2 }]);
    var q = K ? Math.round(wrap(t.phaseEst[K - 1] - t.phaseTrue[K - 1]) / (Math.PI / 2)) * (Math.PI / 2) : 0, pe = new Float64Array(K), ptr = new Float64Array(K);
    for (i = 0; i < K; i++) { pe[i] = t.phaseEst[i] / DEG; ptr[i] = wrap(t.phaseTrue[i] + q) / DEG; }
    pLoop[2].setOptions({ yLim: [-180, 180], annotations: [{ type: 'vline', x: lk.carrier.convergence }] });
    pLoop[2].setData([{ type: 'line', x: xs, y: pe, label: 'estimate', lineWidth: 1.4 }, { type: 'line', x: xs, y: ptr, label: 'true (mod 90°)', dash: [6, 4], color: '#888888', lineWidth: 1.2 }]);
    var fe = new Float64Array(K), ft = new Float64Array(K);
    for (i = 0; i < K; i++) { fe[i] = t.freqEst[i] / (2 * Math.PI); ft[i] = t.freqTrueRs; }
    pLoop[3].setData(r.cfg.rx.carrier === 'real'
      ? [{ type: 'line', x: xs, y: fe, label: 'PLL residual', lineWidth: 1.4 }, { type: 'line', x: xs, y: ft, label: 'true residual', dash: [6, 4], color: '#888888', lineWidth: 1.2 }]
      : []);

    // Preamble correlation
    pCorr.setOptions({ annotations: [{ type: 'vline', x: r.frameStart, label: 'frame start ' + r.frameStart }] });
    pCorr.setData([{ type: 'line', x: seq(t.corr.length), y: t.corr, lineWidth: 1, color: PAL[4] },
      { type: 'scatter', x: [r.frameStart], y: [t.corr[r.frameStart] || 0], radius: 5, color: PAL[3] }]);

    // Error map
    var nb = r.bitsTx.length;
    pErr.setOptions({ xLim: [0, nb], annotations: t.errorPositions.length ? [] : [{ type: 'text', x: nb / 2, y: 0, text: 'no bit errors' }] });
    pErr.setData([{ type: 'scatter', x: t.errorPositions, y: t.errorPositions.map(function () { return 0; }), radius: 2.5, color: PAL[3] }]);

    updateReadouts(s, r);
    renderText(s, r);
  }

  function fmtPct(v) { return (100 * v).toFixed(v < 0.01 ? 2 : 1) + ' %'; }

  function theoryFor(s) { return s.diff ? SDR.theory.dqpskAwgn(s.ebn0) : SDR.theory.qpskAwgn(s.ebn0); }

  function updateReadouts(s, r) {
    var th = s.noise ? theoryFor(s) : 0, lk = r.lock, n = r.bitsTx.length;
    var trueEs = SDR.channel.esn0Db(s.ebn0, 2);
    function wrap1(v) { return v - Math.floor(v); }
    page.setReadouts({
      ber: r.errors + ' / ' + n + ' = ' + (r.ber ? r.ber.toExponential(2) : '0'),
      theory: s.noise ? th.toExponential(2) + (s.diff ? ' (DE-QPSK)' : '') : '0 (no noise)',
      evm: isFinite(r.evm) ? fmtPct(r.evm) + ' (' + r.evmDb.toFixed(1) + ' dB)' : '–',
      esn0: (isFinite(r.esn0EstDb) ? r.esn0EstDb.toFixed(1) : '–') + ' / ' + (s.noise ? trueEs.toFixed(1) : '∞') + ' dB',
      cfo: r.est.cfoRs.toFixed(4) + ' / ' + r.truth.cfoRs.toFixed(4),
      phase: (r.est.phase / DEG).toFixed(1) + '° / ' + (r.truth.phase / DEG).toFixed(1) + '°',
      timing: wrap1(r.est.timingSym).toFixed(3) + ' / ' + wrap1(r.truth.timingSym).toFixed(3),
      lock: (lk.timing.locked ? '✓' : '✗') + ' timing, ' + (lk.carrier.locked ? '✓' : '✗') + ' carrier',
      conv: (s.timingMode === 'real' ? lk.timing.convergence : '–') + ', ' + (s.carrierMode === 'real' ? lk.carrier.convergence : '–')
    });
    page.setExplain(status(s, r, th));
  }

  function status(s, r, th) {
    var lk = r.lock, n = r.bitsTx.length;
    if (r.corrPeak < 0.5) return 'Frame sync failed: the preamble was not found (correlation peak ' + r.corrPeak.toFixed(2) + '). Check the loops above.';
    if (s.timingMode === 'real' && !lk.timing.locked) return 'Timing loop not locked: ' + (s.tBnT > 0.03 ? 'BnT is too wide (jitter or slips), try narrower.' : 'try a wider timing BnT or less clock drift.');
    if (s.carrierMode === 'real' && !lk.carrier.locked) return 'Carrier loop not locked: ' + (s.cBnT > 0.05 ? 'BnT is too wide (too noisy), try narrower.' : 'try a wider carrier BnT.');
    var late = Math.max(s.timingMode === 'real' ? lk.timing.convergence : 0, s.carrierMode === 'real' ? lk.carrier.convergence : 0);
    if (late > r.cfg.leadSymbols && r.errors) return 'Loops converged late (symbol ' + late + ', after the ' + r.cfg.leadSymbols + '-symbol lead-in), so the start of the payload is lost. Try a wider BnT.';
    if (s.carrierMode === 'off' && Math.abs(s.phase) > 0.5) return 'Carrier recovery off: the constellation stays rotated by the channel phase, and BER follows the static-phase-error curve.';
    if (!s.noise) return r.errors ? r.errors + ' errors without noise: residual offsets or ISI are breaking decisions.' : 'No noise: locked and error-free.';
    var ci = SDR.theory.wilsonInterval(r.errors, n);
    if (th >= ci[0] && th <= ci[1]) return 'Locked, BER matches theory (theory inside the 95% interval of this frame).';
    if (r.ber > th) return 'Locked, but BER is ' + (r.ber / th).toFixed(1) + '× theory: implementation loss from loop jitter or residual offsets (or sync lost at this low SNR).';
    return 'Locked; BER below theory in this frame (few bits: use "Quick BER check" for a tighter estimate).';
  }

  function renderText(s, r) {
    if (s.input !== 'text') return;
    var txt = s.text || ' ', rxBytes = SDR.qpsk.bitsToBytes(r.bitsRx), enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: false });
    textOut.textContent = '';
    var lab1 = document.createElement('div'); lab1.className = 'text-io-label'; lab1.textContent = 'Sent';
    var sent = document.createElement('p'); sent.className = 'text-io'; sent.textContent = txt;
    var lab2 = document.createElement('div'); lab2.className = 'text-io-label'; lab2.textContent = 'Received (wrong characters in red)';
    var got = document.createElement('p'); got.className = 'text-io';
    var pos = 0, wrong = 0;
    Array.from(txt).forEach(function (ch) {
      var b = enc.encode(ch), slice = rxBytes.subarray(pos, pos + b.length), same = slice.length === b.length;
      for (var i = 0; same && i < b.length; i++) if (slice[i] !== b[i]) same = false;
      var span = document.createElement('span');
      span.textContent = same ? ch : (dec.decode(slice) || '�');
      if (!same) { span.className = 'bad'; wrong++; }
      got.appendChild(span);
      pos += b.length;
    });
    var lab3 = document.createElement('div'); lab3.className = 'text-io-label';
    lab3.textContent = wrong ? wrong + ' of ' + Array.from(txt).length + ' characters wrong' : 'All characters correct';
    [lab1, sent, lab2, got, lab3].forEach(function (e) { textOut.appendChild(e); });
  }

  // ---------- Live mode and quick BER check (runChunked) ----------
  var ac = null, task = null;
  function stopTask() { if (ac) ac.abort(); }
  function setBusy(which) {
    task = which;
    liveBtn.el.textContent = which === 'live' ? '■ Stop live' : '▶ Live';
    berBtn.el.textContent = which === 'ber' ? '■ Stop' : 'Quick BER check';
    liveBtn.setDisabled(which === 'ber'); berBtn.setDisabled(which === 'live');
    actProg.hidden = which !== 'ber';
  }

  function toggleLive() {
    if (task) return stopTask();
    var s = page.state(), cfg = cfgFrom(s), rng = SDR.rng.createRng(s.seed), frames = 0, t0 = performance.now();
    if (!cfg.bits) cfg.nBits = Math.min(cfg.nBits, 2000);
    history = [];
    ac = new AbortController(); setBusy('live');
    ui.runChunked(function* () {
      for (;;) {
        var r = SDR.qpsk.runLink(cfg, rng);
        draw(s, r, true);
        frames++;
        page.status.set('Live: frame ' + frames + ' (' + (frames / ((performance.now() - t0) / 1000)).toFixed(1) + ' frames/s)');
        yield frames;
      }
    }, { signal: ac.signal, budgetMs: 1 }).then(function () {
      ac = null; setBusy(null); history = [];
      page.status.set('Live stopped after ' + frames + ' frames', 'ok');
      commit();
    });
  }

  function toggleBer() {
    if (task) return stopTask();
    var s = page.state(), cfg = cfgFrom(s), rng = SDR.rng.createRng(s.seed + 1000), errs = 0, bits = 0, t0 = performance.now();
    cfg.bits = null; cfg.nBits = 5000;    // random payload; one frame is one runChunked unit, so keep it ~40 ms
    var MAX = 1e6, MIN_ERR = 100;
    ac = new AbortController(); setBusy('ber'); actProg.value = 0;
    berOut.textContent = 'Running…';
    ui.runChunked(function* () {
      while (errs < MIN_ERR && bits < MAX) {
        var r = SDR.qpsk.runLink(cfg, rng);
        errs += r.errors; bits += r.bitsTx.length;
        yield Math.max(errs / MIN_ERR, bits / MAX);
      }
    }, { signal: ac.signal, onProgress: function (p) { actProg.value = Math.min(1, p); } }).then(function (res) {
      ac = null; setBusy(null);
      var ci = SDR.theory.wilsonInterval(errs, bits), th = s.noise ? theoryFor(s) : 0, inside = th >= ci[0] && th <= ci[1];
      berOut.textContent = (res.aborted ? 'Stopped. ' : '') + 'Measured BER ' + (errs / bits).toExponential(3) + ' (' + errs + ' errors / ' + bits.toLocaleString() + ' bits), ' +
        '95% Wilson interval [' + ci[0].toExponential(2) + ', ' + ci[1].toExponential(2) + ']. Theory ' + th.toExponential(3) +
        (inside ? ' is inside the interval.' : ' is outside the interval' + (errs / bits > th ? ' (implementation loss).' : '.')) +
        ' (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)';
      page.status.set('BER check done', 'ok');
    });
  }

  page.start();
})();
