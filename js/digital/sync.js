// SDR.sync — synchronization: PLL (generic), loop-gain design, Gardner timing recovery with a cubic
// Farrow interpolator, 4th-power CFO estimation, lock detection. Pure, no DOM.
// Depends on: SDR.fft, SDR.mathx, SDR.filters, SDR.mapping (gardnerKp only)
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var TWO_PI = 2 * Math.PI;

  // Proportional-integral loop gains from normalized noise bandwidth BnT and damping ζ (Rice):
  //   θ = BnT/(ζ + 1/(4ζ)),  K1 = 4ζθ/((1 + 2ζθ + θ²)·Kp),  K2 = 4θ²/((1 + 2ζθ + θ²)·Kp)
  // Kp is the detector gain (error per unit of the tracked quantity); it may be negative.
  function loopGains(bnT, zeta, kp) {
    var th = bnT / (zeta + 1 / (4 * zeta)), d = 1 + 2 * zeta * th + th * th;
    return { k1: (4 * zeta * th) / (d * kp), k2: (4 * th * th) / (d * kp) };
  }

  // Second-order (type-2) PLL on a complex input. z = x·e^{−jθ}; e = detector(z) (default angle(z));
  // integ += K2·e; v = integ + K1·e; θ += v.
  // Gains: opts.gains {k1, k2}, or from opts.loopBw (Hz) and opts.fs with ζ (FM page):
  //   ωn = 2·B_L/(ζ + 1/(4ζ)),  K1 = 2ζ·ωn·T,  K2 = (ωn·T)².
  // Returns { freq (v, rad/sample), phase (θ used for each sample), error, y (corrected z) }.
  function pllGains(opts) {
    var zeta = opts.zeta || 0.707;
    if (opts.gains) return { kp: opts.gains.k1, ki: opts.gains.k2 };
    var T = 1 / opts.fs, wn = (2 * opts.loopBw) / (zeta + 1 / (4 * zeta));
    return { kp: 2 * zeta * wn * T, ki: wn * T * wn * T };
  }

  // Streaming PLL: { step(xr, xi) → { zr, zi, e, v, theta } (one sample), process(block), state }.
  // step() takes an optional error override (data-aided / joint use by the QPSK receiver).
  function createPll(opts) {
    var g = pllGains(opts), kp = g.kp, ki = g.ki, det = opts.detector;
    var st = { theta: opts.theta0 || 0, integ: opts.fs ? (TWO_PI * (opts.f0 || 0)) / opts.fs : 0 };
    var r = { zr: 0, zi: 0, e: 0, v: 0, theta: 0 };
    function rotate(xr, xi) {   // z = x·e^{−jθ} with the current θ (no update)
      var c = Math.cos(st.theta), s = Math.sin(st.theta);
      r.zr = xr * c + xi * s; r.zi = xi * c - xr * s; r.theta = st.theta;
      return r;
    }
    function update(e) {
      st.integ += ki * e;
      var v = st.integ + kp * e;
      r.e = e; r.v = v;
      st.theta += v;
      if (st.theta > Math.PI) st.theta -= TWO_PI; else if (st.theta < -Math.PI) st.theta += TWO_PI;
      return r;
    }
    function step(xr, xi) { rotate(xr, xi); return update(det ? det(r.zr, r.zi) : Math.atan2(r.zi, r.zr)); }
    return {
      kp: kp, ki: ki, state: st, rotate: rotate, update: update, step: step,
      process: function (x) {
        var n = x.re.length, out = { freq: new Float64Array(n), phase: new Float64Array(n), error: new Float64Array(n), y: { re: new Float64Array(n), im: new Float64Array(n) } };
        for (var i = 0; i < n; i++) {
          step(x.re[i], x.im[i]);
          out.freq[i] = r.v; out.phase[i] = r.theta; out.error[i] = r.e; out.y.re[i] = r.zr; out.y.im[i] = r.zi;
        }
        return out;
      }
    };
  }

  function pll(x, opts) {
    var p = createPll(opts), o = p.process(x);
    o.kp = p.kp; o.ki = p.ki;
    return o;
  }

  // Decision-directed QPSK phase detector: angle(z·conj(d)), d = nearest QPSK point. For small errors at
  // high SNR its gain is exactly 1 rad/rad (analytic), so Kp = 1 is used for the carrier loop.
  function qpskDD(zr, zi) {
    var dr = zr >= 0 ? 1 : -1, di = zi >= 0 ? 1 : -1;
    return Math.atan2(zi * dr - zr * di, zr * dr + zi * di);
  }

  // Cubic (Lagrange) Farrow interpolator: value at real time t from x[n−1..n+2], n = ⌊t⌋.
  function farrow(x, t, out) {
    var n = Math.floor(t), f = t - n, a = x.re, b = x.im;
    var r0 = a[n - 1], r1 = a[n], r2 = a[n + 1], r3 = a[n + 2];
    var i0 = b[n - 1], i1 = b[n], i2 = b[n + 1], i3 = b[n + 2];
    var c3 = -r0 / 6 + r1 / 2 - r2 / 2 + r3 / 6, c2 = r0 / 2 - r1 + r2 / 2, c1 = -r0 / 3 - r1 / 2 + r2 - r3 / 6;
    out.re = ((c3 * f + c2) * f + c1) * f + r1;
    c3 = -i0 / 6 + i1 / 2 - i2 / 2 + i3 / 6; c2 = i0 / 2 - i1 + i2 / 2; c1 = -i0 / 3 - i1 / 2 + i2 - i3 / 6;
    out.im = ((c3 * f + c2) * f + c1) * f + i1;
    return out;
  }

  // Gardner TED on two interpolated samples per symbol (strobe y_k and midpoint m = x(t_k − sps/2)):
  //   e_k = Re{ conj(m)·(y_{k−1} − y_k) }   (phase-invariant, so it runs before carrier recovery).
  // NCO-style strobe: t_{k+1} = t_k + sps − v_k, v from the PI loop. Loop gains use the measured Kp.
  // o: { sps, t0, bnT, zeta, kp } or { sps, ideal(k) → t_k } (genie timing).
  // Returns { y (strobes), t (strobe times, samples), err, count }.
  // Streaming version: process(block) → { y (strobes), m (midpoints), t, err } for the strobes that became
  // computable; finish() → the remaining ones (input past the end is treated as missing, like the batch loop).
  function createTimingLoop(o) {
    var sps = o.sps, half = sps / 2, g = o.ideal ? null : loopGains(o.bnT, o.zeta || 0.707, o.kp);
    var br = new Float64Array(0), bi = new Float64Array(0), base = 0;
    var t = o.ideal ? o.ideal(0) : o.t0, k = 0, I = 0, pr = 0, pi = 0;
    var cur = { re: 0, im: 0 }, mid = { re: 0, im: 0 }, view = { re: null, im: null };
    function at(time, out) {   // farrow on the buffer (absolute time)
      view.re = br; view.im = bi;
      return farrow(view, time - base, out);
    }
    function run(final) {
      var yr = [], yi = [], mr = [], mi = [], tt = [], ee = [];
      var avail = base + br.length;
      while (t - half - 1 >= 0 && t + 2 < avail) {
        if (t - half - 1 < base) break;   // history already dropped (should not happen)
        at(t, cur); at(t - half, mid);
        var e = k > 0 ? mid.re * (pr - cur.re) + mid.im * (pi - cur.im) : 0;
        yr.push(cur.re); yi.push(cur.im); mr.push(mid.re); mi.push(mid.im); tt.push(t); ee.push(e);
        pr = cur.re; pi = cur.im; k++;
        if (g) { I += g.k2 * e; t = t + sps - (I + g.k1 * e); } else t = o.ideal(k);
      }
      var keep = Math.floor(t - half) - 2 - base;
      if (keep > 0 && !final) { br = br.slice(keep); bi = bi.slice(keep); base += keep; }
      return { y: { re: Float64Array.from(yr), im: Float64Array.from(yi) }, m: { re: Float64Array.from(mr), im: Float64Array.from(mi) },
        t: Float64Array.from(tt), err: Float64Array.from(ee), count: yr.length };
    }
    return {
      process: function (x) {
        var nr = new Float64Array(br.length + x.re.length), ni = new Float64Array(nr.length);
        nr.set(br); nr.set(x.re, br.length); ni.set(bi); ni.set(x.im, bi.length);
        br = nr; bi = ni;
        return run(false);
      },
      finish: function () { return run(true); }
    };
  }

  // Batch: the whole signal at once (same arithmetic as the streaming loop).
  function timingLoop(x, o) {
    var r = createTimingLoop(o).process(x);
    return { y: r.y, m: r.m, t: r.t, err: r.err, count: r.count };
  }

  // Gardner detector gain Kp (error per sample of timing error), MEASURED from the S-curve slope at the
  // origin on a noiseless RRC-filtered random QPSK signal (finite difference at ±0.05 symbol). Its sign
  // and size depend on roll-off and sps, so measuring beats a textbook formula. Cached per setup.
  var kpCache = {};
  function gardnerKp(rolloff, sps, span) {
    var key = rolloff + '|' + sps + '|' + span;
    if (kpCache[key] !== undefined) return kpCache[key];
    var rng = SDR.rng.createRng(777), nSym = 1200, s = SDR.mapping.qpskMap(rng.randomBits(2 * nSym));
    var h = SDR.filters.rrcTaps(rolloff, sps, span), up = { re: new Float64Array(nSym * sps + h.taps.length), im: new Float64Array(nSym * sps + h.taps.length) };
    for (var i = 0; i < nSym; i++) { up.re[i * sps] = s.re[i]; up.im[i * sps] = s.im[i]; }
    var mf = SDR.filters.firComplex(SDR.filters.firComplex(up, h.taps), h.taps), D2 = 2 * h.groupDelay;
    function meanErr(delta) {
      var a = { re: 0, im: 0 }, b = { re: 0, im: 0 }, m = { re: 0, im: 0 }, sum = 0, cnt = 0;
      for (var k = span + 2; k < nSym - span - 2; k++) {
        var t = k * sps + D2 + delta;
        farrow(mf, t, b); farrow(mf, t - sps, a); farrow(mf, t - sps / 2, m);
        sum += m.re * (a.re - b.re) + m.im * (a.im - b.im); cnt++;
      }
      return sum / cnt;
    }
    var d = 0.05 * sps;
    return (kpCache[key] = (meanErr(d) - meanErr(-d)) / (2 * d));
  }

  // Coarse CFO by the 4th-power method: x⁴ strips QPSK modulation (every point^4 = −1), leaving a
  // line at 4Δf. Hann window, zero-padded FFT, log-parabolic interpolation between bins.
  // o: { skip (samples to ignore at the start), maxN (acquisition window, default 2^14 samples) }.
  // Returns { f (cycles/sample), peakDb }.
  var CFO_WINDOW = 1 << 14;
  function cfoFourthPower(x, o) {
    var skip = (o && o.skip) || 0, N = Math.min(x.re.length - skip, (o && o.maxN) || CFO_WINDOW);
    if (N < 16) return { f: 0, peakDb: -Infinity };
    var nfft = SDR.mathx.nextPow2(N) * 2, re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (var i = 0; i < N; i++) {
      var a = x.re[skip + i], b = x.im[skip + i], sr = a * a - b * b, si = 2 * a * b; // z²
      var w = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (N - 1));
      re[i] = (sr * sr - si * si) * w; im[i] = 2 * sr * si * w;                     // z⁴
    }
    SDR.fft.fft(re, im);
    var best = 0, bm = -1;
    for (i = 0; i < nfft; i++) { var p = re[i] * re[i] + im[i] * im[i]; if (p > bm) { bm = p; best = i; } }
    function lg(k) { k = (k + nfft) % nfft; return 0.5 * Math.log(re[k] * re[k] + im[k] * im[k] + 1e-300); }
    var l = lg(best - 1), c = lg(best), r = lg(best + 1), den = l - 2 * c + r;
    var delta = den !== 0 ? (0.5 * (l - r)) / den : 0;
    var f4 = (best + delta) / nfft;
    if (f4 >= 0.5) f4 -= 1;
    return { f: f4 / 4, peakDb: 10 * Math.log10(bm) };
  }

  // Lock detection from the loop error: windowed variance V_k (32 symbols). Settled level = median of
  // V over the last quarter. Convergence = first symbol after which V stays below 4·V_final + floor
  // (the floor keeps data-dependent ISI jitter in a noiseless link from looking like loss of lock).
  // Locked when it converged before the last quarter and V_final is below lockVar.
  function lockStatus(err, o) {
    var n = err.length, W = 32;
    if (n < 4 * W) return { locked: false, convergence: n, rms: NaN };
    var V = new Float64Array(n), s = 0, s2 = 0, i;
    for (i = 0; i < n; i++) {
      s += err[i]; s2 += err[i] * err[i];
      if (i >= W) { s -= err[i - W]; s2 -= err[i - W] * err[i - W]; }
      if (i >= W - 1) V[i] = Math.max(0, s2 / W - (s / W) * (s / W));
    }
    var tail = Array.prototype.slice.call(V.subarray(Math.floor(0.75 * n))).sort(function (a, b) { return a - b; });
    var vf = tail[tail.length >> 1], thr = 4 * vf + o.floor, conv = W - 1;
    for (i = n - 1; i >= W - 1; i--) if (V[i] > thr) { conv = i + 1; break; }
    return { locked: conv < 0.75 * n && vf < o.lockVar, convergence: conv, rms: Math.sqrt(vf) };
  }

  SDR.sync = { pll: pll, createPll: createPll, loopGains: loopGains, qpskDD: qpskDD, farrow: farrow, timingLoop: timingLoop,
    createTimingLoop: createTimingLoop, gardnerKp: gardnerKp, cfoFourthPower: cfoFourthPower, CFO_WINDOW: CFO_WINDOW, lockStatus: lockStatus };
})();
