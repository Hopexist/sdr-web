// SDR.qpskControls — the QPSK link's controls, shared by the QPSK page and the BER page's curve editor.
// create({ onInput, onChange }) builds the controls (unregistered); groups/sections say how the QPSK page lays
// them out; sync(state) enables/hides dependent controls; cfgFrom(state) turns UI state into a link config.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var ui = SDR.ui;
  var DEFAULTS = { ebn0: 10, sps: 8, rolloff: 0.35, spanAuto: true, span: 16, nbits: 4000, diff: false, input: 'random', text: 'Hello from Buffalo!',
    noise: true, phase: 30, cfo: 0.01, timing: 0.3, drift: 0,
    fadeOn: false, fadeModel: 'rayleigh', fadeMode: 'jakes', fadeBlock: 64, fdTs: 0.001, kDb: 10,
    mpOn: false, mpPreset: 'mild', mpSpacing: 1, mpRms: 1, mpFade: false,
    pnOn: false, pnLw: 0.0001, iqOn: false, iqEps: 1, iqPhi: 5, iqCorrect: true,
    dcOn: false, dcRel: 0.3, dcAng: 30, dcBlockOn: true, dcPole: 0.999, adcOn: false, adcBits: 8, adcBackoff: 10,
    cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real', pilotEvery: 8,
    eq: 'off', eqTaps: 11, eqMain: 3, eqMu: 0.02, eqFrac: false, tBnT: 0.01, cBnT: 0.02, zeta: 0.707, seed: 1 };

  function create(h) {
    function slider(o) { o.onInput = h.onInput; o.onChange = h.onChange; return ui.slider(o); }
    function sel(key, label, options, title) { return ui.select({ key: key, label: label, value: DEFAULTS[key], options: options, onChange: h.onChange, title: title }); }
    function tog(key, label, title) { return ui.toggle({ key: key, label: label, checked: DEFAULTS[key], onChange: h.onChange, title: title }); }
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
      text: ui.text({ key: 'text', label: 'Text', value: DEFAULTS.text, onChange: h.onChange, title: 'Sent as UTF-8; wrong characters are highlighted after decoding' }),
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
    return {
      c: c,
      groups: {
        signal: [c.ebn0, c.sps, c.rolloff, c.spanAuto, c.span, c.nbits, c.diff],
        input: [c.input, c.text],
        channel: [c.noise, c.phase, c.cfo, c.timing, c.drift],
        receiver: [c.cfoMode, c.timingMode, c.eq, c.eqTaps, c.eqMain, c.eqMu, c.eqFrac, c.carrierMode, c.pilotEvery, c.frameMode, c.tBnT, c.cBnT, c.zeta]
      },
      sections: [['Fading', c.fadeOn, [c.fadeModel, c.fadeMode, c.fadeBlock, c.fdTs, c.kDb]],
        ['Multipath', c.mpOn, [c.mpPreset, c.mpSpacing, c.mpRms, c.mpFade]],
        ['Phase noise', c.pnOn, [c.pnLw]],
        ['IQ imbalance', c.iqOn, [c.iqEps, c.iqPhi, c.iqCorrect]],
        ['DC offset', c.dcOn, [c.dcRel, c.dcAng, c.dcBlockOn, c.dcPole]],
        ['ADC', c.adcOn, [c.adcBits, c.adcBackoff]]],
      sync: function (s) {
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
      }
    };
  }

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

  SDR.qpskControls = { DEFAULTS: DEFAULTS, create: create, cfgFrom: cfgFrom };
})();
