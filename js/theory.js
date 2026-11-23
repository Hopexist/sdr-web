// SDR.theory — closed-form BER curves and confidence intervals. Pure, no DOM.
// Depends on: SDR.mathx
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  function lin(db) { return Math.pow(10, db / 10); }

  // Gray-coded coherent QPSK in AWGN: Pb = Q(√(2·Eb/N0)).
  function qpskAwgn(ebn0Db) { return SDR.mathx.Q(Math.sqrt(2 * lin(ebn0Db))); }

  // Static carrier phase error φ: each axis sees amplitude (cosφ ∓ sinφ)/√2.
  function qpskPhaseError(ebn0Db, phi) {
    var a = Math.sqrt(2 * lin(ebn0Db)), c = Math.cos(phi), s = Math.sin(phi);
    return 0.5 * (SDR.mathx.Q(a * (c - s)) + SDR.mathx.Q(a * (c + s)));
  }

  // Differentially encoded QPSK with coherent detection (what this receiver does when "differential" is on):
  // a symbol error corrupts two consecutive differential decisions, so Pb ≈ 2p(1 − p), p = Q(√(2Eb/N0)).
  // (Not true differential detection, DQPSK, which loses a further ~2.3 dB.)
  function dqpskAwgn(ebn0Db) { var p = qpskAwgn(ebn0Db); return 2 * p * (1 - p); }

  // Flat Rayleigh fading, coherent detection with ideal CSI: Pb = ½·(1 − √(γ/(1+γ))), γ = mean Eb/N0.
  // Falls only as 1/(4γ) at high SNR: the deep fades dominate.
  function qpskRayleigh(ebn0Db) { var g = lin(ebn0Db); return 0.5 * (1 - Math.sqrt(g / (1 + g))); }

  // Flat Rician fading (K = LOS/scatter power), ideal CSI, via Craig's form and the MGF of the SNR:
  //   Pb = (1/π)·∫₀^{π/2} M(−1/sin²θ) dθ,  M(s) = (1+K)/(1+K−sγ)·exp(K·s·γ/(1+K−sγ)).
  // Simpson's rule, doubling the panels until successive results agree to 1e-9 relative.
  function qpskRician(ebn0Db, kDb) {
    var g = lin(ebn0Db), K = kDb === -Infinity ? 0 : lin(kDb);
    function f(th) {
      if (th <= 0) return 0;
      var s = -1 / (Math.sin(th) * Math.sin(th)), d = 1 + K - s * g;
      return ((1 + K) / d) * Math.exp((K * s * g) / d);
    }
    function simpson(n) {
      var h = (Math.PI / 2) / n, acc = f(0) + f(Math.PI / 2);
      for (var i = 1; i < n; i++) acc += (i % 2 ? 4 : 2) * f(i * h);
      return (acc * h) / 3 / Math.PI;
    }
    var n = 64, prev = simpson(n), cur;
    for (;;) { n *= 2; cur = simpson(n); if (Math.abs(cur - prev) <= 1e-9 * Math.abs(cur) || n > 1 << 16) return cur; prev = cur; }
  }

  // ADC: N-bit quantizer, signal backed off from a full-scale sine by backoffDb, no clipping:
  // SQNR ≈ 6.02·N + 1.76 − backoff (dB). Clipping (small backoff) makes the real SQNR lower.
  function adcSqnr(bits, backoffDb) { return 6.02 * bits + 1.76 - backoffDb; }

  // Eb/N0 (dB) at which coherent QPSK reaches BER p (bisection on the monotone qpskAwgn).
  function qpskEbn0ForBer(p) {
    var lo = -20, hi = 30;
    for (var i = 0; i < 80; i++) { var mid = (lo + hi) / 2; if (qpskAwgn(mid) > p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // Wilson score interval for k errors in n trials.
  function wilsonInterval(k, n, z) {
    z = z || 1.96;
    if (!n) return [0, 1];
    var p = k / n, z2 = z * z, d = 1 + z2 / n;
    var c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }

  // Inverse of qpskRayleigh (closed form): γ = (1 − 2p)² / (1 − (1 − 2p)²).
  function rayleighEbn0ForBer(p) { var a = (1 - 2 * p) * (1 - 2 * p); return 10 * Math.log10(a / (1 - a)); }

  SDR.theory = { qpskAwgn: qpskAwgn, qpskPhaseError: qpskPhaseError, dqpskAwgn: dqpskAwgn,
    qpskRayleigh: qpskRayleigh, qpskRician: qpskRician, adcSqnr: adcSqnr, rayleighEbn0ForBer: rayleighEbn0ForBer,
    qpskEbn0ForBer: qpskEbn0ForBer, wilsonInterval: wilsonInterval };
})();
