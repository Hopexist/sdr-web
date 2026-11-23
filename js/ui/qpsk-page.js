// QPSK page: controls → SDR.qpsk link (streaming) → per-stage constellations, eye, spectrum, loop traces,
// fading / equalizer / ADC views, correlation, error map, readouts; Live mode and a quick BER check, both
// stepping the streaming link through SDR.ui.runChunked so no slice blocks the page for long.
(function () {
  'use strict';
  var ui = SDR.ui, DEG = Math.PI / 180, PAL = SDR.plot.PALETTE, UI_BLOCK = 96;   // symbols per streaming step in Live / BER
  var DEFAULTS = { ebn0: 10, sps: 8, rolloff: 0.35, spanAuto: true, span: 16, nbits: 4000, diff: false, input: 'random', text: 'Hello from Buffalo!',
    noise: true, phase: 30, cfo: 0.01, timing: 0.3, drift: 0,
    fadeOn: false, fadeModel: 'rayleigh', fadeMode: 'jakes', fadeBlock: 64, fdTs: 0.001, kDb: 10,
    mpOn: false, mpPreset: 'mild', mpSpacing: 1, mpRms: 1, mpFade: false,
    pnOn: false, pnLw: 0.0001, iqOn: false, iqEps: 1, iqPhi: 5, iqCorrect: true,
    dcOn: false, dcRel: 0.3, dcAng: 30, dcBlockOn: true, dcPole: 0.999, adcOn: false, adcBits: 8, adcBackoff: 10,
    cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real', pilotEvery: 8,
    eq: 'off', eqTaps: 11, eqMain: 3, eqMu: 0.02, eqFrac: false, tBnT: 0.01, cBnT: 0.02, zeta: 0.707, seed: 1 };

  var page = SDR.page.create({
    defaults: DEFAULTS, run: run, sync: sync, audio: false,
    readouts: [['ber', 'BER (errors / bits)'], ['theory', 'Theory BER'], ['evm', 'EVM'], ['esn0', 'Es/N0 from EVM / true'],
      ['cfo', 'CFO est / true (Rs)'], ['phase', 'Phase est / true'], ['timing', 'Timing est / true (sym)'], ['lock', 'Lock (timing, carrier)'],
      ['conv', 'Convergence (symbols)'], ['fade', 'Fading: min |h| / time < −10 dB'], ['eqr', 'Equalizer MSE / convergence'],
      ['iqr', 'IRR before → after'], ['adcr', 'ADC SQNR / clip rate'], ['pil', 'Pilot overhead / frame efficiency']]
  });
  var lv = page.live, commit = page.commit;
  function slider(o) { o.onInput = lv.input; o.onChange = lv.commit; return ui.slider(o); }
  function sel(key, label, options, title) { return ui.select({ key: key, label: label, value: DEFAULTS[key], options: options, onChange: commit, title: title }); }
  function tog(key, label, title) { return ui.toggle({ key: key, label: label, checked: DEFAULTS[key], onChange: commit, title: title }); }
  function mode(key, label, title, extra) {
    return sel(key, label, [{ value: 'real', label: 'Real (estimate)' }, { value: 'ideal', label: 'Ideal (genie)' }].concat(extra || []), title);
  }

  var c = {
    ebn0: slider({ key: 'ebn0', label: 'Eb/N0', min: -2, max: 30, step: 0.5, unit: 'dB', value: DEFAULTS.ebn0, title: 'Energy per bit over noise density. Es/N0 = Eb/N0 + 3.01 dB for QPSK.' }),
    sps: slider({ key: 'sps', label: 'Samples / symbol', min: 2, max: 16, step: 1, value: DEFAULTS.sps, title: 'Oversampling of the RRC-shaped signal' }),
    rolloff: slider({ key: 'rolloff', label: 'RRC roll-off β', min: 0.1, max: 1, step: 0.05, value: DEFAULTS.rolloff, title: 'Excess bandwidth: occupied band is (1 + β)·Rs' }),
    spanAuto: tog('spanAuto', 'Automatic filter span', 'Span ≥ 12 symbols, 16–20 for small roll-off (truncation ISI below −45 dB)'),
    span: slider({ key: 'span', label: 'Filter span', min: 4, max: 24, step: 1, unit: 'sym', value: DEFAULTS.span, title: 'RRC length in symbols; short spans leave residual ISI' }),
    nbits: slider({ key: 'nbits', label: 'Payload', min: 200, max: 100000, log: true, unit: 'bits', value: DEFAULTS.nbits, title: 'Random payload length per frame' }),
    diff: tog('diff', 'Differential encoding', 'Encode bits as phase changes: immune to the 4-fold carrier ambiguity, at ~2× the BER'),
    input: sel('input', 'Payload', [{ value: 'random', label: 'Random bits' }, { value: 'text', label: 'Text' }], 'Random bits or your own text (UTF-8)'),
    text: ui.text({ key: 'text', label: 'Text', value: DEFAULTS.text, onChange: commit, title: 'Sent as UTF-8; wrong characters are highlighted after decoding' }),
    noise: tog('noise', 'Add noise (AWGN)', 'Complex AWGN at the chosen Eb/N0'),
    phase: slider({ key: 'phase', label: 'Phase offset', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.phase, title: 'Static carrier phase rotation' }),
    cfo: slider({ key: 'cfo', label: 'Carrier frequency offset', min: -0.1, max: 0.1, step: 0.001, unit: 'Rs', value: DEFAULTS.cfo, title: 'Frequency offset as a fraction of the symbol rate' }),
    timing: slider({ key: 'timing', label: 'Timing offset', min: 0, max: 1, step: 0.01, unit: 'sym', value: DEFAULTS.timing, title: 'Fractional delay of the received signal, in symbols' }),
    drift: slider({ key: 'drift', label: 'Clock drift', min: -200, max: 200, step: 1, unit: 'ppm', value: DEFAULTS.drift, title: 'Receiver sample clock offset: the timing error keeps growing' }),
    // fading
    fadeOn: tog('fadeOn', 'on', 'Flat fading: the whole signal is multiplied by a random complex gain h(t)'),
    fadeModel: sel('fadeModel', 'Model', [{ value: 'rayleigh', label: 'Rayleigh' }, { value: 'rician', label: 'Rician' }], 'Rayleigh: scatter only. Rician: line of sight plus scatter.'),
    fadeMode: sel('fadeMode', 'Time behaviour', [{ value: 'jakes', label: 'Time-varying (Jakes)' }, { value: 'block', label: 'Block (constant per block)' }], 'Jakes: smooth Doppler fading. Block: a new independent gain every N symbols.'),
    fadeBlock: slider({ key: 'fadeBlock', label: 'Block length (0 = one per frame)', min: 0, max: 4096, step: 1, unit: 'sym', value: DEFAULTS.fadeBlock, title: 'Symbols per independent fade in block mode' }),
    fdTs: slider({ key: 'fdTs', label: 'Doppler fd·Ts', min: 0.00001, max: 0.01, log: true, value: DEFAULTS.fdTs, title: 'Normalized Doppler; coherence time ≈ 0.4/(fd·Ts) symbols' }),
    kDb: slider({ key: 'kDb', label: 'Rician K', min: 0, max: 20, step: 0.5, unit: 'dB', value: DEFAULTS.kDb, title: 'Line-of-sight over scattered power' }),
    // multipath
    mpOn: tog('mpOn', 'on', 'Tap-delay-line multipath channel (ISI)'),
    mpPreset: sel('mpPreset', 'Channel', [{ value: '2ray', label: '2-ray (0, 0.5 at 1 symbol)' }, { value: 'mild', label: '3-tap mild' },
      { value: 'severe', label: '3-tap severe (deep null)' }, { value: 'exp', label: 'Exponential PDP' }], 'Delay profile of the paths'),
    mpSpacing: sel('mpSpacing', 'Path spacing', [{ value: '1', label: '1 symbol (symbol-spaced)' }, { value: '0.5', label: '½ symbol (fractional)' }], 'Delay between successive paths'),
    mpRms: slider({ key: 'mpRms', label: 'RMS delay spread (exp. PDP)', min: 0.2, max: 3, step: 0.1, unit: 'sym', value: DEFAULTS.mpRms, title: 'Power-delay profile decay for the exponential channel' }),
    mpFade: tog('mpFade', 'Fading on each tap', 'Independent Rayleigh fading per path (same Doppler as the Fading section)'),
    // impairments
    pnOn: tog('pnOn', 'on', 'Local-oscillator phase noise (Wiener process)'),
    pnLw: slider({ key: 'pnLw', label: 'Linewidth Δν·Ts', min: 0.000001, max: 0.01, log: true, value: DEFAULTS.pnLw, title: 'Per-symbol phase-increment variance 2π·Δν·Ts' }),
    iqOn: tog('iqOn', 'on', 'Receiver I/Q imbalance: y = μ·x + ν·x* (a mirror image of the signal)'),
    iqEps: slider({ key: 'iqEps', label: 'Gain mismatch ε', min: 0, max: 3, step: 0.05, unit: 'dB', value: DEFAULTS.iqEps, title: 'Q branch gain relative to I' }),
    iqPhi: slider({ key: 'iqPhi', label: 'Phase mismatch φ', min: 0, max: 20, step: 0.5, unit: '°', value: DEFAULTS.iqPhi, title: 'Quadrature error of the Q branch' }),
    iqCorrect: tog('iqCorrect', 'Blind correction (Gram–Schmidt)', 'Re-orthonormalize I and Q from their running second-order statistics'),
    dcOn: tog('dcOn', 'on', 'DC offset (LO leakage) added in the receiver'),
    dcRel: slider({ key: 'dcRel', label: 'Offset (× signal RMS)', min: 0, max: 1, step: 0.01, value: DEFAULTS.dcRel, title: 'Magnitude of the constant offset' }),
    dcAng: slider({ key: 'dcAng', label: 'Offset angle', min: -180, max: 180, step: 1, unit: '°', value: DEFAULTS.dcAng, title: 'Phase of the offset' }),
    dcBlockOn: tog('dcBlockOn', 'DC blocker in the receiver', 'Streaming IIR y[n] = x[n] − x[n−1] + a·y[n−1]'),
    dcPole: slider({ key: 'dcPole', label: 'DC-blocker pole a', min: 0.9, max: 0.9999, step: 0.0001, value: DEFAULTS.dcPole, title: 'Closer to 1: narrower notch, slower settling' }),
    adcOn: tog('adcOn', 'on', 'AGC, clipping and N-bit quantization of I and Q'),
    adcBits: slider({ key: 'adcBits', label: 'Bits', min: 2, max: 16, step: 1, value: DEFAULTS.adcBits, title: 'SQNR ≈ 6.02·N + 1.76 − backoff dB' }),
    adcBackoff: slider({ key: 'adcBackoff', label: 'Backoff', min: 0, max: 30, step: 0.5, unit: 'dB', value: DEFAULTS.adcBackoff, title: 'Below a full-scale sine; too little backoff clips the peaks' }),
    // receiver
    cfoMode: mode('cfoMode', 'Coarse CFO', 'Real: 4th-power FFT estimate. Ideal: uses the true offset.'),
    timingMode: mode('timingMode', 'Timing recovery', 'Real: Gardner loop + cubic Farrow interpolator. Ideal: samples at the true instants.'),
    eq: sel('eq', 'Equalizer', [{ value: 'off', label: 'Off' }, { value: 'lms', label: 'LMS (trains on preamble, then decision-directed)' },
      { value: 'cma', label: 'CMA (blind)' }, { value: 'zf', label: 'Ideal zero-forcing (true channel)' }], 'Placed after timing recovery, before the carrier PLL'),
    eqTaps: slider({ key: 'eqTaps', label: 'Equalizer taps', min: 3, max: 31, step: 1, value: DEFAULTS.eqTaps, title: 'Number of taps (T/2 spacing: two per symbol)' }),
    eqMain: slider({ key: 'eqMain', label: 'Main-tap position', min: 0, max: 15, step: 1, unit: 'sym', value: DEFAULTS.eqMain, title: 'Symbols of look-ahead (handles pre-cursor ISI); also the latency' }),
    eqMu: slider({ key: 'eqMu', label: 'Step size μ', min: 0.001, max: 0.5, log: true, value: DEFAULTS.eqMu, title: 'Normalized LMS/CMA step: larger adapts faster but noisier' }),
    eqFrac: tog('eqFrac', 'Fractionally spaced (T/2)', 'Use the strobe and the midpoint: less sensitive to timing phase'),
    carrierMode: sel('carrierMode', 'Carrier / channel estimate', [{ value: 'real', label: 'PLL only (phase tracking)' }, { value: 'preamble', label: 'Preamble LS estimate (block fading)' },
      { value: 'pilot', label: 'Pilot-aided (interpolated)' }, { value: 'ideal', label: 'Ideal CSI (genie)' }, { value: 'off', label: 'Off (no correction)' }], 'How the receiver removes the carrier phase and channel gain'),
    pilotEvery: slider({ key: 'pilotEvery', label: 'Pilot every P symbols', min: 2, max: 64, step: 1, value: DEFAULTS.pilotEvery, title: 'A known pilot symbol every P payload symbols' }),
    frameMode: mode('frameMode', 'Frame sync', 'Real: correlate with the preamble (also resolves the 90° ambiguity). Ideal: true start.'),
    tBnT: slider({ key: 'tBnT', label: 'Timing loop BnT', min: 0.0005, max: 0.1, log: true, value: DEFAULTS.tBnT, title: 'Normalized noise bandwidth: wider tracks faster but jitters more' }),
    cBnT: slider({ key: 'cBnT', label: 'Carrier loop BnT', min: 0.0005, max: 0.2, log: true, value: DEFAULTS.cBnT, title: 'Normalized noise bandwidth of the carrier PLL' }),
    zeta: slider({ key: 'zeta', label: 'Damping ζ', min: 0.3, max: 2, step: 0.01, value: DEFAULTS.zeta, title: 'Loop damping factor (0.707 is the classic choice)' })
  };

  // Presets: start from a clean real-sync link, then apply the overrides.
  var BASE = { phase: 0, cfo: 0, timing: 0, drift: 0, noise: true, ebn0: 10, fadeOn: false, mpOn: false, mpFade: false, pnOn: false, iqOn: false, dcOn: false, adcOn: false,
    cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real', eq: 'off', tBnT: DEFAULTS.tBnT, cBnT: DEFAULTS.cBnT, zeta: DEFAULTS.zeta };
  var PRESETS = {
    'Ideal link': { cfoMode: 'ideal', timingMode: 'ideal', carrierMode: 'ideal', frameMode: 'ideal' },
    'Phase offset only': { phase: 60 },
    'CFO + timing': { cfo: 0.02, timing: 0.4 },
    'Everything on': { phase: 30, cfo: 0.03, timing: 0.6, drift: 100 },
    'Loop too wide': { phase: 30, cfo: 0.03, timing: 0.6, drift: 100, tBnT: 0.1, cBnT: 0.15 },
    'Loop too narrow': { phase: 30, cfo: 0.03, timing: 0.6, drift: 200, tBnT: 0.0005, cBnT: 0.0005 },
    'Rayleigh slow': { ebn0: 20, fadeOn: true, fadeModel: 'rayleigh', fadeMode: 'jakes', fdTs: 0.0001, carrierMode: 'pilot', pilotEvery: 16, phase: 30 },
    'Rayleigh fast (Doppler)': { ebn0: 20, fadeOn: true, fadeModel: 'rayleigh', fadeMode: 'jakes', fdTs: 0.005, carrierMode: 'pilot', pilotEvery: 8, phase: 30 },
    'Rician K=10 dB': { ebn0: 12, fadeOn: true, fadeModel: 'rician', fadeMode: 'jakes', kDb: 10, fdTs: 0.001, phase: 30, cBnT: 0.05 },
    'Severe multipath + LMS': { ebn0: 25, mpOn: true, mpPreset: 'severe', mpSpacing: '1', eq: 'lms', eqTaps: 15, eqMain: 6, eqMu: 0.05, eqFrac: false, phase: 30 },
    'Blind CMA': { ebn0: 15, mpOn: true, mpPreset: 'mild', mpSpacing: '1', eq: 'cma', eqTaps: 11, eqMain: 3, eqMu: 0.01, eqFrac: false, phase: 50 },
    'Phase noise vs loop BnT': { ebn0: 15, pnOn: true, pnLw: 0.001, cBnT: 0.02 },
    'IQ imbalance uncorrected': { ebn0: 20, iqOn: true, iqEps: 1.5, iqPhi: 10, iqCorrect: false },
    'IQ imbalance corrected': { ebn0: 20, iqOn: true, iqEps: 1.5, iqPhi: 10, iqCorrect: true },
    '4-bit ADC': { ebn0: 15, adcOn: true, adcBits: 4, adcBackoff: 10 },
    'Clipping (0 dB backoff)': { ebn0: 15, adcOn: true, adcBits: 8, adcBackoff: 0 }
  };
  var presetRow = document.createElement('div');
  presetRow.className = 'btn-row';
  Object.keys(PRESETS).forEach(function (name) {
    presetRow.appendChild(ui.button({ label: name, title: 'Load the "' + name + '" setup', onClick: function () {
      var p = Object.assign({}, BASE, PRESETS[name]);
      Object.keys(p).forEach(function (k) { c[k].set(p[k], true); });
      secs.forEach(function (x) { x.sync(); });
      commit();
    } }).el);
  });

  page.group('Presets', [presetRow]);
  page.group('Signal', [c.ebn0, c.sps, c.rolloff, c.spanAuto, c.span, c.nbits, c.diff]);
  page.group('Input', [c.input, c.text]);
  page.group('Channel', [c.noise, c.phase, c.cfo, c.timing, c.drift, page.seedControl()]);
  var secs = [
    page.section('Fading', c.fadeOn, [c.fadeModel, c.fadeMode, c.fadeBlock, c.fdTs, c.kDb]),
    page.section('Multipath', c.mpOn, [c.mpPreset, c.mpSpacing, c.mpRms, c.mpFade]),
    page.section('Phase noise', c.pnOn, [c.pnLw]),
    page.section('IQ imbalance', c.iqOn, [c.iqEps, c.iqPhi, c.iqCorrect]),
    page.section('DC offset', c.dcOn, [c.dcRel, c.dcAng, c.dcBlockOn, c.dcPole]),
    page.section('ADC', c.adcOn, [c.adcBits, c.adcBackoff])
  ];
  page.group('Receiver', [c.cfoMode, c.timingMode, c.eq, c.eqTaps, c.eqMain, c.eqMu, c.eqFrac, c.carrierMode, c.pilotEvery, c.frameMode, c.tBnT, c.cBnT, c.zeta]);

  function sync(s) {
    c.nbits.setDisabled(s.input === 'text');
    c.text.el.hidden = s.input !== 'text';
    c.ebn0.setDisabled(!s.noise);
    c.span.setDisabled(s.spanAuto);
    c.tBnT.setDisabled(s.timingMode !== 'real');
    c.cBnT.setDisabled(s.carrierMode !== 'real');
    c.pilotEvery.el.hidden = s.carrierMode !== 'pilot';
    c.fadeBlock.el.hidden = s.fadeMode !== 'block'; c.fdTs.el.hidden = s.fadeMode === 'block' && !s.mpFade;
    c.kDb.el.hidden = s.fadeModel !== 'rician';
    c.mpRms.el.hidden = s.mpPreset !== 'exp';
    c.dcPole.setDisabled(!s.dcBlockOn);
    [c.eqTaps, c.eqMain, c.eqMu, c.eqFrac].forEach(function (x) { x.el.hidden = s.eq === 'off'; });
    c.eqMu.setDisabled(s.eq === 'zf');
    textCard.hidden = s.input !== 'text';
  }

  // ---------- plot column ----------
  var textOut = document.createElement('div');
  var textCard = page.addCard(textOut);

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

  var C = { equalAspect: true, xLim: [-1.6, 1.6], yLim: [-1.6, 1.6], legend: false, height: 210 };
  var pCon = page.addPlotGrid([
    Object.assign({ title: '1. Received (raw ADC output)' }, C),
    Object.assign({ title: '2. After DC/IQ fix + matched filter' }, C),
    Object.assign({ title: '3. After coarse CFO correction' }, C),
    Object.assign({ title: '4. After timing (before EQ)' }, C),
    Object.assign({ title: '5. After equalizer' }, C),
    Object.assign({ title: '6. After carrier / channel estimate' }, C),
    Object.assign({ title: '7. Payload after ambiguity fix' }, C),
    Object.assign({ title: '8. Decisions (red = bit errors)' }, C)
  ], 4, 'Constellation at each receiver stage. Colour runs from early (blue) to late (yellow), so convergence shows as a spiral settling down.');
  var pEye = page.addPlotGrid([
    { title: 'Eye diagram: I', xLabel: 'time (symbols)', xLim: [-1, 1], yLim: [-1.8, 1.8], legend: false, height: 230 },
    { title: 'Eye diagram: Q', xLabel: 'time (symbols)', xLim: [-1, 1], yLim: [-1.8, 1.8], legend: false, height: 230 }
  ], 2);
  var pSpec = page.addPlot({ title: 'Received spectrum (Welch)', xLabel: 'frequency (× Rs)', yLabel: 'power per bin (dB)', xUnit: 'Rs', yUnit: 'dB', height: 250 });
  var pFade = page.addPlotGrid([
    { title: '|h(t)| (dB)', xLabel: 'symbol', yUnit: 'dB', height: 220 },
    { title: 'Phase of h(t)·carrier (°)', xLabel: 'symbol', yLim: [-180, 180], height: 220 }
  ], 2, 'Fading channel h(t) (true vs estimated)');
  var pEq = page.addPlotGrid([
    { title: 'Channel impulse response |h|', xLabel: 'delay (symbols)', height: 220, legend: false },
    { title: 'Frequency response (dB)', xLabel: 'frequency (× Rs)', yUnit: 'dB', height: 220 },
    { title: 'Equalizer MSE (dB)', xLabel: 'symbol', yUnit: 'dB', height: 220, legend: false }
  ], 3, 'Multipath and equalizer (combined response should be flat)');
  var pAdc = page.addPlot({ title: 'ADC input histogram (after AGC), I and Q', xLabel: 'amplitude (× full scale)', yLabel: 'count', height: 220 });
  var pLoop = page.addPlotGrid([
    { title: 'Timing error (Gardner)', xLabel: 'symbol', legend: false, height: 210 },
    { title: 'Timing estimate (symbols)', xLabel: 'symbol', height: 210 },
    { title: 'Carrier phase (°)', xLabel: 'symbol', height: 210 },
    { title: 'Carrier frequency (× Rs)', xLabel: 'symbol', height: 210 }
  ], 2, 'Loop traces (dashed = true value, dotted line = convergence)');
  var pCorr = page.addPlot({ title: 'Preamble correlation (normalized)', xLabel: 'symbol index', height: 210, legend: false });
  var pErr = page.addPlot({ title: 'Error map (bit positions)', xLabel: 'bit index', yLim: [-1, 1], height: 120, legend: false });
  function cardOf(p) { return (Array.isArray(p) ? p[0] : p).element.closest('.card'); }

  // ---------- configuration ----------
  function cfgFrom(s) {
    var mpTaps = SDR.channel.multipathPresets(s.mpPreset, { spacing: +s.mpSpacing, rmsDelay: s.mpRms });
    return {
      nBits: Math.round(s.nbits), bits: s.input === 'text' ? SDR.qpsk.textToBits(s.text || ' ') : null, diff: s.diff,
      sps: Math.round(s.sps), rolloff: s.rolloff, span: s.spanAuto ? 'auto' : Math.round(s.span), ebn0Db: s.ebn0, noise: s.noise,
      pilotEvery: s.carrierMode === 'pilot' ? Math.round(s.pilotEvery) : 0,
      channel: {
        phaseDeg: s.phase, cfoRs: s.cfo, timingSym: s.timing, driftPpm: s.drift,
        fading: s.fadeOn ? { model: s.fadeModel, mode: s.fadeMode, blockSymbols: Math.round(s.fadeBlock), fdTs: s.fdTs, kDb: s.kDb } : null,
        multipath: s.mpOn ? { taps: mpTaps, tapFading: s.mpFade ? s.fdTs : 0 } : null,
        phaseNoise: s.pnOn ? s.pnLw : 0,
        iq: s.iqOn ? { epsDb: s.iqEps, phiDeg: s.iqPhi } : null,
        dc: s.dcOn ? { rel: s.dcRel, angleDeg: s.dcAng } : null,
        adc: s.adcOn ? { bits: Math.round(s.adcBits), backoffDb: s.adcBackoff } : null
      },
      rx: { cfo: s.cfoMode, timing: s.timingMode, carrier: s.carrierMode, frame: s.frameMode, timingBnT: s.tBnT, carrierBnT: s.cBnT, zeta: s.zeta,
        eq: s.eq, eqTaps: Math.round(s.eqTaps), eqMain: Math.round(s.eqMain), eqMu: s.eqMu, eqFractional: s.eqFrac,
        dcBlock: s.dcOn && s.dcBlockOn ? s.dcPole : 0, iqCorrect: s.iqOn && s.iqCorrect }
    };
  }

  function run(s, full) {
    var cfg = cfgFrom(s);
    if (!full && !cfg.bits) cfg.nBits = Math.min(cfg.nBits, 1000); // lighter preview while dragging
    draw(s, SDR.qpsk.runLink(cfg, SDR.rng.createRng(s.seed)), false);
  }

  // ---------- drawing ----------
  function timeSeries(xs, ys, idx, radius) {   // colour-by-time buckets, blue → yellow
    var NB = 6, out = [], per = Math.ceil(idx.length / NB);
    for (var b = 0; b < NB; b++) {
      var sx = [], sy = [];
      for (var i = b * per; i < Math.min(idx.length, (b + 1) * per); i++) { sx.push(xs[idx[i]]); sy.push(ys[idx[i]]); }
      out.push({ type: 'scatter', x: sx, y: sy, radius: radius || 1.5, alpha: 0.75, color: 'hsl(' + Math.round(220 - (180 * b) / (NB - 1)) + ', 80%, 55%)' });
    }
    return out;
  }
  function spread(n, max, from) { var idx = [], f = from || 0, step = Math.max(1, (n - f) / max); for (var x = f; x < n; x += step) idx.push(Math.floor(x)); return idx; }
  function wrap(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
  function seq(n) { var a = new Float64Array(n); for (var i = 0; i < n; i++) a[i] = i; return a; }
  function db(re, im) { return 10 * Math.log10(re * re + im * im + 1e-30); }

  var history = [];
  function draw(s, r, live) {
    var t = r.traces, sps = r.cfg.sps, D = SDR.filters.rrcTaps(r.cfg.rolloff, sps, r.cfg.span).groupDelay, i;
    var decisionAnn = [{ type: 'vline', x: 0 }, { type: 'hline', y: 0 }];
    var ideal = { type: 'scatter', x: [Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2], y: [Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2], radius: 4.5, color: '#888888' };
    var rawScale = Math.sqrt(sps);   // raw samples have power 1/sps; scale to the symbol plane for display
    var raw = { re: Array.from(t.rx.re, function (v) { return v * rawScale; }), im: Array.from(t.rx.im, function (v) { return v * rawScale; }) };

    var errSym = new Set();
    t.errorPositions.forEach(function (b) { errSym.add(b >> 1); });
    var ok = { x: [], y: [] }, bad = { x: [], y: [] };
    spread(t.payload.re.length, 3000).forEach(function (k) { var o = errSym.has(k) ? bad : ok; o.x.push(t.payload.re[k]); o.y.push(t.payload.im[k]); });
    var series = [];
    if (live) {
      history.unshift(ok); if (history.length > 6) history.pop();
      for (i = history.length - 1; i >= 1; i--) series.push({ type: 'scatter', x: history[i].x, y: history[i].y, radius: 1.5, alpha: 0.5 * Math.pow(0.6, i), color: PAL[2] });
    }
    series.push({ type: 'scatter', x: ok.x, y: ok.y, radius: 1.5, alpha: 0.75, color: PAL[2] });
    series.push({ type: 'scatter', x: bad.x, y: bad.y, radius: 2.6, color: PAL[3] });
    series.push(ideal);
    pCon[7].setOptions({ annotations: decisionAnn });
    pCon[7].setData(series);
    if (live) { updateReadouts(s, r); return; }   // Live mode: decisions + readouts only, to keep frames cheap

    var nS = t.mf.re.length;
    pCon[0].setData(timeSeries(raw.re, raw.im, spread(raw.re.length, 2500)));
    pCon[1].setData(timeSeries(t.mf.re, t.mf.im, spread(nS - 2 * D, 2500, 2 * D)));
    pCon[2].setData(timeSeries(t.cfoCorrected.re, t.cfoCorrected.im, spread(t.cfoCorrected.re.length - 2 * D, 2500, 2 * D)));
    pCon[3].setData(timeSeries(t.strobes.re, t.strobes.im, spread(t.strobes.re.length, 2500)));
    pCon[4].setData(t.eqOut.re.length ? timeSeries(t.eqOut.re, t.eqOut.im, spread(t.eqOut.re.length, 2500)) : []);
    pCon[4].setOptions({ title: t.eqOut.re.length ? '5. After equalizer' : '5. Equalizer off' });
    pCon[5].setData(timeSeries(t.carrier.re, t.carrier.im, spread(t.carrier.re.length, 2500)));
    pCon[6].setOptions({ annotations: decisionAnn });
    pCon[6].setData(timeSeries(t.payload.re, t.payload.im, spread(t.payload.re.length, 2500)).concat([ideal]));

    // Eye diagrams (carrier-corrected, nominal symbol grid)
    var cc = t.cfoCorrected, th = t.phaseEst, nT = Math.floor(3800 / (2 * sps + 2)), eI = { x: [], y: [] }, eQ = { x: [], y: [] }, M = r.channel.multipath ? r.channel.multipath.bulkDelay : 0;
    var k0 = Math.min(200, Math.floor(t.strobes.re.length / 4));
    for (var k = k0; k < k0 + nT; k++) {
      var c0 = k * sps + 2 * D + M;
      if (c0 + sps >= cc.re.length || k >= th.length) break;
      var ct = Math.cos(th[k]), st = Math.sin(th[k]);
      for (var j = -sps; j <= sps; j++) {
        var a = cc.re[c0 + j], b = cc.im[c0 + j];
        eI.x.push(j / sps); eI.y.push(a * ct + b * st); eQ.x.push(j / sps); eQ.y.push(b * ct - a * st);
      }
      eI.x.push(NaN); eI.y.push(NaN); eQ.x.push(NaN); eQ.y.push(NaN);
    }
    var tau = t.muEst.length ? t.muEst[t.muEst.length - 1] : 0, tw = tau - Math.round(tau);
    var eyeAnn = [{ type: 'vline', x: tw, label: 'strobe' }, { type: 'vline', x: tw - 1 }, { type: 'vline', x: tw + 1 }];
    pEye[0].setOptions({ annotations: eyeAnn }); pEye[1].setOptions({ annotations: eyeAnn });
    pEye[0].setData([{ type: 'line', x: eI.x, y: eI.y, lineWidth: 1, alpha: 0.3, color: PAL[0] }]);
    pEye[1].setData([{ type: 'line', x: eQ.x, y: eQ.y, lineWidth: 1, alpha: 0.3, color: PAL[1] }]);

    // Spectrum (fs = sps → axis in units of Rs)
    var nfft = Math.min(1024, SDR.mathx.nextPow2(Math.max(64, t.rx.re.length >> 3)));
    var pr = SDR.dsp.welchPSD(t.rx, sps, { nfft: nfft }), pt = SDR.dsp.welchPSD(t.tx, sps, { nfft: nfft }), bw = (1 + r.cfg.rolloff) / 2;
    pSpec.setOptions({ xLim: [-Math.min(sps / 2, 2), Math.min(sps / 2, 2)], annotations: [
      { type: 'band', x0: -bw, x1: bw, label: '(1 + β)·Rs = ' + (2 * bw).toFixed(2) + ' Rs' },
      { type: 'vline', x: -0.5, label: '−Rs/2' }, { type: 'vline', x: 0.5, label: '+Rs/2' }] });
    pSpec.setData([{ type: 'line', x: pr.freqs, y: pr.psdDb, label: 'received', lineWidth: 1.1 }, { type: 'line', x: pt.freqs, y: pt.psdDb, label: 'transmitted', lineWidth: 1.1 }]);

    // Fading view
    var showFade = !!r.cfg.channel.fading || (r.cfg.channel.multipath && r.cfg.channel.multipath.tapFading);
    cardOf(pFade).hidden = !showFade;
    if (showFade) {
      var n = t.hTrue.re.length, xs = seq(n), magT = new Float64Array(n), magE = new Float64Array(n), phT = new Float64Array(n), phE = new Float64Array(n);
      for (i = 0; i < n; i++) {
        // Phase: the total complex gain the receiver must remove = fading phase + carrier phase (offset, CFO, noise).
        magT[i] = db(t.hTrue.re[i], t.hTrue.im[i]); phT[i] = wrap(Math.atan2(t.hTrue.im[i], t.hTrue.re[i]) + (t.phaseTrue[i] || 0)) / DEG;
        var er = t.hEst.re[i], ei = t.hEst.im[i];
        magE[i] = isFinite(er) ? db(er, ei) : NaN;
        phE[i] = isFinite(er) ? Math.atan2(ei, er) / DEG : (r.cfg.rx.carrier === 'real' && t.phaseEst[i] !== undefined ? wrap(t.phaseEst[i]) / DEG : NaN);
      }
      pFade[0].setOptions({ annotations: [{ type: 'hline', y: -10, label: '−10 dB' }] });
      pFade[0].setData([{ type: 'line', x: xs, y: magT, label: 'true |h|', lineWidth: 1.2 }, { type: 'line', x: xs, y: magE, label: 'estimate', lineWidth: 1.2, dash: [4, 3] }]);
      pFade[1].setData([{ type: 'line', x: xs, y: phT, label: 'true (h + carrier)', lineWidth: 1.2 }, { type: 'line', x: xs, y: phE, label: r.cfg.rx.carrier === 'real' ? 'PLL phase (mod 90°)' : 'estimate', lineWidth: 1.2, dash: [4, 3] }]);
    }

    // Multipath / equalizer view
    var showEq = !!r.cfg.channel.multipath || !!r.eq;
    cardOf(pEq).hidden = !showEq;
    if (showEq) {
      var ir = r.channel.multipath ? r.channel.multipath.impulse : { re: Float64Array.from([1]), im: new Float64Array(1) }, irx = [], iry = [];
      for (i = 0; i < ir.re.length; i++) { irx.push((i - (r.channel.multipath ? r.channel.multipath.bulkDelay : 0)) / sps); iry.push(Math.hypot(ir.re[i], ir.im[i])); }
      pEq[0].setData([{ type: 'line', x: irx, y: iry, lineWidth: 1.4, color: PAL[0] }, { type: 'scatter', x: irx, y: iry, radius: 1.8, color: PAL[0] }]);
      var fr = [], NF = 128; for (i = 0; i < NF; i++) fr.push(-0.5 * (1 + r.cfg.rolloff) + (i * (1 + r.cfg.rolloff)) / (NF - 1));
      var resp = [{ type: 'line', x: fr, y: SDR.eq.responseDb(ir, fr.map(function (f) { return f / sps; })), label: 'channel H(f)', lineWidth: 1.4 }];
      if (r.eq) {
        var half = fr.filter(function (f) { return Math.abs(f) <= 0.5; });
        resp.push({ type: 'line', x: half, y: SDR.eq.responseDb(r.eq.taps, half.map(function (f) { return r.eq.fractional ? f / 2 : f; })), label: 'equalizer W(f)', lineWidth: 1.4 });
        resp.push({ type: 'line', x: half, y: SDR.eq.responseDb(r.eq.combined, half), label: 'combined (symbol rate)', lineWidth: 2 });
        var mse = t.eqMse, sm = new Float64Array(mse.length), acc = NaN;
        for (i = 0; i < mse.length; i++) { var v = mse[i]; if (isFinite(v)) acc = isFinite(acc) ? 0.95 * acc + 0.05 * v : v; sm[i] = 10 * Math.log10(acc); }
        pEq[2].setOptions({ annotations: [{ type: 'vline', x: r.eq.convergence, label: 'converged' }] });
        pEq[2].setData([{ type: 'line', x: seq(sm.length), y: sm, lineWidth: 1.3, color: PAL[4] }]);
      } else pEq[2].setData([]);
      pEq[1].setData(resp);
    }

    // ADC histogram
    var adc = r.channel.adc;
    cardOf(pAdc).hidden = !adc;
    if (adc) {
      var NB = 81, lim = 1.3, hx = [], hI = new Float64Array(NB), hQ = new Float64Array(NB);
      for (i = 0; i < NB; i++) hx.push(-lim + (2 * lim * i) / (NB - 1));
      for (i = 0; i + 1 < adc.hist.length; i += 2) {
        var bi = Math.round(((adc.hist[i] + lim) / (2 * lim)) * (NB - 1)), bq = Math.round(((adc.hist[i + 1] + lim) / (2 * lim)) * (NB - 1));
        hI[Math.max(0, Math.min(NB - 1, bi))]++; hQ[Math.max(0, Math.min(NB - 1, bq))]++;
      }
      pAdc.setOptions({ xLim: [-lim, lim], annotations: [{ type: 'vline', x: -1, label: '−FS' }, { type: 'vline', x: 1, label: '+FS' }] });
      pAdc.setData([{ type: 'line', x: hx, y: hI, label: 'I', lineWidth: 1.4 }, { type: 'line', x: hx, y: hQ, label: 'Q', lineWidth: 1.4 }]);
    }

    // Loop traces
    var K = t.timingErr.length, xk = seq(K), lk = r.lock;
    pLoop[0].setOptions({ annotations: lk.timing.convergence ? [{ type: 'vline', x: lk.timing.convergence }] : [] });
    pLoop[0].setData([{ type: 'line', x: xk, y: t.timingErr, lineWidth: 1, color: PAL[0] }]);
    var shift = K ? Math.round(t.muEst[K - 1] - t.muTrue[K - 1]) : 0, muT = new Float64Array(K);
    for (i = 0; i < K; i++) muT[i] = t.muTrue[i] + shift;
    pLoop[1].setOptions({ annotations: [{ type: 'vline', x: lk.timing.convergence }] });
    pLoop[1].setData([{ type: 'line', x: xk, y: t.muEst, label: 'estimate', lineWidth: 1.4 }, { type: 'line', x: xk, y: muT, label: 'true', dash: [6, 4], color: '#888888', lineWidth: 1.2 }]);
    var Kz = t.phaseEst.length, q = Kz ? Math.round(wrap(t.phaseEst[Kz - 1] - t.phaseTrue[Kz - 1]) / (Math.PI / 2)) * (Math.PI / 2) : 0, pe = new Float64Array(Kz), ptr = new Float64Array(Kz);
    for (i = 0; i < Kz; i++) { pe[i] = t.phaseEst[i] / DEG; ptr[i] = wrap(t.phaseTrue[i] + q) / DEG; }
    pLoop[2].setOptions({ yLim: [-180, 180], annotations: [{ type: 'vline', x: lk.carrier.convergence }] });
    pLoop[2].setData(r.cfg.rx.carrier === 'real' || r.cfg.rx.carrier === 'ideal' ? [{ type: 'line', x: seq(Kz), y: pe, label: 'estimate', lineWidth: 1.4 }, { type: 'line', x: seq(Kz), y: ptr, label: 'true (mod 90°)', dash: [6, 4], color: '#888888', lineWidth: 1.2 }] : []);
    var fe = new Float64Array(t.freqEst.length), ft = new Float64Array(t.freqEst.length);
    for (i = 0; i < fe.length; i++) { fe[i] = t.freqEst[i] / (2 * Math.PI); ft[i] = t.freqTrueRs; }
    pLoop[3].setData(r.cfg.rx.carrier === 'real' ? [{ type: 'line', x: seq(fe.length), y: fe, label: 'PLL residual', lineWidth: 1.4 }, { type: 'line', x: seq(fe.length), y: ft, label: 'true residual', dash: [6, 4], color: '#888888', lineWidth: 1.2 }] : []);

    pCorr.setOptions({ annotations: [{ type: 'vline', x: r.frameStart, label: 'frame start ' + r.frameStart }] });
    pCorr.setData(t.corr.length ? [{ type: 'line', x: seq(t.corr.length), y: t.corr, lineWidth: 1, color: PAL[4] }, { type: 'scatter', x: [r.frameStart], y: [t.corr[r.frameStart] || 0], radius: 5, color: PAL[3] }] : []);

    var nb = r.bitsTx.length;
    pErr.setOptions({ xLim: [0, nb], annotations: t.errorPositions.length ? [] : [{ type: 'text', x: nb / 2, y: 0, text: 'no bit errors' }] });
    pErr.setData([{ type: 'scatter', x: t.errorPositions, y: t.errorPositions.map(function () { return 0; }), radius: 2.5, color: PAL[3] }]);

    updateReadouts(s, r);
    renderText(s, r);
  }

  function fmtPct(v) { return (100 * v).toFixed(v < 0.01 ? 2 : 1) + ' %'; }
  function theoryFor(s) {
    if (s.fadeOn && s.fadeModel === 'rician') return SDR.theory.qpskRician(s.ebn0, s.kDb);
    if (s.fadeOn) return SDR.theory.qpskRayleigh(s.ebn0);
    return s.diff ? SDR.theory.dqpskAwgn(s.ebn0) : SDR.theory.qpskAwgn(s.ebn0);
  }
  function theoryLabel(s) { return s.fadeOn ? (s.fadeModel === 'rician' ? ' (Rician, ideal CSI)' : ' (Rayleigh, ideal CSI)') : s.diff ? ' (DE-QPSK)' : ''; }

  function fadeStats(r) {
    var h = r.traces.hTrue, n = h.re.length, min = Infinity, below = 0, cnt = 0;
    for (var i = 0; i < n; i++) { if (!isFinite(h.re[i])) continue; var d = db(h.re[i], h.im[i]); min = Math.min(min, d); if (d < -10) below++; cnt++; }
    return cnt ? { min: min, below: below / cnt } : null;
  }

  function updateReadouts(s, r) {
    var th = s.noise ? theoryFor(s) : 0, lk = r.lock, n = r.bitsTx.length, fs = fadeStats(r), ch = r.channel;
    function wrap1(v) { return v - Math.floor(v); }
    page.setReadouts({
      ber: r.errors + ' / ' + n + ' = ' + (r.ber ? r.ber.toExponential(2) : '0'),
      theory: s.noise ? th.toExponential(2) + theoryLabel(s) : '0 (no noise)',
      evm: isFinite(r.evm) ? fmtPct(r.evm) + ' (' + r.evmDb.toFixed(1) + ' dB)' : '–',
      esn0: (isFinite(r.esn0EstDb) ? r.esn0EstDb.toFixed(1) : '–') + ' / ' + (s.noise ? SDR.channel.esn0Db(s.ebn0, 2).toFixed(1) : '∞') + ' dB',
      cfo: r.est.cfoRs.toFixed(4) + ' / ' + r.truth.cfoRs.toFixed(4),
      phase: (r.est.phase / DEG).toFixed(1) + '° / ' + (r.truth.phase / DEG).toFixed(1) + '°',
      timing: wrap1(r.est.timingSym).toFixed(3) + ' / ' + wrap1(r.truth.timingSym).toFixed(3),
      lock: (lk.timing.locked ? '✓' : '✗') + ' timing, ' + (lk.carrier.locked ? '✓' : '✗') + ' carrier',
      conv: (s.timingMode === 'real' ? lk.timing.convergence : '–') + ', ' + (s.carrierMode === 'real' ? lk.carrier.convergence : '–'),
      fade: fs ? fs.min.toFixed(1) + ' dB / ' + fmtPct(fs.below) : '–',
      eqr: r.eq ? r.eq.mseDb.toFixed(1) + ' dB / ' + r.eq.convergence + ' sym' : '–',
      iqr: ch.iq ? ch.iq.irrBeforeDb.toFixed(1) + ' → ' + ch.iq.irrAfterDb.toFixed(1) + ' dB' : '–',
      adcr: ch.adc ? ch.adc.sqnrDb.toFixed(1) + ' dB / ' + fmtPct(ch.adc.clipRate) : '–',
      pil: r.pilots.count ? fmtPct(r.pilots.overhead) + ' / ' + fmtPct(r.pilots.efficiency) : 'no pilots / ' + fmtPct(r.pilots.efficiency)
    });
    page.setExplain(status(s, r, th, fs));
  }

  // The dominant problem, in order of how much it usually explains.
  function status(s, r, th, fs) {
    var lk = r.lock, n = r.bitsTx.length, ch = r.channel;
    if (r.corrPeak < 0.5) return 'Frame sync failed: the preamble was not found (correlation peak ' + r.corrPeak.toFixed(2) + '). Check the loops, equalizer and channel above.';
    if (ch.adc && ch.adc.clipRate > 0.005) return 'Clipping: ' + (100 * ch.adc.clipRate).toFixed(1) + '% of ADC samples hit full scale (SQNR ' + ch.adc.sqnrDb.toFixed(1) + ' dB). Increase the backoff.';
    if (ch.adc && ch.adc.sqnrDb < SDR.channel.esn0Db(s.ebn0, 2) - 10 * Math.log10(s.sps) + 6 && s.noise) return 'ADC resolution limits the link: SQNR ' + ch.adc.sqnrDb.toFixed(1) + ' dB is close to the per-sample SNR. Add bits or reduce backoff.';
    if (r.eq && s.mpOn && s.mpPreset === 'severe' && r.errors) return 'Deep spectral null: every linear equalizer pays here (MSE ' + r.eq.mseDb.toFixed(1) + ' dB). ' + (s.eq === 'zf' ? 'Zero-forcing inverts the null and amplifies the noise there; LMS (MMSE) does better.' : 'LMS trades some residual ISI for less noise boost; switch to ZF to see it get worse.');
    if (r.eq && (r.eq.mseDb > -8 || r.eq.convergence > 0.6 * r.traces.eqMse.length)) return 'Equalizer not converged (MSE ' + r.eq.mseDb.toFixed(1) + ' dB): increase μ or the number of taps.';
    if (s.mpOn && s.eq === 'off' && r.errors) return 'Multipath ISI with no equalizer: turn on LMS, CMA or ideal ZF.';
    if (s.iqOn && !s.iqCorrect && ch.iq && ch.iq.irrBeforeDb < 30) return 'IQ imbalance: a mirror image of the signal leaks in at IRR ' + ch.iq.irrBeforeDb.toFixed(1) + ' dB. Turn on the blind correction.';
    if (fs && r.errors && fs.below > 0.02) return 'Deep fades are causing error bursts (' + (100 * fs.below).toFixed(1) + '% of the time below −10 dB). That is why fading BER only falls as 1/SNR.';
    if (s.timingMode === 'real' && !lk.timing.locked) return 'Timing loop not locked: ' + (s.tBnT > 0.03 ? 'BnT is too wide (jitter or slips), try narrower.' : 'try a wider timing BnT or less clock drift.');
    if (s.carrierMode === 'real' && !lk.carrier.locked) return 'Carrier loop not locked: ' + (s.cBnT > 0.05 ? 'BnT is too wide (too noisy), try narrower.' : s.pnOn ? 'phase noise outruns the loop, try a wider carrier BnT.' : 'try a wider carrier BnT.');
    if (s.pnOn && r.errors && s.carrierMode === 'real') return 'Phase noise: the PLL ' + (s.cBnT < 0.03 ? 'is too narrow to follow the random walk, so cycle slips corrupt blocks of symbols. Widen the carrier BnT.' : 'tracks it, but the extra loop noise costs SNR. Narrow the BnT until slips appear: that is the trade-off.');
    var late = Math.max(s.timingMode === 'real' ? lk.timing.convergence : 0, s.carrierMode === 'real' ? lk.carrier.convergence : 0);
    if (late > r.cfg.leadSymbols && r.errors) return 'Loops converged late (symbol ' + late + ', after the ' + r.cfg.leadSymbols + '-symbol lead-in), so the start of the payload is lost. Try a wider BnT.';
    if (s.carrierMode === 'off' && Math.abs(s.phase) > 0.5) return 'Carrier recovery off: the constellation stays rotated by the channel phase, and BER follows the static-phase-error curve.';
    if (!s.noise) return r.errors ? r.errors + ' errors without noise: residual offsets or ISI are breaking decisions.' : 'No noise: locked and error-free.';
    var ci = SDR.theory.wilsonInterval(r.errors, n);
    if (th >= ci[0] && th <= ci[1]) return 'Locked, BER matches theory' + theoryLabel(s) + ' (theory inside the 95% interval of this frame).';
    if (r.ber > th) return 'Locked, but BER is ' + (r.ber / th).toFixed(1) + '× theory' + theoryLabel(s) + ': implementation loss from loop jitter, channel estimation or residual offsets.';
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
    Array.from(txt).forEach(function (chr) {
      var b = enc.encode(chr), slice = rxBytes.subarray(pos, pos + b.length), same = slice.length === b.length;
      for (var i = 0; same && i < b.length; i++) if (slice[i] !== b[i]) same = false;
      var span = document.createElement('span');
      span.textContent = same ? chr : (dec.decode(slice) || '�');
      if (!same) { span.className = 'bad'; wrong++; }
      got.appendChild(span);
      pos += b.length;
    });
    var lab3 = document.createElement('div'); lab3.className = 'text-io-label';
    lab3.textContent = wrong ? wrong + ' of ' + Array.from(txt).length + ' characters wrong' : 'All characters correct';
    [lab1, sent, lab2, got, lab3].forEach(function (e) { textOut.appendChild(e); });
  }

  // ---------- Live mode and quick BER check: streaming steps through runChunked ----------
  var ac = null, task = null;
  function setBusy(which) {
    task = which;
    liveBtn.el.textContent = which === 'live' ? '■ Stop live' : '▶ Live';
    berBtn.el.textContent = which === 'ber' ? '■ Stop' : 'Quick BER check';
    liveBtn.setDisabled(which === 'ber'); berBtn.setDisabled(which === 'live');
    actProg.hidden = which !== 'ber';
  }
  function report(res) { return 'longest slice ' + Math.round(res.maxSliceMs) + ' ms'; }

  function toggleLive() {
    if (task) return ac.abort();
    var s = page.state(), cfg = cfgFrom(s), rng = SDR.rng.createRng(s.seed), frames = 0, t0 = performance.now();
    if (!cfg.bits) cfg.nBits = Math.min(cfg.nBits, 2000);
    history = [];
    ac = new AbortController(); setBusy('live');
    ui.runChunked(function* () {
      for (;;) {
        var link = SDR.qpsk.createLink(cfg, rng);
        while (!link.done) { link.step(UI_BLOCK); yield frames; }
        var r = link.finish();
        draw(s, r, true);
        frames++;
        page.status.set('Live: frame ' + frames + ' (' + (frames / ((performance.now() - t0) / 1000)).toFixed(1) + ' frames/s)');
        yield frames;
      }
    }, { signal: ac.signal }).then(function (res) {
      ac = null; setBusy(null); history = [];
      lastLive = res;
      commit();
      page.status.set('Live stopped after ' + frames + ' frames (' + report(res) + ')', 'ok');
    });
  }
  var lastLive = null;

  function toggleBer() {
    if (task) return ac.abort();
    var s = page.state(), cfg = cfgFrom(s), rng = SDR.rng.createRng(s.seed + 1000), errs = 0, bits = 0, t0 = performance.now();
    cfg.bits = null; cfg.nBits = 20000;
    var MAX = 1e6, MIN_ERR = 100;
    ac = new AbortController(); setBusy('ber'); actProg.value = 0;
    berOut.textContent = 'Running…';
    ui.runChunked(function* () {
      while (errs < MIN_ERR && bits < MAX) {
        var link = SDR.qpsk.createLink(cfg, rng);
        while (!link.done) { link.step(UI_BLOCK); yield Math.max(errs / MIN_ERR, bits / MAX); }
        var r = link.finish();
        errs += r.errors; bits += r.bitsTx.length;
        yield Math.max(errs / MIN_ERR, bits / MAX);
      }
    }, { signal: ac.signal, onProgress: function (p) { actProg.value = Math.min(1, p); } }).then(function (res) {
      ac = null; setBusy(null);
      var ci = SDR.theory.wilsonInterval(errs, bits), th = s.noise ? theoryFor(s) : 0, inside = th >= ci[0] && th <= ci[1];
      berOut.textContent = (res.aborted ? 'Stopped. ' : '') + 'Measured BER ' + (errs / bits).toExponential(3) + ' (' + errs + ' errors / ' + bits.toLocaleString() + ' bits), ' +
        '95% Wilson interval [' + ci[0].toExponential(2) + ', ' + ci[1].toExponential(2) + ']. Theory' + theoryLabel(s) + ' ' + th.toExponential(3) +
        (inside ? ' is inside the interval.' : ' is outside the interval' + (errs / bits > th ? ' (implementation loss).' : '.')) +
        ' (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s, ' + report(res) + ')';
      page.status.set('BER check done', 'ok');
    });
  }

  page.start();
})();
