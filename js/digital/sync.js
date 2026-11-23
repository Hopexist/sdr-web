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
  function pll(x, opts) {
    var zeta = opts.zeta || 0.707, kp, ki;
    if (opts.gains) { kp = opts.gains.k1; ki = opts.gains.k2; } else {
      var T = 1 / opts.fs, wn = (2 * opts.loopBw) / (zeta + 1 / (4 * zeta));
      kp = 2 * zeta * wn * T; ki = wn * T * wn * T;
    }
    var det = opts.detector;
    var n = x.re.length, freq = new Float64Array(n), phase = new Float64Array(n), err = new Float64Array(n);
    var yr = new Float64Array(n), yi = new Float64Array(n);
    var theta = opts.theta0 || 0, integ = opts.fs ? (TWO_PI * (opts.f0 || 0)) / opts.fs : 0;
    for (var i = 0; i < n; i++) {
      var c = Math.cos(theta), s = Math.sin(theta), xr = x.re[i], xi = x.im[i];
      var zr = xr * c + xi * s, zi = xi * c - xr * s;
      var e = det ? det(zr, zi) : Math.atan2(zi, zr);
      integ += ki * e;
      var v = integ + kp * e;
      freq[i] = v; phase[i] = theta; err[i] = e; yr[i] = zr; yi[i] = zi;
      theta += v;
      if (theta > Math.PI) theta -= TWO_PI; else if (theta < -Math.PI) theta += TWO_PI;
    }
    return { freq: freq, phase: phase, error: err, y: { re: yr, im: yi }, kp: kp, ki: ki };
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
  function timingLoop(x, o) {
    var n = x.re.length, sps = o.sps, half = sps / 2, t = o.ideal ? o.ideal(0) : o.t0;
    var maxK = Math.max(0, Math.ceil((n - t) / sps) + 4);
    var yr = new Float64Array(maxK), yi = new Float64Array(maxK), times = new Float64Array(maxK), err = new Float64Array(maxK);
    var g = o.ideal ? null : loopGains(o.bnT, o.zeta || 0.707, o.kp);
    var cur = { re: 0, im: 0 }, mid = { re: 0, im: 0 }, pr = 0, pi = 0, I = 0, k = 0;
    while (k < maxK && t - half - 1 >= 0 && t + 2 < n) {
      farrow(x, t, cur); farrow(x, t - half, mid);
      var e = k > 0 ? mid.re * (pr - cur.re) + mid.im * (pi - cur.im) : 0;
      yr[k] = cur.re; yi[k] = cur.im; times[k] = t; err[k] = e;
      pr = cur.re; pi = cur.im; k++;
      if (g) { I += g.k2 * e; t = t + sps - (I + g.k1 * e); } else t = o.ideal(k);
    }
    return { y: { re: yr.subarray(0, k), im: yi.subarray(0, k) }, t: times.subarray(0, k), err: err.subarray(0, k), count: k };
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
  // o: { skip (samples to ignore at the start) }. Returns { f (cycles/sample), peakDb }.
  function cfoFourthPower(x, o) {
    var skip = (o && o.skip) || 0, N = Math.min(x.re.length - skip, 1 << 16);
    if (N < 16) return { f: 0, peakDb: -Infinity };
    var nfft = Math.min(SDR.mathx.nextPow2(N) * 2, 1 << 17), re = new Float64Array(nfft), im = new Float64Array(nfft);
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

  SDR.sync = { pll: pll, loopGains: loopGains, qpskDD: qpskDD, farrow: farrow, timingLoop: timingLoop,
    gardnerKp: gardnerKp, cfoFourthPower: cfoFourthPower, lockStatus: lockStatus };
})();
