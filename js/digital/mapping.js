/**
 * @file SDR.mapping — Gray QPSK (pure). Points (±1 ± j)/√2, so Es = 1.
 * qpskMap(bits) → symbols, qpskDemapHard(symbols) → bits, qpskDemapLlr(symbols, N0) → LLR = 2√2·y/N0 per axis,
 * diffEncode(bits, refQuadrant) / diffDecode(symbols, refSymbol) (Gray dibit → 0/90/180/270° steps), quadrant(re, im).
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var A = Math.SQRT1_2;

  function qpskMap(bits) {
    if (bits.length % 2) throw new Error('SDR.mapping.qpskMap: bit count must be even');
    var n = bits.length / 2, re = new Float64Array(n), im = new Float64Array(n);
    for (var i = 0; i < n; i++) { re[i] = bits[2 * i] ? -A : A; im[i] = bits[2 * i + 1] ? -A : A; }
    return { re: re, im: im };
  }

  function qpskDemapHard(s) {
    var n = s.re.length, b = new Uint8Array(2 * n);
    for (var i = 0; i < n; i++) { b[2 * i] = s.re[i] < 0 ? 1 : 0; b[2 * i + 1] = s.im[i] < 0 ? 1 : 0; }
    return b;
  }

  // LLR = log P(b=0)/P(b=1) = 2√2·y/N0 per axis (y = the received I or Q value, symbol noise variance N0).
  function qpskDemapLlr(s, N0) {
    var n = s.re.length, l = new Float64Array(2 * n), k = (2 * Math.SQRT2) / N0;
    for (var i = 0; i < n; i++) { l[2 * i] = k * s.re[i]; l[2 * i + 1] = k * s.im[i]; }
    return l;
  }

  // Differential: each Gray dibit advances the phase by 0/90/180/270° (00 → 0, 01 → 90, 11 → 180, 10 → 270).
  // Symbol for quadrant q is e^{j(π/4 + q·π/2)}. Rotation by any multiple of 90° does not change the decoded bits.
  var DIBIT_TO_INC = [0, 1, 3, 2];        // index b0·2 + b1
  var INC_TO_DIBIT = [[0, 0], [0, 1], [1, 1], [1, 0]];

  function quadrant(re, im) {
    var q = Math.round((Math.atan2(im, re) - Math.PI / 4) / (Math.PI / 2));
    return ((q % 4) + 4) % 4;
  }

  function diffEncode(bits, refQuadrant) {
    var n = bits.length / 2, re = new Float64Array(n), im = new Float64Array(n), q = refQuadrant || 0;
    for (var i = 0; i < n; i++) {
      q = (q + DIBIT_TO_INC[bits[2 * i] * 2 + bits[2 * i + 1]]) & 3;
      var a = Math.PI / 4 + q * Math.PI / 2;
      re[i] = Math.cos(a); im[i] = Math.sin(a);
    }
    return { re: re, im: im };
  }

  // refSymbol: the received symbol just before the first data symbol (e.g. the last preamble symbol).
  function diffDecode(s, refSymbol) {
    var n = s.re.length, b = new Uint8Array(2 * n), prev = quadrant(refSymbol.re, refSymbol.im);
    for (var i = 0; i < n; i++) {
      var q = quadrant(s.re[i], s.im[i]), d = INC_TO_DIBIT[(q - prev) & 3];
      b[2 * i] = d[0]; b[2 * i + 1] = d[1];
      prev = q;
    }
    return b;
  }

  SDR.mapping = { qpskMap: qpskMap, qpskDemapHard: qpskDemapHard, qpskDemapLlr: qpskDemapLlr,
    diffEncode: diffEncode, diffDecode: diffDecode, quadrant: quadrant };
})();
