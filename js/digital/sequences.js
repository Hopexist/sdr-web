// SDR.seq — LFSR maximal-length sequences and the frame preamble. Pure, no DOM.
// Depends on: SDR.mapping
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // Fibonacci feedback taps of primitive polynomials (exponents), degrees 5–10.
  var TAPS = { 5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 9: [9, 5], 10: [10, 7] };

  // One period (2^m − 1 bits) of the m-sequence, register seeded with all ones.
  function mseq(m) {
    var taps = TAPS[m];
    if (!taps) throw new Error('SDR.seq.mseq: degree must be 5–10');
    var n = (1 << m) - 1, out = new Uint8Array(n), state = (1 << m) - 1, mask = (1 << m) - 1;
    for (var i = 0; i < n; i++) {
      out[i] = (state >> (m - 1)) & 1;
      var fb = 0;
      for (var t = 0; t < taps.length; t++) fb ^= (state >> (taps[t] - 1)) & 1;
      state = ((state << 1) | fb) & mask;
    }
    return out;
  }

  // Known QPSK preamble: n symbols from the degree-7 m-sequence (127 bits, wrapped for 2n bits).
  var cache = {};
  function preamble(n) {
    n = n || 64;
    if (cache[n]) return cache[n];
    var s = mseq(7), bits = new Uint8Array(2 * n);
    for (var i = 0; i < 2 * n; i++) bits[i] = s[i % s.length];
    return (cache[n] = SDR.mapping.qpskMap(bits));
  }

  SDR.seq = { mseq: mseq, preamble: preamble, TAPS: TAPS };
})();
