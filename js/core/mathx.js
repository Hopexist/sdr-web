/**
 * @file SDR.mathx — scalar math (pure).
 * erfc(x) (Numerical Recipes erfcc, fractional error < 1.2e-7), Q(x) = ½·erfc(x/√2),
 * db2lin / lin2db (amplitude, 20·log10), db2pow / pow2db (power, 10·log10), nextPow2(n), linspace(a, b, n),
 * besselJ(n, x) (integer order, trapezoid on the integral form; machine precision).
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // Numerical Recipes "erfcc" Chebyshev fit, fractional error < 1.2e-7 everywhere.
  function erfc(x) {
    var z = Math.abs(x);
    var t = 1 / (1 + 0.5 * z);
    var r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }

  function Q(x) { return 0.5 * erfc(x / Math.SQRT2); }

  // Amplitude (20·log10) vs power (10·log10) conversions.
  function db2lin(db) { return Math.pow(10, db / 20); }
  function lin2db(a) { return 20 * Math.log10(a); }
  function db2pow(db) { return Math.pow(10, db / 10); }
  function pow2db(p) { return 10 * Math.log10(p); }

  function nextPow2(n) {
    var p = 1;
    while (p < n) p *= 2;
    return p;
  }

  function linspace(a, b, n) {
    var y = new Float64Array(n);
    if (n === 1) { y[0] = a; return y; }
    var step = (b - a) / (n - 1);
    for (var i = 0; i < n; i++) y[i] = a + i * step;
    y[n - 1] = b;
    return y;
  }

  // Bessel J_n(x) from J_n(x) = (1/2π)∫₀^{2π} cos(nτ − x·sinτ) dτ. The trapezoid rule on a periodic
  // analytic integrand converges exponentially, so ~|x|+|n|+40 points give machine precision for any x, n.
  function besselJ(n, x) {
    var N = 2 * Math.ceil(Math.abs(x) + Math.abs(n) + 40), s = 0;
    for (var k = 0; k < N; k++) {
      var t = (2 * Math.PI * k) / N;
      s += Math.cos(n * t - x * Math.sin(t));
    }
    return s / N;
  }

  SDR.mathx = {
    erfc: erfc, Q: Q, db2lin: db2lin, lin2db: lin2db, db2pow: db2pow, pow2db: pow2db,
    nextPow2: nextPow2, linspace: linspace, besselJ: besselJ
  };
})();
