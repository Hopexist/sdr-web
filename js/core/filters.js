// SDR.filters — FIR lowpass design (Kaiser-windowed sinc), causal FIR filtering, DC blocker.
// Every filter reports its group delay in samples. Pure, no DOM.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  function besselI0(x) {
    var sum = 1, term = 1, h = x / 2;
    for (var k = 1; term > 1e-14 * sum; k++) { term *= (h / k) * (h / k); sum += term; }
    return sum;
  }

  // Linear-phase lowpass. `cutoff` is the −6 dB point (centre of the transition band), so the
  // noise-equivalent bandwidth ≈ cutoff. Passband edge = cutoff − transition/2.
  // Returns { taps, groupDelay, ripple } where ripple is the designed passband deviation δ.
  // Designs are memoized (same parameters → same object), which also lets fir() reuse the cached FFT
  // of the taps. Treat the returned taps as read-only.
  var designs = new Map();
  function lowpass(o) {
    var fs = o.fs, cutoff = o.cutoff, tw = o.transition || 500, A = o.attenuation || 60;
    if (!(cutoff > 0 && cutoff < fs / 2)) throw new Error('SDR.filters.lowpass: cutoff must be in (0, fs/2)');
    var key = fs + '|' + cutoff + '|' + tw + '|' + A;
    var hit = designs.get(key);
    if (hit) return hit;
    if (designs.size > 64) designs.clear(); // shortcut: crude bound; a slider sweep touches only a few dozen designs
    hit = design(fs, cutoff, tw, A);
    designs.set(key, hit);
    return hit;
  }

  function design(fs, cutoff, tw, A) {
    var dw = (2 * Math.PI * tw) / fs;
    var N = Math.ceil((A - 8) / (2.285 * dw)) + 1;
    if (N % 2 === 0) N++; // odd length → integer group delay
    var beta = A > 50 ? 0.1102 * (A - 8.7) : A >= 21 ? 0.5842 * Math.pow(A - 21, 0.4) + 0.07886 * (A - 21) : 0;
    var M = (N - 1) / 2, fc = cutoff / fs, i0b = besselI0(beta);
    var taps = new Float64Array(N), sum = 0;
    for (var n = 0; n < N; n++) {
      var k = n - M, r = k / M;
      var sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
      taps[n] = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / i0b;
      sum += taps[n];
    }
    for (n = 0; n < N; n++) taps[n] /= sum; // unity DC gain
    return { taps: taps, groupDelay: M, ripple: Math.pow(10, -A / 20), cutoff: cutoff, transition: tw, attenuation: A };
  }

  var spectra = new WeakMap(); // taps → { nfft, re, im } cached FFT of the zero-padded taps

  // FFT overlap-add, same result as the direct form (to ~1e-15) but O(log N) per sample.
  // xi (optional) is an imaginary part: real taps filter re and im together in one complex pass.
  function firFFT(x, taps, xi) {
    var nx = x.length, nh = taps.length, H = spectra.get(taps), i;
    if (!H) {
      var nf = 1;
      while (nf < 4 * nh) nf *= 2;
      H = { nfft: nf, re: new Float64Array(nf), im: new Float64Array(nf) };
      H.re.set(taps);
      SDR.fft.fft(H.re, H.im);
      spectra.set(taps, H);
    }
    var nfft = H.nfft, L = nfft - nh + 1, y = new Float64Array(nx), yi = xi ? new Float64Array(nx) : null;
    var re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (var s = 0; s < nx; s += L) {
      re.fill(0); im.fill(0);
      var m = Math.min(L, nx - s);
      for (i = 0; i < m; i++) re[i] = x[s + i];
      if (xi) for (i = 0; i < m; i++) im[i] = xi[s + i];
      SDR.fft.fft(re, im);
      for (i = 0; i < nfft; i++) {
        var a = re[i], b = im[i];
        re[i] = a * H.re[i] - b * H.im[i];
        im[i] = a * H.im[i] + b * H.re[i];
      }
      SDR.fft.ifft(re, im);
      var end = Math.min(nfft, nx - s);
      for (i = 0; i < end; i++) y[s + i] += re[i];
      if (xi) for (i = 0; i < end; i++) yi[s + i] += im[i];
    }
    return xi ? { re: y, im: yi } : y;
  }

  // Complex input, real taps: one FFT pass for both parts when long, else direct form on each.
  function firComplex(x, taps) {
    if (taps.length > 32 && x.re.length > 4 * taps.length) return firFFT(x.re, taps, x.im);
    return { re: fir(x.re, taps), im: fir(x.im, taps) };
  }

  // Causal FIR, output length = input length (output lags input by the filter's group delay).
  function fir(x, taps) {
    var nx = x.length, nh = taps.length;
    if (nh > 32 && nx > 4 * nh) return firFFT(x, taps);
    var y = new Float64Array(nx);
    for (var n = 0; n < nx; n++) {
      var kmax = n < nh - 1 ? n : nh - 1, acc = 0;
      for (var k = 0; k <= kmax; k++) acc += taps[k] * x[n - k];
      y[n] = acc;
    }
    return y;
  }

  // shortcut: block mean removal (exact and zero-phase for a finite buffer); switch to a
  // one-pole IIR blocker if processing ever becomes streaming/chunked.
  // `skip`: leading samples left out of the mean (e.g. filter warm-up, which would bias it).
  function dcBlock(x, skip) {
    var n = x.length, m = 0, i, s0 = skip && skip < n ? skip : 0;
    for (i = s0; i < n; i++) m += x[i];
    m = n - s0 ? m / (n - s0) : 0;
    var y = new Float64Array(n);
    for (i = 0; i < n; i++) y[i] = x[i] - m;
    return { y: y, groupDelay: 0 };
  }

  // Anti-imaging / anti-aliasing filter for rate change by `rate`, designed at the high rate
  // (in units of the low rate): passband to 0.35, stopband from 0.65 (images/aliases land outside
  // the 0.35 passband), 80 dB. Shared by interpolate and decimateFiltered.
  var rateCache = {};
  function rateFilter(rate) {
    return rateCache[rate] || (rateCache[rate] = lowpass({ cutoff: 0.5, fs: rate, transition: 0.3, attenuation: 80 }));
  }

  function mapComplex(x, fn) { return x.re !== undefined ? { re: fn(x.re), im: fn(x.im) } : fn(x); }

  // Zero-stuff by L, lowpass, gain × L. Real or complex. groupDelay is in output (high-rate) samples.
  // Polyphase: each output only sums the taps that land on non-zero (original) samples.
  function interpolate(x, L) {
    var h = rateFilter(L), taps = h.taps, nh = taps.length;
    var y = mapComplex(x, function (v) {
      var n = v.length * L, out = new Float64Array(n);
      for (var o = 0; o < n; o++) {
        var acc = 0;
        for (var k = o % L; k < nh && k <= o; k += L) acc += taps[k] * v[(o - k) / L];
        out[o] = acc * L;
      }
      return out;
    });
    return { y: y, groupDelay: h.groupDelay };
  }

  // Lowpass then keep samples phase, phase+M, ... Real or complex. Only kept outputs are computed.
  // groupDelay is in input (high-rate) samples; choose `phase` so (total delay − phase) is a multiple of M.
  function decimateFiltered(x, M, opts) {
    var h = rateFilter(M), taps = h.taps, nh = taps.length, phase = (opts && opts.phase) || 0;
    var y = mapComplex(x, function (v) {
      var out = new Float64Array(Math.max(0, Math.ceil((v.length - phase) / M)));
      for (var k = 0; k < out.length; k++) {
        var idx = k * M + phase, kmax = idx < nh - 1 ? idx : nh - 1, acc = 0;
        for (var j = 0; j <= kmax; j++) acc += taps[j] * v[idx - j];
        out[k] = acc;
      }
      return out;
    });
    return { y: y, groupDelay: h.groupDelay, phase: phase };
  }

  // First-order section H(s) = (1 + s·a) / (1 + s·b), bilinear transform at fs. Swapping a and b
  // gives the exact inverse, which is how pre-/de-emphasis stay perfect complements.
  function firstOrder(x, a, b, fs) {
    var K = 2 * fs, d = 1 + b * K;
    var b0 = (1 + a * K) / d, b1 = (1 - a * K) / d, a1 = (1 - b * K) / d;
    var y = new Float64Array(x.length), xp = 0, yp = 0;
    for (var n = 0; n < x.length; n++) {
      var v = b0 * x[n] + b1 * xp - a1 * yp;
      xp = x[n]; yp = v; y[n] = v;
    }
    return y;
  }

  // Root-raised-cosine taps: roll-off β, sps samples/symbol, span in symbols. Closed form with the
  // t = 0 and t = ±Ts/(4β) special cases. Odd length (integer group delay), unit energy Σg² = 1.
  var rrcCache = {};
  function rrcTaps(beta, sps, span) {
    var key = beta + '|' + sps + '|' + span;
    if (rrcCache[key]) return rrcCache[key];
    var N = span * sps + 1;
    if (N % 2 === 0) N++;
    var M = (N - 1) / 2, taps = new Float64Array(N), e = 0, PI = Math.PI;
    for (var n = 0; n < N; n++) {
      var t = (n - M) / sps, h;
      if (t === 0) h = 1 - beta + (4 * beta) / PI;
      else if (beta > 0 && Math.abs(Math.abs(t) - 1 / (4 * beta)) < 1e-9) {
        h = (beta / Math.SQRT2) * ((1 + 2 / PI) * Math.sin(PI / (4 * beta)) + (1 - 2 / PI) * Math.cos(PI / (4 * beta)));
      } else {
        h = (Math.sin(PI * t * (1 - beta)) + 4 * beta * t * Math.cos(PI * t * (1 + beta))) / (PI * t * (1 - 16 * beta * beta * t * t));
      }
      taps[n] = h; e += h * h;
    }
    var k = 1 / Math.sqrt(e);
    for (n = 0; n < N; n++) taps[n] *= k;
    return (rrcCache[key] = { taps: taps, groupDelay: M });
  }

  // Band-limited interpolation x(t) at arbitrary t: Kaiser-windowed sinc, 32 taps, 1024-phase table
  // (nearest phase; phase quantization ≤ 1/2048 sample). Rows normalized to unit DC gain.
  var SINC_M = 16, PHASES = 1024, sincTab = null;
  function sincTable() {
    if (sincTab) return sincTab;
    var W = 2 * SINC_M, beta = 8, i0b = besselI0(beta);
    sincTab = new Float64Array((PHASES + 1) * W);
    for (var p = 0; p <= PHASES; p++) {
      var f = p / PHASES, s = 0, row = p * W;
      for (var j = -SINC_M + 1; j <= SINC_M; j++) {
        var u = f - j, r = u / SINC_M;
        var v = (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * (Math.abs(r) < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / i0b : 0);
        sincTab[row + j + SINC_M - 1] = v; s += v;
      }
      for (j = 0; j < W; j++) sincTab[row + j] /= s;
    }
    return sincTab;
  }
  // Fills out[i] = x(times[i]) for a real array (samples outside the array count as 0).
  function interpAt(x, times, out) {
    var tab = sincTable(), W = 2 * SINC_M, n = x.length;
    for (var i = 0; i < times.length; i++) {
      var t = times[i], i0 = Math.floor(t), row = Math.round((t - i0) * PHASES) * W, acc = 0;
      var base = i0 - SINC_M + 1;
      if (base >= 0 && base + W <= n) {
        for (var j = 0; j < W; j++) acc += x[base + j] * tab[row + j];
      } else {
        for (j = 0; j < W; j++) { var idx = base + j; if (idx >= 0 && idx < n) acc += x[idx] * tab[row + j]; }
      }
      out[i] = acc;
    }
    return out;
  }

  // y[n] = x(n − d): delay by d samples (any real d). Real or complex. groupDelay = d.
  function fractionalDelay(x, d) {
    var n = (x.re || x).length, times = new Float64Array(n);
    for (var i = 0; i < n; i++) times[i] = i - d;
    return mapComplex(x, function (v) { return interpAt(v, times, new Float64Array(n)); });
  }

  // y[n] = x(n·ratio): a receiver whose clock runs at 1/ratio of the transmitter's. ratio = 1 + ppm·1e-6.
  function resample(x, ratio) {
    var len = (x.re || x).length, n = Math.floor((len - 1) / ratio) + 1, times = new Float64Array(n);
    for (var i = 0; i < n; i++) times[i] = i * ratio;
    return mapComplex(x, function (v) { return interpAt(v, times, new Float64Array(n)); });
  }

  SDR.filters = {
    rrcTaps: rrcTaps, fractionalDelay: fractionalDelay, resample: resample,
    lowpass: lowpass, fir: fir, firComplex: firComplex, dcBlock: dcBlock, besselI0: besselI0,
    interpolate: interpolate, decimateFiltered: decimateFiltered, firstOrder: firstOrder
  };
})();
