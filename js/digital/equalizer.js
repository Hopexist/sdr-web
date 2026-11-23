// SDR.eq — adaptive and fixed linear equalizers on timing-recovered symbols. Pure, no DOM.
//
// Input per symbol k: the strobe y_k and (for fractionally spaced T/2 operation) the midpoint m_k sampled
// half a symbol earlier, both produced by the Gardner loop. The regressor for output k (main tap index m)
//   symbol-spaced:  [y_{k+m}, y_{k+m−1}, …]            (n taps)
//   T/2-spaced:     [y_{k+m}, m_{k+m}, y_{k+m−1}, …]   (n taps, two per symbol)
// so output k is available once input k + m has arrived (latency m symbols). Taps start as a unit
// impulse on the main tap.
//
// Placement in the receiver: after timing recovery (the equalizer needs symbol-synchronous samples, and
// the Gardner detector is phase-blind so it works on the distorted signal) and before the carrier PLL
// (a decision-directed PLL on a signal with ISI sees wrong decisions and cannot lock; removing ISI first
// gives it clean decisions, and the joint update below lets the equalizer ignore the PLL's rotation).
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // o: { nTaps, mainTap (in symbols), fractional (T/2), mu, mode: 'lms' | 'cma' | 'fixed', taps (fixed) }
  function create(o) {
    var n = o.nTaps, frac = !!o.fractional, main = o.mainTap, wr = new Float64Array(n), wi = new Float64Array(n);
    if (o.taps) { wr.set(o.taps.re); wi.set(o.taps.im); } else wr[frac ? 2 * main : main] = 1;
    var xr = new Float64Array(n), xi = new Float64Array(n);   // regressor, newest first
    var delta = 1e-6, out = { re: 0, im: 0 };
    return {
      taps: { re: wr, im: wi }, latency: main, fractional: frac,
      // Shift one symbol's samples (midpoint first, then strobe) into the regressor.
      push: function (yr, yi, mr, mi) {
        var s = frac ? 2 : 1;
        for (var i = n - 1; i >= s; i--) { xr[i] = xr[i - s]; xi[i] = xi[i - s]; }
        if (frac) { xr[1] = mr; xi[1] = mi; }
        xr[0] = yr; xi[0] = yi;
      },
      output: function () {
        var ar = 0, ai = 0;
        for (var i = 0; i < n; i++) { ar += wr[i] * xr[i] - wi[i] * xi[i]; ai += wr[i] * xi[i] + wi[i] * xr[i]; }
        out.re = ar; out.im = ai;
        return out;
      },
      // Normalized LMS: w += μ·e·conj(x)/(δ + ‖x‖²), e = desired − output.
      adapt: function (er, ei) {
        var p = delta;
        for (var i = 0; i < n; i++) p += xr[i] * xr[i] + xi[i] * xi[i];
        var g = o.mu / p;
        for (i = 0; i < n; i++) { wr[i] += g * (er * xr[i] + ei * xi[i]); wi[i] += g * (ei * xr[i] - er * xi[i]); }
      },
      // CMA (R2 = 1 for QPSK): e = z·(1 − |z|²), same normalized update. Returns the dispersion |1 − |z|²|².
      adaptCma: function (zr, zi) {
        var d = 1 - (zr * zr + zi * zi);
        this.adapt(zr * d, zi * d);
        return d * d;
      }
    };
  }

  // Combined symbol-rate response q_p (p = 0…) of channel ⊗ equalizer, given the channel's symbol-rate
  // responses at the strobe (cs) and at the midpoint half a symbol earlier (cm), both indexed from lag 0.
  // Output z_k = Σ_p q_p·a_{k+m−p}; ideal equalization makes q a unit impulse at p = m.
  function combined(w, cs, cm, frac) {
    var n = w.re.length, L = cs.re.length + n, qr = new Float64Array(L), qi = new Float64Array(L);
    for (var i = 0; i < n; i++) {
      var lag = frac ? i >> 1 : i, c = frac && (i & 1) ? cm : cs;
      for (var j = 0; j < c.re.length; j++) {
        qr[lag + j] += w.re[i] * c.re[j] - w.im[i] * c.im[j];
        qi[lag + j] += w.re[i] * c.im[j] + w.im[i] * c.re[j];
      }
    }
    return { re: qr, im: qi };
  }

  // Zero-forcing taps from the true channel: least squares on the convolution matrix A (q = A·w), target a
  // unit impulse at lag mainTap. Solved by complex Gaussian elimination on AᴴA w = Aᴴe (+ε·I).
  function zfTaps(cs, cm, o) {
    var n = o.nTaps, frac = !!o.fractional, m = o.mainTap, L = cs.re.length + n, i, j, r;
    var Ar = [], Ai = [];
    for (r = 0; r < L; r++) { Ar.push(new Float64Array(n)); Ai.push(new Float64Array(n)); }
    for (i = 0; i < n; i++) {
      var lag = frac ? i >> 1 : i, c = frac && (i & 1) ? cm : cs;
      for (j = 0; j < c.re.length; j++) { Ar[lag + j][i] += c.re[j]; Ai[lag + j][i] += c.im[j]; }
    }
    // Normal equations G w = b, G = AᴴA + εI, b = Aᴴ e_m
    var Gr = [], Gi = [], br = new Float64Array(n), bi = new Float64Array(n);
    for (i = 0; i < n; i++) {
      Gr.push(new Float64Array(n)); Gi.push(new Float64Array(n));
      for (j = 0; j < n; j++) {
        var sr = 0, si = 0;
        for (r = 0; r < L; r++) { sr += Ar[r][i] * Ar[r][j] + Ai[r][i] * Ai[r][j]; si += Ar[r][i] * Ai[r][j] - Ai[r][i] * Ar[r][j]; }
        Gr[i][j] = sr; Gi[i][j] = si;
      }
      Gr[i][i] += o.epsilon || 1e-6;
      br[i] = Ar[m] ? Ar[m][i] : 0; bi[i] = Ar[m] ? -Ai[m][i] : 0;
    }
    for (i = 0; i < n; i++) {   // Gaussian elimination with partial pivoting
      var piv = i, best = 0;
      for (r = i; r < n; r++) { var mg = Gr[r][i] * Gr[r][i] + Gi[r][i] * Gi[r][i]; if (mg > best) { best = mg; piv = r; } }
      if (piv !== i) { var t = Gr[i]; Gr[i] = Gr[piv]; Gr[piv] = t; t = Gi[i]; Gi[i] = Gi[piv]; Gi[piv] = t; t = br[i]; br[i] = br[piv]; br[piv] = t; t = bi[i]; bi[i] = bi[piv]; bi[piv] = t; }
      var dr = Gr[i][i], di = Gi[i][i], dd = dr * dr + di * di;
      for (r = i + 1; r < n; r++) {
        var fr = (Gr[r][i] * dr + Gi[r][i] * di) / dd, fi = (Gi[r][i] * dr - Gr[r][i] * di) / dd;
        for (j = i; j < n; j++) { Gr[r][j] -= fr * Gr[i][j] - fi * Gi[i][j]; Gi[r][j] -= fr * Gi[i][j] + fi * Gr[i][j]; }
        br[r] -= fr * br[i] - fi * bi[i]; bi[r] -= fr * bi[i] + fi * br[i];
      }
    }
    var wr = new Float64Array(n), wi = new Float64Array(n);
    for (i = n - 1; i >= 0; i--) {
      var ar = br[i], ai = bi[i];
      for (j = i + 1; j < n; j++) { ar -= Gr[i][j] * wr[j] - Gi[i][j] * wi[j]; ai -= Gr[i][j] * wi[j] + Gi[i][j] * wr[j]; }
      var d2 = Gr[i][i] * Gr[i][i] + Gi[i][i] * Gi[i][i];
      wr[i] = (ar * Gr[i][i] + ai * Gi[i][i]) / d2; wi[i] = (ai * Gr[i][i] - ar * Gi[i][i]) / d2;
    }
    return { re: wr, im: wi };
  }

  // |DTFT|² in dB of a complex sequence at normalized frequencies f (cycles per sample).
  function responseDb(h, freqs) {
    return freqs.map(function (f) {
      var ar = 0, ai = 0;
      for (var k = 0; k < h.re.length; k++) { var c = Math.cos(2 * Math.PI * f * k), s = Math.sin(2 * Math.PI * f * k); ar += h.re[k] * c + h.im[k] * s; ai += h.im[k] * c - h.re[k] * s; }
      return 10 * Math.log10(ar * ar + ai * ai + 1e-30);
    });
  }

  SDR.eq = { create: create, combined: combined, zfTaps: zfTaps, responseDb: responseDb };
})();
