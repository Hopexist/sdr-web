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
  function lowpass(o) {
    var fs = o.fs, cutoff = o.cutoff, tw = o.transition || 500, A = o.attenuation || 60;
    if (!(cutoff > 0 && cutoff < fs / 2)) throw new Error('SDR.filters.lowpass: cutoff must be in (0, fs/2)');
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
  function firFFT(x, taps) {
    var nx = x.length, nh = taps.length, H = spectra.get(taps), i;
    if (!H) {
      var nf = 1;
      while (nf < 4 * nh) nf *= 2;
      H = { nfft: nf, re: new Float64Array(nf), im: new Float64Array(nf) };
      H.re.set(taps);
      SDR.fft.fft(H.re, H.im);
      spectra.set(taps, H);
    }
    var nfft = H.nfft, L = nfft - nh + 1, y = new Float64Array(nx);
    var re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (var s = 0; s < nx; s += L) {
      re.fill(0); im.fill(0);
      var m = Math.min(L, nx - s);
      for (i = 0; i < m; i++) re[i] = x[s + i];
      SDR.fft.fft(re, im);
      for (i = 0; i < nfft; i++) {
        var a = re[i], b = im[i];
        re[i] = a * H.re[i] - b * H.im[i];
        im[i] = a * H.im[i] + b * H.re[i];
      }
      SDR.fft.ifft(re, im);
      var end = Math.min(nfft, nx - s);
      for (i = 0; i < end; i++) y[s + i] += re[i];
    }
    return y;
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
  function dcBlock(x) {
    var n = x.length, m = 0, i;
    for (i = 0; i < n; i++) m += x[i];
    m = n ? m / n : 0;
    var y = new Float64Array(n);
    for (i = 0; i < n; i++) y[i] = x[i] - m;
    return { y: y, groupDelay: 0 };
  }

  SDR.filters = { lowpass: lowpass, fir: fir, dcBlock: dcBlock, besselI0: besselI0 };
})();
