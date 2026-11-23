// SDR.sync — synchronization loops (generic, reused by FM now and QPSK later). Pure, no DOM.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // Second-order (type-2) PLL locking to a complex input.
  // Phase detector: e = angle(x·e^{−jθ}); proportional-integral loop filter; NCO θ += v.
  // Gains from noise bandwidth B_L (Hz) and damping ζ:
  //   ωn = 2·B_L / (ζ + 1/(4ζ)),  Kp = 2ζ·ωn·T,  Ki = (ωn·T)²   (valid while ωn·T ≪ 1)
  // opts: { fs, loopBw, zeta = 0.707, f0 = 0 (initial frequency guess, Hz) }
  // Returns { freq (rad/sample, loop-filter output), phase (NCO phase), error (detector output) }.
  function pll(x, opts) {
    var fs = opts.fs, zeta = opts.zeta || 0.707, T = 1 / fs;
    var wn = (2 * opts.loopBw) / (zeta + 1 / (4 * zeta));
    var kp = 2 * zeta * wn * T, ki = wn * T * wn * T;
    var n = x.re.length, freq = new Float64Array(n), phase = new Float64Array(n), err = new Float64Array(n);
    var theta = 0, integ = (2 * Math.PI * (opts.f0 || 0)) / fs, TWO_PI = 2 * Math.PI;
    for (var i = 0; i < n; i++) {
      var c = Math.cos(theta), s = Math.sin(theta), xr = x.re[i], xi = x.im[i];
      var e = Math.atan2(xi * c - xr * s, xr * c + xi * s);
      integ += ki * e;
      var v = integ + kp * e;
      freq[i] = v; phase[i] = theta; err[i] = e;
      theta += v;
      if (theta > Math.PI) theta -= TWO_PI; else if (theta < -Math.PI) theta += TWO_PI;
    }
    return { freq: freq, phase: phase, error: err, kp: kp, ki: ki };
  }

  SDR.sync = { pll: pll };
})();
