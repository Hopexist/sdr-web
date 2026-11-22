// SDR.cx — complex signal helpers. A signal is { re: Float64Array, im: Float64Array }.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  function sameLen(a, b) {
    if (a.re.length !== b.re.length) throw new Error('SDR.cx: length mismatch ' + a.re.length + ' vs ' + b.re.length);
    return a.re.length;
  }

  function zeros(n) { return { re: new Float64Array(n), im: new Float64Array(n) }; }
  function fromReal(arr) { return { re: Float64Array.from(arr), im: new Float64Array(arr.length) }; }
  function copy(x) { return { re: Float64Array.from(x.re), im: Float64Array.from(x.im) }; }

  function add(a, b) {
    var n = sameLen(a, b), y = zeros(n);
    for (var i = 0; i < n; i++) { y.re[i] = a.re[i] + b.re[i]; y.im[i] = a.im[i] + b.im[i]; }
    return y;
  }

  function sub(a, b) {
    var n = sameLen(a, b), y = zeros(n);
    for (var i = 0; i < n; i++) { y.re[i] = a.re[i] - b.re[i]; y.im[i] = a.im[i] - b.im[i]; }
    return y;
  }

  function mul(a, b) {
    var n = sameLen(a, b), y = zeros(n);
    for (var i = 0; i < n; i++) {
      var ar = a.re[i], ai = a.im[i], br = b.re[i], bi = b.im[i];
      y.re[i] = ar * br - ai * bi;
      y.im[i] = ar * bi + ai * br;
    }
    return y;
  }

  function scale(x, k) {
    var n = x.re.length, y = zeros(n);
    for (var i = 0; i < n; i++) { y.re[i] = x.re[i] * k; y.im[i] = x.im[i] * k; }
    return y;
  }

  function conj(x) {
    var n = x.re.length, y = zeros(n);
    for (var i = 0; i < n; i++) { y.re[i] = x.re[i]; y.im[i] = -x.im[i]; }
    return y;
  }

  function abs(x) {
    var n = x.re.length, y = new Float64Array(n);
    for (var i = 0; i < n; i++) y[i] = Math.sqrt(x.re[i] * x.re[i] + x.im[i] * x.im[i]);
    return y;
  }

  function angle(x) {
    var n = x.re.length, y = new Float64Array(n);
    for (var i = 0; i < n; i++) y[i] = Math.atan2(x.im[i], x.re[i]);
    return y;
  }

  // Mean |x|^2.
  function power(x) {
    var n = x.re.length, s = 0;
    for (var i = 0; i < n; i++) s += x.re[i] * x.re[i] + x.im[i] * x.im[i];
    return n ? s / n : 0;
  }

  // Multiply by e^{j·phase}.
  function rotate(x, phase) {
    var c = Math.cos(phase), s = Math.sin(phase), n = x.re.length, y = zeros(n);
    for (var i = 0; i < n; i++) {
      var r = x.re[i], m = x.im[i];
      y.re[i] = r * c - m * s;
      y.im[i] = r * s + m * c;
    }
    return y;
  }

  // Multiply by e^{j2π f n / fs}.
  function mixFreq(x, f, fs) {
    var w = (2 * Math.PI * f) / fs, n = x.re.length, y = zeros(n);
    for (var i = 0; i < n; i++) {
      var c = Math.cos(w * i), s = Math.sin(w * i), r = x.re[i], m = x.im[i];
      y.re[i] = r * c - m * s;
      y.im[i] = r * s + m * c;
    }
    return y;
  }

  SDR.cx = {
    zeros: zeros, fromReal: fromReal, copy: copy, add: add, sub: sub, mul: mul, scale: scale,
    conj: conj, abs: abs, angle: angle, power: power, rotate: rotate, mixFreq: mixFreq
  };
})();
