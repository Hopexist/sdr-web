// SDR.am — AM modulation/demodulation at complex baseband. Pure, no DOM.
// Depends on: SDR.cx, SDR.filters
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // m: real message, |m| ≤ 1. DSB-LC → 1 + μ·m, DSB-SC → m. Returns complex baseband.
  function modulate(m, o) {
    var type = (o && o.type) || 'DSB-LC', mu = o && o.mu !== undefined ? o.mu : 1;
    var n = m.length, re = new Float64Array(n);
    if (type === 'DSB-LC') for (var i = 0; i < n; i++) re[i] = 1 + mu * m[i];
    else if (type === 'DSB-SC') re.set(m);
    else throw new Error('SDR.am.modulate: unknown type ' + type);
    return { re: re, im: new Float64Array(n) };
  }

  function audioLowpass(o) {
    return SDR.filters.lowpass({ cutoff: o.audioBw, fs: o.fs, transition: o.transition || 500, attenuation: 60 });
  }

  // |x| → DC block → lowpass. Returns { y, delay } (y lags the message by `delay` samples).
  function demodEnvelope(x, o) {
    var env = SDR.cx.abs(x);
    var dc = SDR.filters.dcBlock(env);
    var lp = audioLowpass(o);
    return { y: SDR.filters.fir(dc.y, lp.taps), delay: dc.groupDelay + lp.groupDelay };
  }

  // Rotate by −phaseEst → real part → DC block (skip with dcBlock:false, e.g. DSB-SC) → lowpass.
  function demodCoherent(x, o) {
    var r = SDR.cx.rotate(x, -(o.phaseEst || 0)).re, delay = 0;
    if (o.dcBlock !== false) { var dc = SDR.filters.dcBlock(r); r = dc.y; delay += dc.groupDelay; }
    var lp = audioLowpass(o);
    return { y: SDR.filters.fir(r, lp.taps), delay: delay + lp.groupDelay };
  }

  // Align out[n + delay] with ref[n], least-squares gain g, SNR = P(g·ref) / P(out − g·ref).
  // The first `delay` aligned samples are skipped (causal-filter start-up transient).
  function measureOutputSnr(ref, out, delay) {
    var end = Math.min(ref.length, out.length - delay), rr = 0, ro = 0, res = 0, n;
    for (n = delay; n < end; n++) { rr += ref[n] * ref[n]; ro += ref[n] * out[n + delay]; }
    if (rr === 0) return { snrDb: NaN, gain: 0 };
    var g = ro / rr;
    for (n = delay; n < end; n++) { var e = out[n + delay] - g * ref[n]; res += e * e; } // second pass avoids cancellation
    return { snrDb: 10 * Math.log10((g * g * rr) / Math.max(res, 1e-300)), gain: g };
  }

  SDR.am = { modulate: modulate, demodEnvelope: demodEnvelope, demodCoherent: demodCoherent, measureOutputSnr: measureOutputSnr };
})();
