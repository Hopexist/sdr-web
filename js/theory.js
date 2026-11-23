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

  SDR.theory = { qpskAwgn: qpskAwgn, qpskPhaseError: qpskPhaseError, dqpskAwgn: dqpskAwgn,
    qpskEbn0ForBer: qpskEbn0ForBer, wilsonInterval: wilsonInterval };
})();
