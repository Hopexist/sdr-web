/**
 * @file SDR.qpsk — the QPSK link (pure). Depends on SDR.cx, SDR.fft, SDR.filters, SDR.mapping, SDR.seq, SDR.sync,
 * SDR.channel, SDR.eq.
 * createLink(cfg, rng) → { step(nSymbols) → { done, progress, errors, bits }, finish() → result, done }: the streaming link
 * (transmitter → channel → receiver, state carried between blocks). runLink(cfg, rng) = loop over step() + finish().
 * runLinkBatch(cfg, rng): TEST-ONLY Phase 3 whole-signal receiver, kept as the bit-exactness reference.
 * buildFrame, transmit, channelList, withDefaults, textToBits, bitsToText, bitsToBytes. Config units: ebn0Db dB,
 * sps samples/symbol, rolloff, span symbols | 'auto', channel.cfoRs × Rs, timingSym symbols, driftPpm ppm, phaseDeg °;
 * rx.timingBnT / carrierBnT normalized loop bandwidths.
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var PRE_LEN = 64, TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2, PILOT = { re: Math.SQRT1_2, im: Math.SQRT1_2 };
  var TRACE_SAMPLES = 60000; // sample-rate traces (tx, rx, mf, …) keep at most this many samples

  var DEFAULTS = {
    nBits: 4000, bits: null, diff: false, sps: 8, rolloff: 0.35, span: 'auto', leadSymbols: 512,
    ebn0Db: 10, noise: true, pilotEvery: 0, blockSymbols: 256,
    channel: {
      phaseDeg: 0, cfoRs: 0, timingSym: 0, driftPpm: 0,
      fading: null,      // { model: 'rayleigh' | 'rician', mode: 'block' | 'jakes', blockSymbols, fdTs, kDb }
      multipath: null,   // { taps: [{ delay, gain }], tapFading: fdTs (0 = static) }
      phaseNoise: 0,     // linewidth Δν·Ts
      iq: null,          // { epsDb, phiDeg }
      dc: null,          // { rel (× signal RMS), angleDeg }
      adc: null          // { bits, backoffDb }
    },
    rx: {
      cfo: 'real', timing: 'real', carrier: 'real', frame: 'real', timingBnT: 0.01, carrierBnT: 0.02, zeta: 0.707,
      // carrier: 'real' (decision-directed PLL) | 'ideal' (genie phase, and amplitude under fading = ideal CSI) |
      //          'off' | 'preamble' (LS estimate from the preamble) | 'pilot' (pilot-aided, linear interpolation)
      eq: 'off', eqTaps: 11, eqMain: 5, eqMu: 0.05, eqFractional: false, eqTrainPasses: 4,   // eq: off | lms | cma | zf
      dcBlock: 0,        // DC-blocker pole (0 = off), e.g. 0.999
      iqCorrect: false
    }
  };

  function withDefaults(cfg) {
    var c = Object.assign({}, DEFAULTS, cfg);
    c.channel = Object.assign({}, DEFAULTS.channel, cfg.channel);
    c.rx = Object.assign({}, DEFAULTS.rx, cfg.rx);
    if (c.span === 'auto' || !c.span) c.span = SDR.filters.rrcAutoSpan(c.rolloff);
    return c;
  }

  function textToBits(str) {
    var bytes = new TextEncoder().encode(str), bits = new Uint8Array(bytes.length * 8);
    for (var i = 0; i < bytes.length; i++) for (var b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    return bits;
  }
  function bitsToBytes(bits) {
    var bytes = new Uint8Array(bits.length >> 3);
    for (var i = 0; i < bytes.length; i++) { var v = 0; for (var b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]; bytes[i] = v; }
    return bytes;
  }
  function bitsToText(bits) { return new TextDecoder('utf-8', { fatal: false }).decode(bitsToBytes(bits)); }

  function concat(list) {
    var n = 0, i, o = 0;
    for (i = 0; i < list.length; i++) n += list[i].re.length;
    var re = new Float64Array(n), im = new Float64Array(n);
    for (i = 0; i < list.length; i++) { re.set(list[i].re, o); im.set(list[i].im, o); o += list[i].re.length; }
    return { re: re, im: im };
  }

  function wrap(a) { a = (a + Math.PI) % TWO_PI; if (a < 0) a += TWO_PI; return a - Math.PI; }

  // Growable Float64 buffer.
  function Grow(cap) { this.a = new Float64Array(cap || 1024); this.n = 0; }
  Grow.prototype.push = function (v) {
    if (this.n === this.a.length) { var b = new Float64Array(this.n * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  };
  Grow.prototype.view = function () { return this.a.subarray(0, this.n); };
  function CGrow() { this.re = new Grow(); this.im = new Grow(); }
  CGrow.prototype.push = function (r, i) { this.re.push(r); this.im.push(i); };
  CGrow.prototype.view = function () { return { re: this.re.view(), im: this.im.view() }; };
  CGrow.prototype.pushBlock = function (x, cap) {
    for (var i = 0; i < x.re.length && this.re.n < cap; i++) this.push(x.re[i], x.im[i]);
  };

  // ---------- frame ----------
  // Same random-number order as Phase 3: payload bits, lead-in bits, tail bits.
  // Pilots (pilotEvery = P ≥ 2): payload slot i is the known pilot (1 + j)/√2 when i % P == 0, plus one
  // closing pilot after the last data symbol, so every data symbol sits between two pilots.
  function buildFrame(cfg, rng) {
    if (cfg.span === 'auto' || !cfg.span) cfg = withDefaults(cfg);
    var bits = cfg.bits ? Uint8Array.from(cfg.bits) : rng.randomBits(2 * Math.max(1, Math.round(cfg.nBits / 2)));
    if (bits.length % 2) { var b2 = new Uint8Array(bits.length + 1); b2.set(bits); bits = b2; } // pad to whole symbols
    var pre = SDR.seq.preamble(PRE_LEN), map = SDR.mapping;
    var lead = map.qpskMap(rng.randomBits(2 * cfg.leadSymbols));
    var data = cfg.diff ? map.diffEncode(bits, map.quadrant(pre.re[PRE_LEN - 1], pre.im[PRE_LEN - 1])) : map.qpskMap(bits);
    var nData = data.re.length, P = cfg.pilotEvery | 0, slots = data, mask = new Uint8Array(nData);
    if (P >= 2) {
      var sr = [], si = [], mk = [], d = 0;
      for (var i = 0; d < nData; i++) {
        if (i % P === 0) { sr.push(PILOT.re); si.push(PILOT.im); mk.push(1); } else { sr.push(data.re[d]); si.push(data.im[d]); mk.push(0); d++; }
      }
      if (!mk[mk.length - 1]) { sr.push(PILOT.re); si.push(PILOT.im); mk.push(1); }
      slots = { re: Float64Array.from(sr), im: Float64Array.from(si) }; mask = Uint8Array.from(mk);
    }
    var tail = map.qpskMap(rng.randomBits(2 * (cfg.span + 4)));      // guard: flushes filter tails past the data
    var syms = concat([lead, pre, slots, tail]);
    var nPilots = 0; for (i = 0; i < mask.length; i++) nPilots += mask[i];
    return { syms: syms, bits: bits, pay: data, nPay: nData, preStart: cfg.leadSymbols, slots: mask.length, pilotMask: mask, nPilots: nPilots };
  }

  // Batch transmitter (Phase 3 reference path).
  function transmit(cfg, rng) {
    cfg = withDefaults(cfg);   // resolves span: 'auto'
    var f = buildFrame(cfg, rng), rrc = SDR.filters.rrcTaps(cfg.rolloff, cfg.sps, cfg.span), sps = cfg.sps, nS = f.syms.re.length;
    var up = { re: new Float64Array(nS * sps + rrc.taps.length), im: new Float64Array(nS * sps + rrc.taps.length) };
    for (var i = 0; i < nS; i++) { up.re[i * sps] = f.syms.re[i]; up.im[i * sps] = f.syms.im[i]; }
    return { x: SDR.filters.firComplex(up, rrc.taps), bits: f.bits, pay: f.pay, syms: f.syms, rrc: rrc, preStart: f.preStart, nPay: f.nPay };
  }

  // Channel list in the documented order (see js/channel.js for why).
  function channelList(cfg) {
    var ch = cfg.channel, sps = cfg.sps, list = [];
    if (ch.multipath) list.push({ type: 'multipath', taps: ch.multipath.taps, tapFading: ch.multipath.tapFading || 0, sps: sps });
    // Block fading is applied per symbol before pulse shaping (createLink), so it is not in this list.
    if (ch.fading && ch.fading.mode !== 'block') list.push(Object.assign({ type: 'fading', sps: sps }, ch.fading));
    list.push({ type: 'timing', sym: ch.timingSym, sps: sps }, { type: 'drift', ppm: ch.driftPpm }, { type: 'cfo', fRs: ch.cfoRs, sps: sps });
    if (ch.phaseNoise) list.push({ type: 'phasenoise', linewidthTs: ch.phaseNoise, sps: sps });
    list.push({ type: 'phase', deg: ch.phaseDeg });
    if (cfg.noise) list.push({ type: 'awgn', ebn0Db: cfg.ebn0Db, bitsPerSymbol: 2, sps: sps });
    if (ch.iq) list.push({ type: 'iq', epsDb: ch.iq.epsDb, phiDeg: ch.iq.phiDeg });
    if (ch.dc) list.push({ type: 'dc', rel: ch.dc.rel, angleDeg: ch.dc.angleDeg, rmsRef: 1 / sps });
    if (ch.adc) list.push({ type: 'adc', bits: ch.adc.bits, backoffDb: ch.adc.backoffDb,
      nominalPower: 1 / sps + (cfg.noise ? Math.pow(10, -SDR.channel.esn0Db(cfg.ebn0Db, 2) / 10) : 0) });
    return list;
  }

  // Blind IQ-imbalance correction by Gram–Schmidt on running second-order statistics:
  //   Q₁ = Q − (E[IQ]/E[I²])·I,  Q' = Q₁·√(E[I²]/E[Q₁²]).  Averaging weight max(1/n, 2⁻¹⁶) per sample.
  function createIqCorrector() {
    var pI = 0, pQ = 0, rho = 0, n = 0;
    function coeffs() { var c = pI > 0 ? rho / pI : 0, pq1 = pQ - rho * c; return { c: c, s: pq1 > 0 ? Math.sqrt(pI / pq1) : 1 }; }
    return {
      process: function (x) {
        var L = x.re.length, yr = new Float64Array(L), yi = new Float64Array(L);
        for (var k = 0; k < L; k++) {
          var I = x.re[k], Q = x.im[k], a = Math.max(1 / ++n, 1 / 65536);
          pI += a * (I * I - pI); pQ += a * (Q * Q - pQ); rho += a * (I * Q - rho);
          var cs = coeffs();
          yr[k] = I; yi[k] = cs.s * (Q - cs.c * I);
        }
        return { re: yr, im: yi };
      },
      matrix: function () { var cs = coeffs(); return [[1, 0], [-cs.s * cs.c, cs.s]]; }
    };
  }

  // ---------- Phase 3 batch receiver (reference) ----------
  function receive(r, tx, cfg) {
    var sps = cfg.sps, D = tx.rrc.groupDelay, rx = cfg.rx, ch = cfg.channel;
    var ratio = 1 + ch.driftPpm * 1e-6, fTrue = ch.cfoRs / sps, phi = (ch.phaseDeg * Math.PI) / 180;
    function tTrue(k) { return (k * sps + D + ch.timingSym * sps) / ratio + D; }  // strobe time of symbol k (rx samples)

    // 1. Matched filter (delay D)
    var mf = SDR.filters.firComplex(r, tx.rrc.taps);

    // 2. Coarse CFO (4th power), corrected by mixing
    var fHat = 0;
    if (rx.cfo === 'ideal') fHat = fTrue;
    else if (rx.cfo === 'real') fHat = SDR.sync.cfoFourthPower(mf, { skip: 2 * D }).f;
    var cc = fHat ? SDR.cx.mixFreq(mf, -fHat, 1) : mf;

    // 3. Timing (Gardner + Farrow)
    var kp = SDR.sync.gardnerKp(cfg.rolloff, sps, cfg.span);
    var tl = rx.timing === 'ideal'
      ? SDR.sync.timingLoop(cc, { sps: sps, ideal: tTrue })
      : SDR.sync.timingLoop(cc, { sps: sps, t0: 2 * D, bnT: rx.timingBnT, zeta: rx.zeta, kp: kp });
    var K = tl.count, s = tl.y, i;

    // Genie carrier phase at each strobe: φ + 2π·f·(t − D) − 2π·f̂·t  (the MF's delay D shifts the CFO phase).
    var thTrue = new Float64Array(K);
    for (i = 0; i < K; i++) thTrue[i] = wrap(phi + TWO_PI * fTrue * (tl.t[i] - D) - TWO_PI * fHat * tl.t[i]);

    // 4. Carrier (decision-directed 2nd-order PLL on symbols, Kp = 1)
    var z, thEst = new Float64Array(K), freqEst = new Float64Array(K), cErr = new Float64Array(K);
    if (rx.carrier === 'real') {
      var p = SDR.sync.pll(s, { gains: SDR.sync.loopGains(rx.carrierBnT, rx.zeta, 1), detector: SDR.sync.qpskDD });
      z = p.y; thEst = p.phase; freqEst = p.freq; cErr = p.error;
    } else if (rx.carrier === 'ideal') {
      z = SDR.cx.zeros(K);
      for (i = 0; i < K; i++) {
        var c = Math.cos(thTrue[i]), sn = Math.sin(thTrue[i]);
        z.re[i] = s.re[i] * c + s.im[i] * sn; z.im[i] = s.im[i] * c - s.re[i] * sn;
        thEst[i] = thTrue[i];
      }
    } else z = { re: Float64Array.from(s.re), im: Float64Array.from(s.im) };   // 'off'

    // 5. Frame sync: correlate with the known preamble; its phase resolves the 4-fold ambiguity.
    var pre = SDR.seq.preamble(PRE_LEN), nc = Math.max(0, K - PRE_LEN + 1), corr = new Float64Array(nc), best = 0, bestV = -1, bestRe = 0, bestIm = 0;
    for (var m = 0; m < nc; m++) {
      var ar = 0, ai = 0;
      for (var j = 0; j < PRE_LEN; j++) {   // Σ z·conj(P)
        var zr = z.re[m + j], zi = z.im[m + j], pr = pre.re[j], pi = pre.im[j];
        ar += zr * pr + zi * pi; ai += zi * pr - zr * pi;
      }
      var mag = Math.sqrt(ar * ar + ai * ai) / PRE_LEN;
      corr[m] = mag;
      if (mag > bestV) { bestV = mag; best = m; bestRe = ar; bestIm = ai; }
    }
    var start, rot;
    if (rx.frame === 'ideal') {
      var target = tTrue(tx.preStart), bd = Infinity;
      start = 0;
      for (i = 0; i < K; i++) { var dd = Math.abs(tl.t[i] - target); if (dd < bd) { bd = dd; start = i; } }
      rot = cfg.diff ? 0 : Math.round(wrap(thTrue[start] - thEst[start]) / HALF_PI) * HALF_PI;
    } else {
      start = best;
      rot = cfg.diff ? 0 : Math.round(Math.atan2(bestIm, bestRe) / HALF_PI) * HALF_PI;
    }

    // 6. Payload, decisions, errors, EVM
    var nPay = tx.nPay, avail = Math.max(0, Math.min(nPay, K - start - PRE_LEN));
    var cr = Math.cos(rot), sr = Math.sin(rot), pay = SDR.cx.zeros(avail);
    for (i = 0; i < avail; i++) {
      var a = z.re[start + PRE_LEN + i], b = z.im[start + PRE_LEN + i];
      pay.re[i] = a * cr + b * sr; pay.im[i] = b * cr - a * sr;
    }
    var bitsRx = new Uint8Array(tx.bits.length), dec;
    if (cfg.diff) {
      var ref = { re: z.re[start + PRE_LEN - 1] || 1, im: z.im[start + PRE_LEN - 1] || 0 };
      dec = SDR.mapping.diffDecode(pay, ref);
    } else dec = SDR.mapping.qpskDemapHard(pay);
    bitsRx.set(dec.subarray(0, Math.min(dec.length, bitsRx.length)));
    var errors = 0, errPos = [];
    for (i = 0; i < tx.bits.length; i++) {
      var wrong = i >= dec.length ? true : bitsRx[i] !== tx.bits[i];   // missing symbols count as errors
      if (wrong) { errors++; if (errPos.length < 20000) errPos.push(i); }
    }

    // EVM (data-aided, best 90° rotation so differential mode is measured fairly)
    var cxr = 0, cxi = 0;
    for (i = 0; i < avail; i++) { cxr += pay.re[i] * tx.pay.re[i] + pay.im[i] * tx.pay.im[i]; cxi += pay.im[i] * tx.pay.re[i] - pay.re[i] * tx.pay.im[i]; }
    var q = Math.round(Math.atan2(cxi, cxr) / HALF_PI) * HALF_PI, cq = Math.cos(q), sq = Math.sin(q), ev = 0;
    for (i = 0; i < avail; i++) {
      var er = pay.re[i] * cq + pay.im[i] * sq - tx.pay.re[i], ei = pay.im[i] * cq - pay.re[i] * sq - tx.pay.im[i];
      ev += er * er + ei * ei;
    }
    var evm = avail ? Math.sqrt(ev / avail) : NaN;

    // Lock status (from loop error variance) and convergence time in symbols
    var tLock = rx.timing === 'real'
      ? SDR.sync.lockStatus(tl.err, { floor: Math.pow(0.03 * kp * sps, 2), lockVar: Math.pow(0.15 * kp * sps, 2) })
      : { locked: true, convergence: 0, rms: 0 };
    var cLock = rx.carrier === 'real' ? SDR.sync.lockStatus(cErr, { floor: 0.05 * 0.05, lockVar: 0.35 * 0.35 }) : { locked: true, convergence: 0, rms: 0 };

    var muEst = new Float64Array(K), muTrue = new Float64Array(K);
    for (i = 0; i < K; i++) { muEst[i] = (tl.t[i] - (i * sps + 2 * D)) / sps; muTrue[i] = (tTrue(i) - (i * sps + 2 * D)) / sps; }
    // Gardner has data-dependent self-noise even at perfect timing, so its error variance is a poor lock
    // indicator. Timing "locked" = converged and the timing estimate's jitter over the last quarter
    // (linear trend removed, so clock drift is allowed) is under 0.05 symbol.
    if (rx.timing === 'real' && K > 64) {
      var q0 = Math.floor(0.75 * K), nq = K - q0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (i = q0; i < K; i++) { var u = i - q0; sx += u; sy += muEst[i]; sxx += u * u; sxy += u * muEst[i]; }
      var slope = (nq * sxy - sx * sy) / (nq * sxx - sx * sx || 1), icpt = (sy - slope * sx) / nq, jv = 0;
      for (i = q0; i < K; i++) { var dv = muEst[i] - (icpt + slope * (i - q0)); jv += dv * dv; }
      tLock.jitterSym = Math.sqrt(jv / nq);
      tLock.locked = tLock.convergence < 0.75 * K && tLock.jitterSym < 0.05;
    }

    return {
      bitsRx: bitsRx, errors: errors, evm: evm, frameStart: start, rotation: rot, corrPeak: bestV,
      est: { cfoRs: (fHat + (rx.carrier === 'real' && K ? freqEst[K - 1] / TWO_PI / sps : 0)) * sps, fHat: fHat,
        phase: K ? wrap(thEst[Math.min(start, K - 1)] + rot) : 0, timingSym: K ? muEst[K - 1] : 0 },
      truth: { cfoRs: ch.cfoRs, phase: K ? wrap(thTrue[Math.min(start, K - 1)]) : phi, timingSym: K ? muTrue[K - 1] : 0 },
      lock: { timing: tLock, carrier: cLock },
      traces: {
        mf: mf, cfoCorrected: cc, strobes: s, strobeTimes: tl.t, carrier: z, payload: pay, decisions: dec, txPay: tx.pay,
        timingErr: tl.err, muEst: muEst, muTrue: muTrue, phaseEst: thEst, phaseTrue: thTrue,
        freqEst: freqEst, freqTrueRs: (fTrue - fHat) * sps, carrierErr: cErr, corr: corr, errorPositions: errPos, kp: kp
      }
    };
  }

  // ===================== streaming link =====================
  function createLink(cfgIn, rng) {
    var cfg = withDefaults(cfgIn || {}), sps = cfg.sps, rx = cfg.rx, ch = cfg.channel;
    var fr = buildFrame(cfg, rng);
    var rrc = SDR.filters.rrcTaps(cfg.rolloff, sps, cfg.span), D = rrc.groupDelay;
    var chain = SDR.channel.createChain(channelList(cfg), { rng: rng });
    // Quasi-static block fading: one gain per block of symbols, applied to the symbols before the RRC, so a
    // gain change between blocks causes no ISI (the matched filter sees exactly h·a at each Nyquist instant).
    var symFade = ch.fading && ch.fading.mode === 'block'
      ? SDR.channel.createFading(Object.assign({}, ch.fading, { sps: 1 }), SDR.rng.createRng((rng.uniform() * 4294967296) >>> 0)) : null;
    var mpSt = chain.stages.multipath, fadeSt = chain.stages.fading, pnSt = chain.stages.phasenoise, adcSt = chain.stages.adc, iqSt = chain.stages.iq;
    var M = mpSt ? mpSt.bulkDelay : 0;
    var txFir = SDR.filters.createUpFir(rrc.taps, sps), mf = SDR.filters.createFir(rrc.taps);
    var dcb = rx.dcBlock ? SDR.filters.createDcBlocker(rx.dcBlock) : null, iqc = rx.iqCorrect ? createIqCorrector() : null;
    var pre = SDR.seq.preamble(PRE_LEN);

    // ---- truth (genie) ----
    var ratio = 1 + ch.driftPpm * 1e-6, fTrue = ch.cfoRs / sps, phi = (ch.phaseDeg * Math.PI) / 180;
    function tTrue(k) { return (k * sps + D + M + ch.timingSym * sps) / ratio + D; }          // strobe time of symbol k
    function symOf(t) { return Math.round(((t - D) * ratio - D - M - ch.timingSym * sps) / sps); }
    var fHat = 0;
    function thetaTrue(t) {
      var th = phi + TWO_PI * fTrue * (t - D) - TWO_PI * fHat * t;
      if (pnSt) { var i = Math.max(0, Math.min(pnSt.trace.length - 1, Math.round(t - D))); th += pnSt.trace[i] || 0; }
      return wrap(th);
    }
    function hTrue(t) {
      if (symFade) return symFade.hAt(Math.max(0, symOf(t)));
      return fadeSt ? fadeSt.fading.hAt(symOf(t) * sps + D + M) : null;
    }

    // ---- traces ----
    var tr = { tx: new CGrow(), rx: new CGrow(), mf: new CGrow(), cc: new CGrow(), S: new CGrow(), Mid: new CGrow(), T: new Grow(), TE: new Grow(),
      Z: new CGrow(), th: new Grow(), thT: new Grow(), fq: new Grow(), ce: new Grow(), corr: new Grow(), mse: new Grow(),
      hT: new CGrow(), hE: new CGrow(), eqOut: new CGrow() };

    // ---- 2. coarse CFO stage (acquisition window, then mixing with the absolute sample index) ----
    var cfoReady = rx.cfo !== 'real', acq = new CGrow(), nMix = 0, ACQ = 2 * D + SDR.sync.CFO_WINDOW;
    if (rx.cfo === 'ideal') fHat = fTrue;
    function mix(x) {
      if (!fHat) { nMix += x.re.length; return x; }
      var w = TWO_PI * -fHat, L = x.re.length, yr = new Float64Array(L), yi = new Float64Array(L);
      for (var i = 0; i < L; i++) {
        var c = Math.cos(w * (nMix + i)), s = Math.sin(w * (nMix + i));
        yr[i] = x.re[i] * c - x.im[i] * s; yi[i] = x.re[i] * s + x.im[i] * c;
      }
      nMix += L;
      return { re: yr, im: yi };
    }
    function cfoStage(x, final) {
      if (cfoReady) return mix(x);
      for (var i = 0; i < x.re.length; i++) acq.push(x.re[i], x.im[i]);
      if (acq.re.n < ACQ && !final) return null;
      cfoReady = true;
      fHat = SDR.sync.cfoFourthPower(acq.view(), { skip: 2 * D }).f;
      return mix(acq.view());
    }

    // ---- back-end queue ----
    var queue = [], qLen = 0;
    function enqueue(x) { if (x && x.re.length) { queue.push(x); qLen += x.re.length; } }
    function front(x, final) {
      tr.rx.pushBlock(x, TRACE_SAMPLES);
      if (dcb) x = dcb.process(x);
      if (iqc) x = iqc.process(x);
      x = mf.process(x);
      tr.mf.pushBlock(x, TRACE_SAMPLES);
      var y = cfoStage(x, final);
      if (y) { tr.cc.pushBlock(y, TRACE_SAMPLES); enqueue(y); }
    }

    // ---- 3. timing ----
    var kp = SDR.sync.gardnerKp(cfg.rolloff, sps, cfg.span);
    var timing = SDR.sync.createTimingLoop(rx.timing === 'ideal' ? { sps: sps, ideal: tTrue } :
      { sps: sps, t0: 2 * D + M, bnT: rx.timingBnT, zeta: rx.zeta, kp: kp });

    // ---- 4. equalizer + carrier / channel estimate ----
    var eqMode = rx.eq, early = eqMode === 'lms' || rx.carrier === 'preamble' || rx.carrier === 'pilot';
    var eq = null, lat = 0;
    if (eqMode !== 'off') {
      var eo = { nTaps: rx.eqTaps, mainTap: Math.min(rx.eqMain, Math.floor((rx.eqFractional ? rx.eqTaps / 2 : rx.eqTaps) - 1)), fractional: rx.eqFractional, mu: rx.eqMu };
      if (eqMode === 'zf') eo.taps = SDR.eq.zfTaps(chanSym(0).cs, chanSym(0).cm, eo);
      eq = SDR.eq.create(eo); lat = eo.mainTap;
    }
    var pll = rx.carrier === 'real' ? SDR.sync.createPll({ gains: SDR.sync.loopGains(rx.carrierBnT, rx.zeta, 1), detector: SDR.sync.qpskDD }) : null;

    // Channel symbol-rate responses at the strobe (cs) and half a symbol earlier (cm), for timing phase δ (samples):
    // end-to-end RRC ⊗ multipath ⊗ RRC, sampled at the path-0 peak + δ + n·sps.
    function chanSym(delta) {
      var h = mpSt ? mpSt.impulse() : { re: Float64Array.from([1]), im: new Float64Array(1) }, off = mpSt ? 0 : M;
      var g = SDR.dsp.convolve(rrc.taps, rrc.taps, 'full'), er = SDR.dsp.convolve(h.re, g, 'full'), ei = SDR.dsp.convolve(h.im, g, 'full');
      var P0 = 2 * D + M - off, L = Math.ceil(er.length / sps) + 1;
      function at(t) { var i = Math.floor(t), f = t - i; function v(a, k) { return k >= 0 && k < a.length ? a[k] : 0; } return [v(er, i) * (1 - f) + v(er, i + 1) * f, v(ei, i) * (1 - f) + v(ei, i + 1) * f]; }
      var cs = { re: new Float64Array(L), im: new Float64Array(L) }, cm = { re: new Float64Array(L), im: new Float64Array(L) };
      for (var n = 0; n < L; n++) { var a = at(P0 + delta + n * sps), b = at(P0 + delta + n * sps - sps / 2); cs.re[n] = a[0]; cs.im[n] = a[1]; cm.re[n] = b[0]; cm.im[n] = b[1]; }
      return { cs: cs, cm: cm };
    }

    // Per-strobe state
    var K = 0, scan = 0, start = -1, startC = null, rot = 0, bestM = -1, bestV = -1, bestC = null;
    var winE = 0;     // energy of the 64-symbol correlation window
    var nSlots = fr.slots, mask = fr.pilotMask, bitsRx = new Uint8Array(fr.bits.length), decided = 0, dataIdx = 0, errors = 0, errPos = [];
    var payR = new Grow(), payI = new Grow(), prevQ = 0, pend = [], lastPilot = null;
    var trained = false;

    // Correlation metric at window start m over a symbol stream (re/im arrays), normalized to [0, 1].
    function corrAt(sr, si, m) {
      var ar = 0, ai = 0, e = 0;
      for (var j = 0; j < PRE_LEN; j++) {
        var zr = sr[m + j], zi = si[m + j], pr = pre.re[j], pi = pre.im[j];
        ar += zr * pr + zi * pi; ai += zi * pr - zr * pi; e += zr * zr + zi * zi;
      }
      return { re: ar, im: ai, v: Math.sqrt(ar * ar + ai * ai) / Math.sqrt(PRE_LEN * Math.max(e, 1e-30)) };
    }
    // Frame-start detection on a stream: real = best normalized correlation, confirmed once 64 later
    // windows have not beaten it (≥ 0.5); ideal = the strobe closest to the preamble's true time.
    function detect(stream, n, final) {
      if (start >= 0) return;
      var sv = stream.view();
      if (rx.frame === 'ideal') {
        var target = tTrue(fr.preStart), T = tr.T.view();
        for (var k = Math.max(1, scan); k < n; k++) {
          if (T[k] >= target) { start = Math.abs(T[k - 1] - target) <= Math.abs(T[k] - target) ? k - 1 : k; break; }
        }
        scan = Math.max(scan, n);
        if (start < 0 && final && n) start = n - 1;
        if (start >= 0 && start + PRE_LEN <= n) startC = corrAt(sv.re, sv.im, start);
        else if (start >= 0) startC = { re: 1, im: 0, v: 1 };
        return;
      }
      for (var m = Math.max(0, tr.corr.n); m + PRE_LEN <= n; m++) {
        var c = corrAt(sv.re, sv.im, m);
        tr.corr.push(c.v);
        if (c.v > bestV) { bestV = c.v; bestM = m; bestC = c; }
        if (bestV >= 0.5 && m - bestM >= PRE_LEN) { start = bestM; startC = bestC; return; }
      }
      if (final && bestM >= 0) { start = bestM; startC = bestC; }
    }

    function decide(r, i) { return { re: r >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2, im: i >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2 }; }

    // Payload slot q (0…) has carrier-corrected symbol (wr, wi): pilots skipped, data decided.
    function takeData(wr, wi) {
      var i = dataIdx++;
      payR.push(wr); payI.push(wi);
      var b0, b1;
      if (cfg.diff) {
        var q = SDR.mapping.quadrant(wr, wi), d = [[0, 0], [0, 1], [1, 1], [1, 0]][(q - prevQ) & 3];
        b0 = d[0]; b1 = d[1]; prevQ = q;
      } else { b0 = wr < 0 ? 1 : 0; b1 = wi < 0 ? 1 : 0; }
      if (2 * i + 1 < bitsRx.length) {
        bitsRx[2 * i] = b0; bitsRx[2 * i + 1] = b1; decided = 2 * i + 2;
        if (b0 !== fr.bits[2 * i]) { errors++; if (errPos.length < 20000) errPos.push(2 * i); }
        if (b1 !== fr.bits[2 * i + 1]) { errors++; if (errPos.length < 20000) errPos.push(2 * i + 1); }
      }
    }
    // Pilot-aided: hold data until the next pilot, then divide by the linearly interpolated estimate.
    function payloadSlot(q, wr, wi) {
      if (q >= nSlots) return;
      if (rx.carrier !== 'pilot') { if (!mask[q]) takeData(wr, wi); return; }
      if (!mask[q]) { pend.push([q, wr, wi]); return; }
      var hp = { re: (wr * PILOT.re + wi * PILOT.im), im: (wi * PILOT.re - wr * PILOT.im) }; // y·conj(p)/|p|²
      var a = lastPilot || { q: q, h: hp };
      pend.forEach(function (p) {
        var f = (p[0] - a.q) / Math.max(1, q - a.q), hr = a.h.re + (hp.re - a.h.re) * f, hi = a.h.im + (hp.im - a.h.im) * f, d = hr * hr + hi * hi || 1e-30;
        tr.hE.re.a[p[3]] = hr; tr.hE.im.a[p[3]] = hi;
        takeData((p[1] * hr + p[2] * hi) / d, (p[2] * hr - p[1] * hi) / d);
      });
      pend = []; lastPilot = { q: q, h: hp };
    }

    // Late pipeline (Phase 3 order): [EQ] → carrier (PLL | genie | off) → frame sync → payload.
    function lateSymbol(k) {
      var S = tr.S, xr = S.re.a[k], xi = S.im.a[k], j = k, mseVal = NaN;
      if (eq) {
        eq.push(xr, xi, tr.Mid.re.a[k], tr.Mid.im.a[k]);
        if (k < lat) return;
        j = k - lat;
        var z = eq.output(); xr = z.re; xi = z.im;
        tr.eqOut.push(xr, xi);
        if (eqMode === 'cma') mseVal = eq.adaptCma(xr, xi);
      }
      var t = tr.T.a[j], wr = xr, wi = xi, th = 0, thT = thetaTrue(t);
      if (pll) {
        var r = pll.step(xr, xi); wr = r.zr; wi = r.zi; th = r.theta;
        tr.fq.push(r.v); tr.ce.push(r.e);
      } else if (rx.carrier === 'ideal') {
        var h = hTrue(t);
        if (h) {   // ideal CSI: divide by h·e^{jθ}
          var gr = h.re * Math.cos(thT) - h.im * Math.sin(thT), gi = h.re * Math.sin(thT) + h.im * Math.cos(thT), d = gr * gr + gi * gi || 1e-30;
          wr = (xr * gr + xi * gi) / d; wi = (xi * gr - xr * gi) / d; tr.hE.push(gr, gi);
        } else {
          var c = Math.cos(thT), s = Math.sin(thT);
          wr = xr * c + xi * s; wi = xi * c - xr * s;
        }
        th = thT;
      }
      if (!pll) { tr.fq.push(0); tr.ce.push(0); }
      if (eqMode === 'zf') { var dz = decide(wr, wi); mseVal = (wr - dz.re) * (wr - dz.re) + (wi - dz.im) * (wi - dz.im); }
      if (eq) tr.mse.push(mseVal);
      if (!(rx.carrier === 'ideal' && hTrue(t))) tr.hE.push(NaN, NaN);
      tr.Z.push(wr, wi); tr.th.push(th); tr.thT.push(thT);
      var hh = hTrue(t); if (hh) tr.hT.push(hh.re, hh.im); else tr.hT.push(NaN, NaN);
    }

    function lateFrame(final) {
      detect(tr.Z, tr.Z.re.n, final);
      if (start < 0) return;
      if (!trained) {   // rotation from the correlation phase (or the genie)
        trained = true;
        if (rx.frame === 'ideal') rot = cfg.diff ? 0 : Math.round(wrap(tr.thT.a[start] - tr.th.a[start]) / HALF_PI) * HALF_PI;
        else rot = cfg.diff ? 0 : Math.round(Math.atan2(startC.im, startC.re) / HALF_PI) * HALF_PI;
        var zr = tr.Z.re.a[start + PRE_LEN - 1] || 1, zi = tr.Z.im.a[start + PRE_LEN - 1] || 0;
        prevQ = SDR.mapping.quadrant(zr, zi);
      }
      var cr = Math.cos(rot), sr = Math.sin(rot), n = tr.Z.re.n;
      while (start + PRE_LEN + kSlot < n && kSlot < nSlots) {
        var a = tr.Z.re.a[start + PRE_LEN + kSlot], b = tr.Z.im.a[start + PRE_LEN + kSlot];
        payloadSlot(kSlot, a * cr + b * sr, b * cr - a * sr);
        kSlot++;
      }
    }
    var kSlot = 0;

    // Early pipeline: frame sync on the timing output first; then (from the preamble on)
    // EQ (LMS trains on the preamble) → carrier / channel estimate → payload.
    var jE = 0, hLs = null;
    function earlyRun(final) {
      var n = tr.S.re.n;
      detect(tr.S, n, final);
      if (start < 0) {
        for (; jE < n - (final ? 0 : 2 * PRE_LEN); jE++) { tr.Z.push(tr.S.re.a[jE], tr.S.im.a[jE]); pushPad(); }   // display only
        return;
      }
      if (!trained) {
        trained = true;
        for (; jE < start; jE++) { tr.Z.push(tr.S.re.a[jE], tr.S.im.a[jE]); pushPad(); }
        hLs = { re: startC.re / PRE_LEN, im: startC.im / PRE_LEN };   // LS: Σ y·conj(P)/Σ|P|²
        if (pll && !eq) pll.state.theta = Math.atan2(startC.im, startC.re);
        if (eq && eqMode === 'lms') {   // extra passes over the stored preamble (training only)
          for (var p = 0; p < rx.eqTrainPasses - 1 && start + PRE_LEN + lat <= n; p++) {
            primeEq(start);
            for (var i = 0; i < PRE_LEN; i++) {
              var kk = start + i + lat; eq.push(tr.S.re.a[kk], tr.S.im.a[kk], tr.Mid.re.a[kk], tr.Mid.im.a[kk]);
              var z0 = eq.output(); eq.adapt(pre.re[i] - z0.re, pre.im[i] - z0.im);
            }
          }
        }
        if (eq) primeEq(start);
        prevQ = SDR.mapping.quadrant(pre.re[PRE_LEN - 1], pre.im[PRE_LEN - 1]);
      }
      for (; jE + lat < n; jE++) earlySymbol(jE);
    }
    function pushPad() { tr.th.push(0); tr.thT.push(thetaTrue(tr.T.a[tr.Z.re.n - 1] || 0)); tr.fq.push(0); tr.ce.push(0); tr.hE.push(NaN, NaN); var h = hTrue(tr.T.a[tr.Z.re.n - 1] || 0); if (h) tr.hT.push(h.re, h.im); else tr.hT.push(NaN, NaN); }
    function primeEq(s) {   // refill the regressor with the inputs preceding output s
      var nSym = Math.ceil(rx.eqTaps / (rx.eqFractional ? 2 : 1));
      for (var i = s + lat - nSym; i < s + lat; i++) { var k = Math.max(0, i); eq.push(tr.S.re.a[k], tr.S.im.a[k], tr.Mid.re.a[k], tr.Mid.im.a[k]); }
    }
    function earlySymbol(j) {
      var xr = tr.S.re.a[j], xi = tr.S.im.a[j], q = j - start - PRE_LEN, inPre = j - start < PRE_LEN, t = tr.T.a[j];
      var dr, di, z;
      if (eq) { var kk = j + lat; eq.push(tr.S.re.a[kk], tr.S.im.a[kk], tr.Mid.re.a[kk], tr.Mid.im.a[kk]); z = eq.output(); xr = z.re; xi = z.im; tr.eqOut.push(xr, xi); }
      var wr = xr, wi = xi, th = 0, mse = NaN;
      if (pll) {
        var r = pll.rotate(xr, xi); wr = r.zr; wi = r.zi; th = r.theta;
        var d = inPre ? { re: pre.re[j - start], im: pre.im[j - start] } : (q >= 0 && q < nSlots && mask[q] ? PILOT : decide(wr, wi));
        var e = Math.atan2(wi * d.re - wr * d.im, wr * d.re + wi * d.im);
        if (eq && eqMode === 'lms') {   // joint: equalizer error measured against the rotated decision
          var c = Math.cos(th), s = Math.sin(th); dr = d.re * c - d.im * s; di = d.re * s + d.im * c;
          eq.adapt(dr - xr, di - xi); mse = (dr - xr) * (dr - xr) + (di - xi) * (di - xi);
        }
        pll.update(e); tr.fq.push(r.v); tr.ce.push(e);
      } else {
        if (eq && eqMode === 'lms') {
          var d2 = inPre ? { re: pre.re[j - start], im: pre.im[j - start] } : (q >= 0 && q < nSlots && mask[q] ? PILOT : decide(xr, xi));
          eq.adapt(d2.re - xr, d2.im - xi); mse = (d2.re - xr) * (d2.re - xr) + (d2.im - xi) * (d2.im - xi);
        } else if (eq && eqMode === 'cma') mse = eq.adaptCma(xr, xi);
        if (!eq && rx.carrier === 'preamble') {
          var hd = hLs.re * hLs.re + hLs.im * hLs.im || 1e-30;
          wr = (xr * hLs.re + xi * hLs.im) / hd; wi = (xi * hLs.re - xr * hLs.im) / hd; tr.hE.push(hLs.re, hLs.im);
        } else if (!eq && rx.carrier === 'ideal') {
          var h = hTrue(t) || { re: 1, im: 0 }, thT = thetaTrue(t);
          var gr = h.re * Math.cos(thT) - h.im * Math.sin(thT), gi = h.re * Math.sin(thT) + h.im * Math.cos(thT), dd = gr * gr + gi * gi || 1e-30;
          wr = (xr * gr + xi * gi) / dd; wi = (xi * gr - xr * gi) / dd; tr.hE.push(gr, gi);
        } else tr.hE.push(NaN, NaN);
        tr.fq.push(0); tr.ce.push(0);
      }
      if (pll || rx.carrier === 'pilot') { if (pll) tr.hE.push(NaN, NaN); }
      tr.mse.push(mse);
      tr.Z.push(wr, wi); tr.th.push(th); tr.thT.push(thetaTrue(t));
      var hh = hTrue(t); if (hh) tr.hT.push(hh.re, hh.im); else tr.hT.push(NaN, NaN);
      if (q >= 0) payloadSlotEarly(q, wr, wi, tr.Z.re.n - 1);
    }
    function payloadSlotEarly(q, wr, wi, zIdx) {
      if (q >= nSlots) return;
      if (rx.carrier === 'pilot') {
        if (!mask[q]) { pend.push([q, wr, wi, zIdx]); return; }
        payloadSlot(q, wr, wi);
        return;
      }
      if (!mask[q]) takeData(wr, wi);
    }

    function backend(y) {
      var r = y ? timing.process(y) : timing.finish();
      for (var i = 0; i < r.count; i++) {
        tr.S.push(r.y.re[i], r.y.im[i]); tr.Mid.push(r.m.re[i], r.m.im[i]); tr.T.push(r.t[i]); tr.TE.push(r.err[i]);
        K++;
        if (!early) lateSymbol(K - 1);
      }
      if (early) earlyRun(!y); else lateFrame(!y);
    }

    // ---- stepping ----
    var nSym = fr.syms.re.length, symPtr = 0, flushed = false, done = false, sampleBudgetFactor = 2;
    function step(n) {
      n = n || cfg.blockSymbols;
      if (symPtr < nSym) {
        var m = Math.min(n, nSym - symPtr), blk = { re: fr.syms.re.subarray(symPtr, symPtr + m), im: fr.syms.im.subarray(symPtr, symPtr + m) };
        if (symFade) {
          var fb = { re: new Float64Array(m), im: new Float64Array(m) };
          for (var q = 0; q < m; q++) { var h = symFade.hAt(symPtr + q), a = blk.re[q], b = blk.im[q]; fb.re[q] = a * h.re - b * h.im; fb.im[q] = a * h.im + b * h.re; }
          blk = fb;
        }
        symPtr += m;
        var x = txFir.process(blk);
        tr.tx.pushBlock(x, TRACE_SAMPLES);
        front(chain.process(x), false);
      } else if (!flushed) {
        flushed = true;
        var H = Math.ceil(rrc.taps.length / sps), z = txFir.process({ re: new Float64Array(H), im: new Float64Array(H) });
        var tail = { re: z.re.subarray(0, rrc.taps.length), im: z.im.subarray(0, rrc.taps.length) };
        tr.tx.pushBlock(tail, TRACE_SAMPLES);
        front(chain.process(tail), false);
        var fl = chain.flush();
        if (fl.re.length) front(fl, false);
        front({ re: new Float64Array(0), im: new Float64Array(0) }, true);
      }
      var budget = n * sps * sampleBudgetFactor;
      while (qLen && budget > 0) {
        var b = queue[0];
        if (b.re.length > budget) {   // split
          queue[0] = { re: b.re.subarray(budget), im: b.im.subarray(budget) };
          b = { re: b.re.subarray(0, budget), im: b.im.subarray(0, budget) };
        } else queue.shift();
        qLen -= b.re.length; budget -= b.re.length;
        backend(b);
      }
      if (flushed && !qLen && !done) { backend(null); done = true; }
      return { done: done, progress: done ? 1 : 0.95 * symPtr / nSym + (flushed ? 0.05 : 0), errors: errors, bits: decided };
    }

    function finish() {
      while (!done) step(cfg.blockSymbols);
      return result();
    }

    function result() {
      var Kn = tr.S.re.n, i;
      // EVM (data-aided, best 90° rotation so differential mode is measured fairly)
      var pr = payR.view(), pi = payI.view(), avail = pr.length, cxr = 0, cxi = 0;
      for (i = 0; i < avail; i++) { cxr += pr[i] * fr.pay.re[i] + pi[i] * fr.pay.im[i]; cxi += pi[i] * fr.pay.re[i] - pr[i] * fr.pay.im[i]; }
      var q = Math.round(Math.atan2(cxi, cxr) / HALF_PI) * HALF_PI, cq = Math.cos(q), sq = Math.sin(q), ev = 0;
      for (i = 0; i < avail; i++) {
        var er = pr[i] * cq + pi[i] * sq - fr.pay.re[i], ei = pi[i] * cq - pr[i] * sq - fr.pay.im[i];
        ev += er * er + ei * ei;
      }
      var evm = avail ? Math.sqrt(ev / avail) : NaN;
      for (i = decided; i < fr.bits.length; i++) { errors++; if (errPos.length < 20000) errPos.push(i); }   // missing = errors

      var T = tr.T.view(), TE = tr.TE.view();
      var tLock = rx.timing === 'real' ? SDR.sync.lockStatus(TE, { floor: Math.pow(0.03 * kp * sps, 2), lockVar: Math.pow(0.15 * kp * sps, 2) }) : { locked: true, convergence: 0, rms: 0 };
      var CE = tr.ce.view();
      var cLock = pll ? SDR.sync.lockStatus(CE, { floor: 0.05 * 0.05, lockVar: 0.35 * 0.35 }) : { locked: true, convergence: 0, rms: 0 };
      var muEst = new Float64Array(Kn), muTrue = new Float64Array(Kn);
      for (i = 0; i < Kn; i++) { muEst[i] = (T[i] - (i * sps + 2 * D + M)) / sps; muTrue[i] = (tTrue(i) - (i * sps + 2 * D + M)) / sps; }
      if (rx.timing === 'real' && Kn > 64) {   // timing lock = converged + low jitter of the detrended estimate
        var q0 = Math.floor(0.75 * Kn), nq = Kn - q0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (i = q0; i < Kn; i++) { var u = i - q0; sx += u; sy += muEst[i]; sxx += u * u; sxy += u * muEst[i]; }
        var slope = (nq * sxy - sx * sy) / (nq * sxx - sx * sx || 1), icpt = (sy - slope * sx) / nq, jv = 0;
        for (i = q0; i < Kn; i++) { var dv = muEst[i] - (icpt + slope * (i - q0)); jv += dv * dv; }
        tLock.jitterSym = Math.sqrt(jv / nq);
        tLock.locked = tLock.convergence < 0.75 * Kn && tLock.jitterSym < 0.05;
      }
      // Equalizer convergence: first output after which the smoothed MSE stays below 2·final + 0.01.
      var mse = tr.mse.view(), eqInfo = null;
      if (eq) {
        var sm = new Float64Array(mse.length), acc = 0, cnt = 0, fin, conv = 0;
        for (i = 0; i < mse.length; i++) { var v = isFinite(mse[i]) ? mse[i] : 0; acc = cnt ? 0.97 * acc + 0.03 * v : v; cnt++; sm[i] = acc; }
        fin = mse.length ? sm[mse.length - 1] : NaN;
        for (i = mse.length - 1; i >= 0; i--) if (sm[i] > 2 * fin + 0.01) { conv = i + 1; break; }   // floor: MSE ≤ −20 dB counts as converged
        var delta = rx.timing === 'ideal' ? 0 : (Kn ? (T[Kn - 1] - tTrue(symOf(T[Kn - 1]))) : 0);
        var resp = chanSym(delta), qResp = SDR.eq.combined(eq.taps, resp.cs, resp.cm, eq.fractional);
        eqInfo = { mseDb: 10 * Math.log10(fin), convergence: conv, taps: eq.taps, combined: qResp, channelSym: resp, fractional: eq.fractional, latency: lat };
      }
      var chStats = { };
      if (adcSt) chStats.adc = adcSt.stats();
      if (iqSt) {
        var before = SDR.channel.irrDb(iqSt.coeffs), after = before;
        if (iqc) after = SDR.channel.irrDb(SDR.channel.matrixToIq(mul2(iqc.matrix(), SDR.channel.iqToMatrix(iqSt.coeffs))));
        chStats.iq = { irrBeforeDb: before, irrAfterDb: after };
      }
      if (mpSt) chStats.multipath = { impulse: mpSt.impulse(), taps: mpSt.taps, bulkDelay: M };
      var thEst = tr.th.view(), thT = tr.thT.view(), fq = tr.fq.view(), st = Math.max(0, start), sIdx = Math.min(st, thEst.length - 1);
      var out = {
        bitsTx: fr.bits, bitsRx: bitsRx, errors: errors, ber: fr.bits.length ? errors / fr.bits.length : 0,
        evm: evm, evmDb: 20 * Math.log10(evm), esn0EstDb: -20 * Math.log10(evm),
        frameStart: start, rotation: rot, corrPeak: start >= 0 && startC ? startC.v : bestV,
        est: { cfoRs: (fHat + (pll && fq.length ? fq[fq.length - 1] / TWO_PI / sps : 0)) * sps, fHat: fHat,
          phase: thEst.length ? wrap(thEst[sIdx] + rot) : 0, timingSym: Kn ? muEst[Kn - 1] : 0 },
        truth: { cfoRs: ch.cfoRs, phase: thT.length ? wrap(thT[sIdx]) : phi, timingSym: Kn ? muTrue[Kn - 1] : 0 },
        lock: { timing: tLock, carrier: cLock },
        eq: eqInfo, channel: chStats,
        pilots: { count: fr.nPilots, overhead: fr.slots ? fr.nPilots / fr.slots : 0, efficiency: fr.nPay / fr.syms.re.length },
        traces: {
          tx: tr.tx.view(), rx: tr.rx.view(), mf: tr.mf.view(), cfoCorrected: tr.cc.view(), strobes: tr.S.view(), mids: tr.Mid.view(), strobeTimes: T,
          eqOut: tr.eqOut.view(), eqMse: mse, carrier: tr.Z.view(), payload: { re: pr, im: pi }, txPay: fr.pay,
          timingErr: TE, muEst: muEst, muTrue: muTrue, phaseEst: thEst, phaseTrue: thT, freqEst: fq, freqTrueRs: (fTrue - fHat) * sps,
          carrierErr: CE, corr: tr.corr.view(), errorPositions: errPos, kp: kp, hTrue: tr.hT.view(), hEst: tr.hE.view(),
          phaseNoise: pnSt ? pnSt.trace : null
        },
        cfg: cfg
      };
      return out;
    }

    return { step: step, finish: finish, cfg: cfg, get done() { return done; } };
  }

  function mul2(A, B) { return [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]], [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]]; }

  // The whole link: cfg (see DEFAULTS) + rng → result. A loop over step(); the BER page calls this same function.
  function runLink(cfgIn, rng) {
    var link = createLink(cfgIn, rng), n = (cfgIn && cfgIn.blockSymbols) || DEFAULTS.blockSymbols;
    while (!link.done) link.step(n);
    return link.finish();
  }

  // TEST-ONLY: Phase 3 whole-signal link, kept as the reference for the streaming bit-exactness test.
  // No page calls it; use createLink / runLink.
  function runLinkBatch(cfgIn, rng) {
    var cfg = withDefaults(cfgIn || {});
    var tx = transmit(cfg, rng);
    var r = SDR.channel.apply(tx.x, channelList(cfg), rng);
    var out = receive(r, tx, cfg);
    out.bitsTx = tx.bits;
    out.ber = tx.bits.length ? out.errors / tx.bits.length : 0;
    out.cfg = cfg;
    return out;
  }

  SDR.qpsk = { DEFAULTS: DEFAULTS, runLink: runLink, createLink: createLink, runLinkBatch: runLinkBatch, transmit: transmit, buildFrame: buildFrame,
    receive: receive, channelList: channelList, withDefaults: withDefaults,
    textToBits: textToBits, bitsToText: bitsToText, bitsToBytes: bitsToBytes, PRE_LEN: PRE_LEN, PILOT: PILOT };
})();
