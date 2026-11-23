// SDR.qpsk — QPSK transmitter, receiver and the whole link as one pure function. No DOM.
// Depends on: SDR.cx, SDR.fft, SDR.filters, SDR.mapping, SDR.seq, SDR.sync, SDR.channel
//
// Conventions: symbols (±1 ± j)/√2 (Es = 1); RRC taps unit energy; complex AWGN per sample with variance
// N0 = 1/(Es/N0). Frame on air: [lead-in | 64-symbol preamble | payload | tail]. The lead-in is random,
// unknown to the receiver, and gives the timing and carrier loops time to lock before the preamble.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var PRE_LEN = 64, TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2;

  var DEFAULTS = {
    nBits: 4000, bits: null, diff: false, sps: 8, rolloff: 0.35, span: 10, leadSymbols: 512,
    ebn0Db: 10, noise: true,
    channel: { phaseDeg: 0, cfoRs: 0, timingSym: 0, driftPpm: 0 },
    rx: { cfo: 'real', timing: 'real', carrier: 'real', frame: 'real', timingBnT: 0.01, carrierBnT: 0.02, zeta: 0.707 }
  };

  function withDefaults(cfg) {
    var c = Object.assign({}, DEFAULTS, cfg);
    c.channel = Object.assign({}, DEFAULTS.channel, cfg.channel);
    c.rx = Object.assign({}, DEFAULTS.rx, cfg.rx);
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

  // ---------- transmitter ----------
  function transmit(cfg, rng) {
    var bits = cfg.bits ? Uint8Array.from(cfg.bits) : rng.randomBits(2 * Math.max(1, Math.round(cfg.nBits / 2)));
    if (bits.length % 2) { var b2 = new Uint8Array(bits.length + 1); b2.set(bits); bits = b2; } // pad to whole symbols
    var pre = SDR.seq.preamble(PRE_LEN), map = SDR.mapping;
    var lead = map.qpskMap(rng.randomBits(2 * cfg.leadSymbols));
    var pay = cfg.diff ? map.diffEncode(bits, map.quadrant(pre.re[PRE_LEN - 1], pre.im[PRE_LEN - 1])) : map.qpskMap(bits);
    var tail = map.qpskMap(rng.randomBits(2 * (cfg.span + 4)));       // guard: flushes filter tails past the data
    var syms = concat([lead, pre, pay, tail]);
    var rrc = SDR.filters.rrcTaps(cfg.rolloff, cfg.sps, cfg.span), sps = cfg.sps, nS = syms.re.length;
    var up = { re: new Float64Array(nS * sps + rrc.taps.length), im: new Float64Array(nS * sps + rrc.taps.length) };
    for (var i = 0; i < nS; i++) { up.re[i * sps] = syms.re[i]; up.im[i * sps] = syms.im[i]; }
    return { x: SDR.filters.firComplex(up, rrc.taps), bits: bits, pay: pay, syms: syms, rrc: rrc,
      preStart: cfg.leadSymbols, nPay: pay.re.length };
  }

  function channelList(cfg) {
    var ch = cfg.channel, sps = cfg.sps, list = [
      { type: 'timing', sym: ch.timingSym, sps: sps },
      { type: 'drift', ppm: ch.driftPpm },
      { type: 'cfo', fRs: ch.cfoRs, sps: sps },
      { type: 'phase', deg: ch.phaseDeg }
    ];
    if (cfg.noise) list.push({ type: 'awgn', ebn0Db: cfg.ebn0Db, bitsPerSymbol: 2, sps: sps });
    return list;
  }

  function wrap(a) { a = (a + Math.PI) % TWO_PI; if (a < 0) a += TWO_PI; return a - Math.PI; }

  // ---------- receiver ----------
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

  // The whole link: cfg (see DEFAULTS) + rng → result. The BER page calls this same function.
  function runLink(cfgIn, rng) {
    var cfg = withDefaults(cfgIn || {});
    var tx = transmit(cfg, rng);
    var r = SDR.channel.apply(tx.x, channelList(cfg), rng);
    var out = receive(r, tx, cfg);
    out.bitsTx = tx.bits;
    out.ber = tx.bits.length ? out.errors / tx.bits.length : 0;
    out.evmDb = 20 * Math.log10(out.evm);
    out.esn0EstDb = -out.evmDb;                // EVM² ≈ N0/Es for a well-synchronized link
    out.traces.tx = tx.x;
    out.traces.rx = r;
    out.cfg = cfg;
    return out;
  }

  SDR.qpsk = { DEFAULTS: DEFAULTS, runLink: runLink, transmit: transmit, receive: receive, channelList: channelList,
    textToBits: textToBits, bitsToText: bitsToText, bitsToBytes: bitsToBytes, PRE_LEN: PRE_LEN };
})();
