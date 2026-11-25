/**
 * @file SDR.fft — in-place iterative radix-2 FFT with per-size cached tables (pure).
 * fft(re, im) forward (e^{−j…}, unscaled); ifft(re, im) inverse scaled by 1/N; length must be a power of 2
 * (throws otherwise); fftshift(arr) → new array with bin 0 moved to the centre.
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  var cache = {};

  function tables(n) {
    var t = cache[n];
    if (t) return t;
    if (!(n > 0 && (n & (n - 1)) === 0)) {
      throw new Error('SDR.fft: length ' + n + ' is not a power of 2 (pad with SDR.mathx.nextPow2)');
    }
    var bits = Math.round(Math.log2(n));
    var rev = new Uint32Array(n);
    for (var i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    var half = n >> 1, cos = new Float64Array(half), sin = new Float64Array(half);
    for (var k = 0; k < half; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = cache[n] = { rev: rev, cos: cos, sin: sin };
    return t;
  }

  // sign = -1 forward (e^{-j...}), +1 inverse (unscaled).
  function transform(re, im, sign) {
    var n = re.length;
    if (im.length !== n) throw new Error('SDR.fft: re/im length mismatch');
    var t = tables(n), rev = t.rev, cos = t.cos, sin = t.sin;
    for (var i = 0; i < n; i++) {
      var j = rev[i];
      if (j > i) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var s = 0; s < n; s += size) {
        for (var m = 0, k = 0; m < half; m++, k += step) {
          var wr = cos[k], wi = sign * sin[k];
          var a = s + m, b = a + half;
          var xr = wr * re[b] - wi * im[b];
          var xi = wr * im[b] + wi * re[b];
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  function fft(re, im) { transform(re, im, -1); }

  function ifft(re, im) {
    transform(re, im, 1);
    var inv = 1 / re.length;
    for (var i = 0; i < re.length; i++) { re[i] *= inv; im[i] *= inv; }
  }

  // Returns a new array with the zero-frequency bin moved to the centre.
  function fftshift(arr) {
    var n = arr.length, h = Math.floor(n / 2);
    var out = new arr.constructor(n);
    for (var i = 0; i < n; i++) out[i] = arr[(i + n - h) % n];
    return out;
  }

  SDR.fft = { fft: fft, ifft: ifft, fftshift: fftshift };
})();
