// SDR.rng — seeded PRNG with Gaussian helpers. Pure, no DOM.
// Default xoshiro128** (period 2^128 − 1); mulberry32 kept via createRng(seed, 'mulberry32').
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  function mulberry32(seed) {
    var state = seed;
    return function () {
      state = (state + 0x6d2b79f5) | 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rotl(x, k) { return (x << k) | (x >>> (32 - k)); }

  function xoshiro128ss(seed) {
    // splitmix32 expands the 32-bit seed into the 128-bit state.
    var a = seed | 0;
    function splitmix() {
      a = (a + 0x9e3779b9) | 0;
      var t = a ^ (a >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      return t ^ (t >>> 15);
    }
    var s0 = splitmix(), s1 = splitmix(), s2 = splitmix(), s3 = splitmix();
    if (!(s0 | s1 | s2 | s3)) s0 = 1; // all-zero state is a fixed point
    return function () {
      var r = Math.imul(rotl(Math.imul(s1, 5), 7), 9);
      var t = s1 << 9;
      s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
      s3 = rotl(s3, 11);
      return (r >>> 0) / 4294967296;
    };
  }

  var ALGOS = { 'xoshiro128**': xoshiro128ss, mulberry32: mulberry32 };

  function createRng(seed, algorithm) {
    seed = seed >>> 0;
    algorithm = algorithm || 'xoshiro128**';
    if (!ALGOS[algorithm]) throw new Error('SDR.rng: unknown algorithm ' + algorithm);
    var uniform = ALGOS[algorithm](seed);
    var spare = 0;
    var hasSpare = false;

    // Box–Muller; the second value is cached for the next call.
    function randn() {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      var u1;
      do { u1 = uniform(); } while (u1 === 0);
      var r = Math.sqrt(-2 * Math.log(u1));
      var th = 2 * Math.PI * uniform();
      spare = r * Math.sin(th);
      hasSpare = true;
      return r * Math.cos(th);
    }

    // Total variance E|z|^2 = variance, split equally between re and im.
    function randnComplex(n, variance) {
      if (variance === undefined) variance = 1;
      var s = Math.sqrt(variance / 2);
      var re = new Float64Array(n), im = new Float64Array(n);
      for (var i = 0; i < n; i++) {
        re[i] = s * randn();
        im[i] = s * randn();
      }
      return { re: re, im: im };
    }

    function randomBits(n) {
      var b = new Uint8Array(n);
      for (var i = 0; i < n; i++) b[i] = uniform() < 0.5 ? 0 : 1;
      return b;
    }

    return { seed: seed, algorithm: algorithm, uniform: uniform, randn: randn, randnComplex: randnComplex, randomBits: randomBits };
  }

  SDR.rng = { createRng: createRng };
})();
