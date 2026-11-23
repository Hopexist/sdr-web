// SDR.dsp — convolution, resampling, windows, Welch PSD. Pure, no DOM.
// Depends on: SDR.fft
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  function isComplex(x) { return x && x.re !== undefined && x.im !== undefined; }

  // Real x, real h. 'same' keeps length(x), offset floor((nh-1)/2) (numpy convention).
  function convReal(x, h, mode) {
    var nx = x.length, nh = h.length;
    if (!nx || !nh) throw new Error('SDR.dsp.convolve: empty input');
    var start = 0, len = nx + nh - 1;
    if (mode === 'same') { start = Math.floor((nh - 1) / 2); len = nx; }
    else if (mode !== 'full') throw new Error("SDR.dsp.convolve: mode must be 'full' or 'same'");
    var y = new Float64Array(len);
    for (var n = 0; n < len; n++) {
      var i = n + start;
      var kmin = Math.max(0, i - nx + 1), kmax = Math.min(nh - 1, i), acc = 0;
      for (var k = kmin; k <= kmax; k++) acc += h[k] * x[i - k];
      y[n] = acc;
    }
    return y;
  }

  function convolve(x, h, mode) {
    mode = mode || 'full';
    return isComplex(x) ? { re: convReal(x.re, h, mode), im: convReal(x.im, h, mode) } : convReal(x, h, mode);
  }

  function upReal(x, L) {
    var y = new Float64Array(x.length * L);
    for (var i = 0; i < x.length; i++) y[i * L] = x[i];
    return y;
  }
  function upsample(x, L) {
    return isComplex(x) ? { re: upReal(x.re, L), im: upReal(x.im, L) } : upReal(x, L);
  }

  function decReal(x, M) {
    var y = new Float64Array(Math.ceil(x.length / M));
    for (var i = 0; i < y.length; i++) y[i] = x[i * M];
    return y;
  }
  function decimate(x, M) {
    return isComplex(x) ? { re: decReal(x.re, M), im: decReal(x.im, M) } : decReal(x, M);
  }

  // Symmetric windows (w[0] = w[N-1]).
  function cosWindow(N, a0, a1, a2) {
    var w = new Float64Array(N);
    if (N === 1) { w[0] = 1; return w; }
    for (var n = 0; n < N; n++) {
      var p = (2 * Math.PI * n) / (N - 1);
      w[n] = a0 - a1 * Math.cos(p) + a2 * Math.cos(2 * p);
    }
    return w;
  }
  function hann(N) { return cosWindow(N, 0.5, 0.5, 0); }
  function hamming(N) { return cosWindow(N, 0.54, 0.46, 0); }
  function blackman(N) { return cosWindow(N, 0.42, 0.5, 0.08); }
  var WINDOWS = { hann: hann, hamming: hamming, blackman: blackman };

  // Welch averaged periodogram of a complex signal.
  // Scaled as a power *spectrum* (÷(Σw)²): a complex tone of power P peaks at 10·log10(P) dB
  // (minus up to ~1.4 dB scalloping with Hann when off-bin). Noise floor reads as power per bin.
  function welchPSD(x, fs, opts) {
    opts = opts || {};
    var nfft = opts.nfft || 1024;
    var overlap = opts.overlap === undefined ? 0.5 : opts.overlap;
    var win = opts.window || 'hann';
    var w = typeof win === 'string' ? WINDOWS[win] && WINDOWS[win](nfft) : win;
    if (!w) throw new Error('SDR.dsp.welchPSD: unknown window ' + win);
    if (w.length !== nfft) throw new Error('SDR.dsp.welchPSD: window length must equal nfft');

    var sw = 0;
    for (var i = 0; i < nfft; i++) sw += w[i];
    var N = x.re.length, hop = Math.max(1, Math.round(nfft * (1 - overlap)));
    var acc = new Float64Array(nfft), re = new Float64Array(nfft), im = new Float64Array(nfft);
    var segs = 0;
    for (var s = 0; segs === 0 || s + nfft <= N; s += hop) {
      re.fill(0); im.fill(0);
      var m = Math.min(nfft, N - s); // short input → one zero-padded segment
      for (i = 0; i < m; i++) { re[i] = x.re[s + i] * w[i]; im[i] = x.im[s + i] * w[i]; }
      SDR.fft.fft(re, im);
      for (i = 0; i < nfft; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
      segs++;
    }

    var half = nfft >> 1, norm = 1 / (sw * sw * segs);
    var freqs = new Float64Array(nfft), psdDb = new Float64Array(nfft);
    for (var k = 0; k < nfft; k++) {
      freqs[k] = ((k - half) * fs) / nfft;
      psdDb[k] = 10 * Math.log10(Math.max(acc[(k + half) % nfft] * norm, 1e-30));
    }
    return { freqs: freqs, psdDb: psdDb };
  }

  // Bandwidth containing `fraction` of the power (default 98%), from a Welch PSD:
  // the span between the (1−f)/2 and (1+f)/2 points of the cumulative power.
  function occupiedBandwidth(x, fs, opts) {
    opts = opts || {};
    var frac = opts.fraction || 0.98, p = opts.psd || welchPSD(x, fs, { nfft: opts.nfft || 8192 }); // pass a precomputed psd to reuse it
    var n = p.psdDb.length, cum = new Float64Array(n), tot = 0, i;
    for (i = 0; i < n; i++) { tot += Math.pow(10, p.psdDb[i] / 10); cum[i] = tot; }
    var lo = 0, hi = n - 1;
    while (lo < n - 1 && cum[lo] < tot * (1 - frac) / 2) lo++;
    while (hi > 0 && cum[hi - 1] >= tot * (1 + frac) / 2) hi--;
    return p.freqs[hi] - p.freqs[lo];
  }

  // Align out[n + delay] with ref[n], least-squares gain g, SNR = P(g·ref) / P(out − g·ref).
  // The first `delay` aligned samples are skipped (causal-filter start-up transient).
  function measureOutputSnr(ref, out, delay) {
    var end = Math.min(ref.length, out.length - delay), rr = 0, ro = 0, res = 0, n;
    for (n = delay; n < end; n++) { rr += ref[n] * ref[n]; ro += ref[n] * out[n + delay]; }
    if (rr === 0) return { snrDb: NaN, gain: 0 };
    var g = ro / rr;
    for (n = delay; n < end; n++) { var e = out[n + delay] - g * ref[n]; res += e * e; } // second pass avoids cancellation
    return { snrDb: 10 * Math.log10((g * g * rr) / Math.max(res, 1e-300)), gain: g };
  }

  SDR.dsp = {
    convolve: convolve, upsample: upsample, decimate: decimate,
    hann: hann, hamming: hamming, blackman: blackman, welchPSD: welchPSD,
    occupiedBandwidth: occupiedBandwidth, measureOutputSnr: measureOutputSnr
  };
})();
