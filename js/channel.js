/**
 * @file SDR.channel — channel impairments as streaming stages (pure). Depends on SDR.cx, SDR.filters, SDR.rng.
 * Conventions: symbols Es = 1, unit-energy pulses; esn0Db(ebn0Db, bitsPerSymbol), snrPerSampleDb(ebn0Db, bps, sps)
 * = Es/N0 − 10·log10(sps); addAwgnEbN0(x, ebn0Db, { bitsPerSymbol }, rng) adds complex noise of variance N0 per sample;
 * addAwgnCnr(x, cnrDb, bwHz, fsHz, rng, { refPower }) (analog pages); phaseOffset(x, rad); freqOffset(x, f, fs).
 * Stages (createChain(list, { rng }) → { process, flush, stages }, apply(x, list, rng) batch):
 * multipath { taps: [{ delay symbols, gain }], tapFading fd·Ts, sps }, fading { model rayleigh|rician, mode block|jakes,
 * blockSymbols, fdTs (Doppler × symbol time), kDb, sps }, timing { sym, sps }, drift { ppm }, cfo { fRs (× symbol rate), sps },
 * phasenoise { linewidthTs (Δν·Ts), sps }, phase { deg }, awgn { ebn0Db, bitsPerSymbol, sps }, cnr, iq { epsDb, phiDeg },
 * dc { rel (× RMS), angleDeg, rmsRef (power) }, adc { bits, backoffDb (from full-scale sine), nominalPower }.
 * Also createFading, multipathPresets(name, { spacing, rmsDelay }), iqCoeffs, irrDb.
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var TWO_PI = 2 * Math.PI;

  // ---------- batch helpers (AM/FM, tests) ----------
  // Adds complex AWGN so that refPower / (noise power inside `bw` Hz) = cnrDb.
  // White complex noise of total variance σ² over fs puts σ²·bw/fs inside bw.
  function addAwgnCnr(x, cnrDb, bw, fs, rng, opts) {
    var ref = opts && opts.refPower !== undefined ? opts.refPower : SDR.cx.power(x);
    var variance = (ref / Math.pow(10, cnrDb / 10)) * (fs / bw);
    return SDR.cx.add(x, rng.randnComplex(x.re.length, variance));
  }
  function phaseOffset(x, phaseRad) { return SDR.cx.rotate(x, phaseRad); }
  function freqOffset(x, f, fs) { return f ? SDR.cx.mixFreq(x, f, fs) : x; }

  // ---- Digital-link conventions: symbols with Es = 1, unit-energy pulses (Σg² = 1) ----
  // Complex AWGN of variance N0 = 1/(Es/N0) per sample gives Es/N0 per symbol after the matched filter;
  // the per-sample SNR is Es/N0 / sps. The one place these conversions live:
  function esn0Db(ebn0Db, bitsPerSymbol) { return ebn0Db + 10 * Math.log10(bitsPerSymbol || 2); }
  function snrPerSampleDb(ebn0Db, bitsPerSymbol, sps) { return esn0Db(ebn0Db, bitsPerSymbol) - 10 * Math.log10(sps); }
  function addAwgnEbN0(x, ebn0Db, o, rng) {
    var N0 = Math.pow(10, -esn0Db(ebn0Db, o && o.bitsPerSymbol) / 10);
    return SDR.cx.add(x, rng.randnComplex(x.re.length, N0));
  }

  function mapBlock(x, f) {   // f(re, im, n) → sets out via this.re / this.im
    var L = x.re.length, yr = new Float64Array(L), yi = new Float64Array(L), o = { re: 0, im: 0 };
    for (var n = 0; n < L; n++) { f(x.re[n], x.im[n], n, o); yr[n] = o.re; yi[n] = o.im; }
    return { re: yr, im: yi };
  }

  // ---------- fading ----------
  // Flat fading gain h at any sample index n (sps samples per symbol), E|h|² = 1.
  //  Rayleigh block: h ~ CN(0, 1) redrawn every blockSymbols symbols (0 = one per frame). A redraw is an
  //    instant jump, so pulse tails straddling a block edge see two gains (real ISI from a jumping channel).
  //  Rayleigh Jakes/Clarke: sum of N_OSC sinusoids with random arrival angles and phases,
  //    h(t) = (1/√N)·Σ e^{j(2π·fdTs·t·cos αₙ + φₙ)}, t in symbols; evaluated on the symbol grid and
  //    interpolated linearly in between (fd·Ts ≤ 1e-2, so h barely moves within a symbol).
  //  Rician: h = √(K/(K+1)) + √(1/(K+1))·h_scatter (LOS phase 0, total power 1).
  var N_OSC = 64;
  function createFading(o, rng) {
    var sps = o.sps || 1, K = o.model === 'rician' ? Math.pow(10, (o.kDb || 0) / 10) : 0;
    var los = Math.sqrt(K / (K + 1)), sc = Math.sqrt(1 / (K + 1));
    var blocks = [], grid = [], w = [], ph = [], i;
    if (o.mode !== 'block') {
      for (i = 0; i < N_OSC; i++) { w.push(TWO_PI * o.fdTs * Math.cos(TWO_PI * rng.uniform())); ph.push(TWO_PI * rng.uniform()); }
    }
    var amp = 1 / Math.sqrt(N_OSC);
    function gridAt(k) {   // scattered component at symbol time k (memoized, computed in order)
      while (grid.length / 2 <= k) {   // two numbers (re, im) per symbol
        var t = grid.length / 2, re = 0, im = 0;
        for (var m = 0; m < N_OSC; m++) { var a = w[m] * t + ph[m]; re += Math.cos(a); im += Math.sin(a); }
        grid.push(re * amp, im * amp);
      }
      return k;
    }
    function blockAt(b) {
      while (blocks.length / 2 <= b) { var s = Math.SQRT1_2; blocks.push(rng.randn() * s, rng.randn() * s); }
      return b;
    }
    var out = { re: 0, im: 0 };
    function hAt(n) {
      var sr, si;
      if (o.mode === 'block') {
        var b = blockAt(o.blockSymbols > 0 ? Math.floor(n / (sps * o.blockSymbols)) : 0);   // 0 = one per frame
        sr = blocks[2 * b]; si = blocks[2 * b + 1];
      } else {
        var t = n / sps, k = Math.floor(t), f = t - k;
        gridAt(k + 1);
        sr = grid[2 * k] * (1 - f) + grid[2 * k + 2] * f; si = grid[2 * k + 1] * (1 - f) + grid[2 * k + 3] * f;
      }
      out.re = los + sc * sr; out.im = sc * si;
      return out;
    }
    return { hAt: hAt, K: K };
  }

  // ---------- multipath ----------
  // Tap-delay line normalized to unit total power. taps: [{ delay (symbols, may be fractional), gain (real) or
  // { re, im } }]. Each path is a windowed-sinc fractional delay, all offset by SINC_M samples (the bulk delay
  // a receiver must account for). Optional independent Rayleigh (Jakes) fading per tap: p.tapFading = fdTs.
  function normTaps(taps) {
    var p = 0, out = [];
    taps.forEach(function (t) { var g = typeof t.gain === 'number' ? { re: t.gain, im: 0 } : t.gain; p += g.re * g.re + g.im * g.im; out.push({ delay: t.delay, g: g }); });
    var k = 1 / Math.sqrt(p || 1);
    out.forEach(function (t) { t.g = { re: t.g.re * k, im: t.g.im * k }; });
    return out;
  }
  function multipathPresets(name, o) {
    o = o || {};
    var s = o.spacing || 1;
    if (name === '2ray') return [{ delay: 0, gain: 1 }, { delay: s, gain: 0.5 }];
    // 'mild': inherent linear-equalizer (MMSE) loss ≈ 0.6 dB; 'severe': −20 dB spectral null at Rs/2.
    if (name === 'mild') return [{ delay: 0, gain: 1 }, { delay: s, gain: 0.25 }, { delay: 2 * s, gain: 0.1 }];
    if (name === 'severe') return [{ delay: 0, gain: 0.45 }, { delay: s, gain: 1 }, { delay: 2 * s, gain: 0.45 }];
    if (name === 'exp') {
      var tau = Math.max(0.05, o.rmsDelay || 1), L = Math.max(1, Math.ceil(5 * tau)), taps = [];
      for (var d = 0; d <= L; d++) taps.push({ delay: d * s, gain: Math.exp(-d / (2 * tau)) }); // power ∝ e^{−d/τ}
      return taps;
    }
    return [{ delay: 0, gain: 1 }];
  }

  function createMultipath(p, ctx) {
    var sps = p.sps, M = SDR.filters.SINC_M, taps = normTaps(p.taps), W = 2 * M;
    // Path delay D = M + ds samples (ds = delay·sps = di + fr). y[n] = Σ_j row[j]·x[n − off − j] with
    // off = di + 1 and row[j] = windowed sinc(v), v = (M − 1 − j) + fr, so the centre lands at delay D.
    var beta = 8, i0b = SDR.filters.besselI0(beta);
    var kern = taps.map(function (t) {
      var ds = t.delay * sps, di = Math.floor(ds), fr = ds - di, row = new Float64Array(W), s = 0;
      for (var j = 0; j < W; j++) {
        var v = (M - 1 - j) + fr, r = v / M;
        row[j] = (v === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v)) * (Math.abs(r) < 1 ? SDR.filters.besselI0(beta * Math.sqrt(1 - r * r)) / i0b : 0);
        s += row[j];
      }
      for (j = 0; j < W; j++) row[j] /= s;
      return { off: di + 1, row: row };
    });
    var maxOff = 0;
    kern.forEach(function (k) { maxOff = Math.max(maxOff, k.off + W); });
    var fade = p.tapFading ? taps.map(function () { return createFading({ mode: 'jakes', fdTs: p.tapFading, sps: sps }, ctx.subRng()); }) : null;
    var hr = new Float64Array(maxOff), hi = new Float64Array(maxOff), n0 = 0;
    return {
      bulkDelay: M, taps: taps,
      // Static sample-rate impulse response (complex), for plots and the ideal ZF equalizer.
      impulse: function () {
        var len = maxOff + 1, re = new Float64Array(len), im = new Float64Array(len);
        taps.forEach(function (t, ti) { var k = kern[ti]; for (var j = 0; j < W; j++) { re[k.off + j] += t.g.re * k.row[j]; im[k.off + j] += t.g.im * k.row[j]; } });
        return { re: re, im: im };
      },
      process: function (x) {
        var L = x.re.length, H = maxOff, br = new Float64Array(H + L), bi = new Float64Array(H + L), yr = new Float64Array(L), yi = new Float64Array(L);
        br.set(hr); br.set(x.re, H); bi.set(hi); bi.set(x.im, H);
        for (var n = 0; n < L; n++) {
          var ar = 0, ai = 0;
          for (var t = 0; t < taps.length; t++) {
            var k = kern[t], sr = 0, si = 0, b = H + n - k.off;
            for (var j = 0; j < W; j++) { sr += k.row[j] * br[b - j]; si += k.row[j] * bi[b - j]; }
            var gr = taps[t].g.re, gi = taps[t].g.im;
            if (fade) { var h = fade[t].hAt(n0 + n), fr2 = gr * h.re - gi * h.im; gi = gr * h.im + gi * h.re; gr = fr2; }
            ar += gr * sr - gi * si; ai += gr * si + gi * sr;
          }
          yr[n] = ar; yi[n] = ai;
        }
        hr = br.slice(L); hi = bi.slice(L); n0 += L;
        return { re: yr, im: yi };
      }
    };
  }

  // ---------- ADC ----------
  // AGC (per-sample running mean square, seeded with the nominal power) scales the per-component RMS to
  // (FS/√2)·10^(−backoff/20), i.e. backoff is measured from a full-scale sine. Then each of I and Q is
  // clipped to ±FS and quantized (mid-rise, N bits), and scaled back. With no clipping
  // SQNR ≈ 6.02·N + 1.76 − backoff dB.
  function createAdc(p) {
    var N = p.bits, FS = 1, delta = (2 * FS) / Math.pow(2, N), target = (FS / Math.SQRT2) * Math.pow(10, -p.backoffDb / 20);
    var ms = p.nominalPower || 1, alpha = 1 / 4096, sig = 0, err = 0, clips = 0, count = 0, hist = [], HMAX = 20000;
    function q(v) {
      if (v > FS) { clips++; v = FS; } else if (v < -FS) { clips++; v = -FS; }
      var k = Math.floor(v / delta); if (k >= Math.pow(2, N - 1)) k = Math.pow(2, N - 1) - 1;
      return (k + 0.5) * delta;
    }
    var st = {
      process: function (x) {
        return mapBlock(x, function (re, im, n, o) {
          ms += alpha * (re * re + im * im - ms);
          var g = target / Math.sqrt(Math.max(ms / 2, 1e-30)), a = re * g, b = im * g, qa = q(a), qb = q(b);
          sig += a * a + b * b; err += (qa - a) * (qa - a) + (qb - b) * (qb - b); count += 2;
          if (hist.length < HMAX) hist.push(a, b);
          o.re = qa / g; o.im = qb / g;
        });
      },
      stats: function () { return { sqnrDb: 10 * Math.log10(sig / Math.max(err, 1e-300)), clipRate: count ? clips / count : 0, hist: hist, fullScale: FS, bits: N }; }
    };
    return st;
  }

  // ---------- IQ imbalance ----------
  // Receiver model y = μ·x + ν·x*, gain mismatch g = 10^(ε/20), phase mismatch φ:
  //   μ = (1 + g·e^{−jφ})/2,  ν = (1 − g·e^{jφ})/2.  Image rejection ratio IRR = |μ|²/|ν|².
  function iqCoeffs(epsDb, phiDeg) {
    var g = Math.pow(10, epsDb / 20), f = (phiDeg * Math.PI) / 180;
    return { mu: { re: (1 + g * Math.cos(f)) / 2, im: (-g * Math.sin(f)) / 2 }, nu: { re: (1 - g * Math.cos(f)) / 2, im: (-g * Math.sin(f)) / 2 } };
  }
  // Real 2×2 map [yr; yi] = A·[xr; xi] ↔ y = μx + νx*. Convert both ways to compose and measure IRR.
  function iqToMatrix(c) {
    var m = c.mu, v = c.nu;
    return [[m.re + v.re, -m.im + v.im], [m.im + v.im, m.re - v.re]];
  }
  function matrixToIq(A) {
    return { mu: { re: (A[0][0] + A[1][1]) / 2, im: (A[1][0] - A[0][1]) / 2 }, nu: { re: (A[0][0] - A[1][1]) / 2, im: (A[1][0] + A[0][1]) / 2 } };
  }
  function irrDb(c) { return 10 * Math.log10((c.mu.re * c.mu.re + c.mu.im * c.mu.im) / Math.max(c.nu.re * c.nu.re + c.nu.im * c.nu.im, 1e-300)); }

  // ---------- stage factories ----------
  var STAGES = {
    timing: function (p) { return p.sym ? SDR.filters.createResampler({ delay: p.sym * p.sps }) : null; },
    drift: function (p) { return p.ppm ? SDR.filters.createResampler({ ratio: 1 + p.ppm * 1e-6 }) : null; },
    cfo: function (p) {
      var f = p.fRs / p.sps, n0 = 0;
      if (!f) return null;
      return { process: function (x) {
        var w = TWO_PI * f, y = mapBlock(x, function (re, im, n, o) { var c = Math.cos(w * (n0 + n)), s = Math.sin(w * (n0 + n)); o.re = re * c - im * s; o.im = re * s + im * c; });
        n0 += x.re.length; return y;
      } };
    },
    phase: function (p) {
      if (!p.deg) return null;
      var c = Math.cos((p.deg * Math.PI) / 180), s = Math.sin((p.deg * Math.PI) / 180);
      return { process: function (x) { return mapBlock(x, function (re, im, n, o) { o.re = re * c - im * s; o.im = re * s + im * c; }); } };
    },
    awgn: function (p, ctx) { return { process: function (x) { return addAwgnEbN0(x, p.ebn0Db, p, ctx.rng); } }; },
    cnr: function (p, ctx) { return { process: function (x) { return addAwgnCnr(x, p.cnrDb, p.bw, p.fs, ctx.rng, p); } }; },
    // Wiener phase noise: per-symbol increment variance 2π·Δν·Ts (spread evenly over the sps samples).
    phasenoise: function (p, ctx) {
      if (!p.linewidthTs) return null;
      var r = ctx.subRng(), sd = Math.sqrt((TWO_PI * p.linewidthTs) / (p.sps || 1)), th = 0, trace = [];
      return { trace: trace, process: function (x) {
        return mapBlock(x, function (re, im, n, o) { th += sd * r.randn(); trace.push(th); var c = Math.cos(th), s = Math.sin(th); o.re = re * c - im * s; o.im = re * s + im * c; });
      } };
    },
    fading: function (p, ctx) {
      var fd = createFading(p, ctx.subRng()), n0 = 0;
      return { fading: fd, process: function (x) {
        var y = mapBlock(x, function (re, im, n, o) { var h = fd.hAt(n0 + n); o.re = re * h.re - im * h.im; o.im = re * h.im + im * h.re; });
        n0 += x.re.length; return y;
      } };
    },
    multipath: function (p, ctx) { return createMultipath(p, ctx); },
    iq: function (p) {
      if (!p.epsDb && !p.phiDeg) return null;
      var c = iqCoeffs(p.epsDb || 0, p.phiDeg || 0), m = c.mu, v = c.nu;
      return { coeffs: c, process: function (x) {
        return mapBlock(x, function (re, im, n, o) {   // μx + νx*
          o.re = m.re * re - m.im * im + v.re * re + v.im * im;
          o.im = m.re * im + m.im * re + v.im * re - v.re * im;
        });
      } };
    },
    dc: function (p) {
      if (!p.rel) return null;
      var a = (p.rel * Math.sqrt(p.rmsRef || 1)), ang = ((p.angleDeg || 0) * Math.PI) / 180, dr = a * Math.cos(ang), di = a * Math.sin(ang);
      return { offset: { re: dr, im: di }, process: function (x) { return mapBlock(x, function (re, im, n, o) { o.re = re + dr; o.im = im + di; }); } };
    },
    adc: function (p) { return createAdc(p); }
  };

  // ctx: { rng } (main rng: AWGN), sub-generators are drawn from it once, at build time, per stage needing one.
  function createChain(list, ctx) {
    var c = { rng: ctx.rng, subRng: function () { return SDR.rng.createRng((ctx.rng.uniform() * 4294967296) >>> 0); } };
    var stages = [], byType = {};
    list.forEach(function (it) {
      if (it.enabled === false) return;
      var f = STAGES[it.type];
      if (!f) throw new Error('SDR.channel: unknown impairment ' + it.type);
      var s = f(it, c);
      if (s) { stages.push(s); byType[it.type] = s; }
    });
    function run(x, from) { for (var i = from; i < stages.length; i++) x = stages[i].process(x); return x; }
    return {
      stages: byType,
      process: function (x) { return run(x, 0); },
      // Drain stages that hold samples back (resamplers), pushing what they release through the rest.
      flush: function () {
        var parts = [];
        for (var i = 0; i < stages.length; i++) if (stages[i].flush) parts.push(run(stages[i].flush(), i + 1));
        var n = 0; parts.forEach(function (p) { n += p.re.length; });
        var re = new Float64Array(n), im = new Float64Array(n), o = 0;
        parts.forEach(function (p) { re.set(p.re, o); im.set(p.im, o); o += p.re.length; });
        return { re: re, im: im };
      }
    };
  }

  // Batch: the whole signal through a chain. Disabled entries and zero-valued impairments are skipped,
  // so "all off" returns the input unchanged.
  function apply(x, list, rng) {
    var ch = createChain(list, { rng: rng }), y = ch.process(x), t = ch.flush();
    if (!t.re.length) return y;
    var re = new Float64Array(y.re.length + t.re.length), im = new Float64Array(re.length);
    re.set(y.re); re.set(t.re, y.re.length); im.set(y.im); im.set(t.im, y.im.length);
    return { re: re, im: im };
  }

  SDR.channel = {
    addAwgnCnr: addAwgnCnr, phaseOffset: phaseOffset, freqOffset: freqOffset,
    esn0Db: esn0Db, snrPerSampleDb: snrPerSampleDb, addAwgnEbN0: addAwgnEbN0,
    apply: apply, createChain: createChain, STAGES: STAGES,
    createFading: createFading, multipathPresets: multipathPresets, normTaps: normTaps,
    iqCoeffs: iqCoeffs, iqToMatrix: iqToMatrix, matrixToIq: matrixToIq, irrDb: irrDb
  };
})();
