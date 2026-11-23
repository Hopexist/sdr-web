// SDR.fm — FM modulation/demodulation at complex baseband. Pure, no DOM.
// Two rates: audio fsA (message in, audio out) and RF baseband fsR = L·fsA (L integer).
// Depends on: SDR.cx, SDR.filters, SDR.sync
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var TWO_PI = 2 * Math.PI;

  function beta(deviation, W) { return deviation / W; }
  function carson(deviation, W) { return 2 * (deviation + W); }

  // m at fsR, |m| ≤ 1 → s = e^{jφ}, φ[n] = 2π·Δf·Σ m / fsR. Δf is therefore the peak deviation.
  function modulate(m, o) {
    var k = (TWO_PI * o.deviation) / o.fsR, n = m.length, re = new Float64Array(n), im = new Float64Array(n), phi = 0;
    for (var i = 0; i < n; i++) {
      phi += k * m[i];
      if (phi > Math.PI) phi -= TWO_PI; else if (phi < -Math.PI) phi += TWO_PI; // keep precision on long runs
      re[i] = Math.cos(phi); im[i] = Math.sin(phi);
    }
    return { re: re, im: im };
  }

  // Emphasis: pre H(s) = (1 + sτ)/(1 + sτ₂), de = its exact inverse. τ₂ (corner at 18 kHz) keeps the
  // pre-emphasis filter stable and bounded. Both are first order, bilinear-transformed at fsA.
  // Pre-emphasis raises high-frequency content and therefore the peak deviation: callers must
  // renormalize the pre-emphasized message to |m| ≤ 1 so Δf stays the user's setting (transmit() does).
  var TAU2 = 1 / (TWO_PI * 18000);
  function preEmphasis(m, o) { return SDR.filters.firstOrder(m, o.tau, TAU2, o.fsA); }
  function deEmphasis(y, o) { return SDR.filters.firstOrder(y, TAU2, o.tau, o.fsA); }

  // Pre-detection (IF) filter: complex lowpass whose passband edge is ±bw/2 (default Carson).
  // Transition max(2 kHz, 10% of bw) sits outside the band, so Carson sidebands pass untouched.
  function ifFilter(x, o) {
    var bw = o.bw, tw = Math.max(2000, 0.1 * bw);
    var cutoff = Math.min(bw / 2 + tw / 2, 0.49 * o.fsR);
    var lp = SDR.filters.lowpass({ cutoff: cutoff, fs: o.fsR, transition: tw, attenuation: 60 });
    return { y: SDR.filters.firComplex(x, lp.taps), groupDelay: lp.groupDelay };
  }

  // y[n] = angle(x[n]·conj(x[n−1]))·fsR / (2π·Δf), in message units. No unwrapping needed.
  // (Estimates frequency at n − ½: a half-sample delay at fsR, negligible against the audio rate.)
  function demodDiscriminator(x, o) {
    var n = x.re.length, y = new Float64Array(n), k = o.fsR / (TWO_PI * o.deviation);
    for (var i = 1; i < n; i++) {
      var ar = x.re[i], ai = x.im[i], br = x.re[i - 1], bi = -x.im[i - 1];
      y[i] = Math.atan2(ar * bi + ai * br, ar * br - ai * bi) * k;
    }
    y[0] = y[1] || 0;
    return y;
  }

  // PLL demodulator: the loop-filter frequency (rad/sample) scaled to message units.
  function demodPll(x, o) {
    var r = SDR.sync.pll(x, { fs: o.fsR, loopBw: o.loopBw, zeta: o.zeta || 0.707 });
    var k = o.fsR / (TWO_PI * o.deviation), y = r.freq;
    for (var i = 0; i < y.length; i++) y[i] *= k;
    return y;
  }

  // Clicks = 2π slips of the received phase relative to the noise-free signal (the noise phasor
  // encircling the origin). Each slip is exactly one discriminator spike of area 2π. Counted on the
  // unwrapped error phase with 1.5π hysteresis. Uses the clean reference because in a narrowband IF the
  // spike is spread over many samples, so a per-sample "step near ±π" test would miss most clicks.
  // `skip` = samples to ignore at the start: the IF filter's warm-up (its length), where the reference's
  // partial sums can pass near zero and the error phase is meaningless.
  function countClicks(rx, ref, skip) {
    var n = rx.re.length, prev = 0, un = 0, level = 0, clicks = 0;
    for (var i = skip || 0; i < n; i++) {
      var ar = rx.re[i], ai = rx.im[i], br = ref.re[i], bi = -ref.im[i];
      var e = Math.atan2(ar * bi + ai * br, ar * br - ai * bi), d = e - prev;
      if (d > Math.PI) d -= TWO_PI; else if (d < -Math.PI) d += TWO_PI;
      if (i === (skip || 0)) d = 0; // first sample only sets the starting phase
      un += d; prev = e;
      if (un > TWO_PI * level + 1.5 * Math.PI) { level++; clicks++; }
      else if (un < TWO_PI * level - 1.5 * Math.PI) { level--; clicks++; }
    }
    return clicks;
  }

  // Transmitter: optional pre-emphasis (+ renormalize) at fsA → interpolate to fsR → modulate.
  // o: { fsA, fsR, deviation, tau (0/undefined = off) }. delay = interpolation delay in fsR samples.
  function transmit(mA, o) {
    var L = Math.round(o.fsR / o.fsA), m = mA, i;
    if (o.tau) {
      m = preEmphasis(mA, o);
      var peak = 0;
      for (i = 0; i < m.length; i++) peak = Math.max(peak, Math.abs(m[i]));
      if (peak > 0) for (i = 0; i < m.length; i++) m[i] /= peak;
    }
    var up = SDR.filters.interpolate(m, L), mR = up.y;
    for (i = 0; i < mR.length; i++) mR[i] = Math.max(-1, Math.min(1, mR[i])); // interpolation overshoot must not exceed Δf
    return { x: modulate(mR, o), mR: mR, delay: up.groupDelay };
  }

  // Receiver: IF filter → discriminator | PLL → decimate to fsA → audio lowpass (W) → de-emphasis → DC removal.
  // (Decimating before the W lowpass is equivalent and ~20× cheaper than a W filter at fsR.)
  // o: { fsA, fsR, deviation, W, ifBw, demod: 'disc'|'pll', loopBw, zeta, tau, txDelay }
  // Returns { y (fsA, message units), delay (fsA samples from mA to y), inst (fsR, before the audio filter),
  //           ifOut, ifDelay, dc (mean of y before DC removal, i.e. offset/Δf) }.
  function receive(rx, o) {
    var L = Math.round(o.fsR / o.fsA);
    var iff = ifFilter(rx, { fsR: o.fsR, bw: o.ifBw });
    var inst = o.demod === 'pll'
      ? demodPll(iff.y, { fsR: o.fsR, deviation: o.deviation, loopBw: o.loopBw, zeta: o.zeta })
      : demodDiscriminator(iff.y, { fsR: o.fsR, deviation: o.deviation });
    // Pick the decimation phase so the total delay is a whole number of audio samples.
    var decDelay = SDR.filters.decimateFiltered(new Float64Array(0), L).groupDelay;
    var rfDelay = (o.txDelay || 0) + iff.groupDelay + decDelay, phase = rfDelay % L;
    var dec = SDR.filters.decimateFiltered(inst, L, { phase: phase });
    var lp = SDR.filters.lowpass({ cutoff: o.W, fs: o.fsA, transition: 500 });
    var y = SDR.filters.fir(dec.y, lp.taps);
    if (o.tau) y = deEmphasis(y, { fsA: o.fsA, tau: o.tau });
    var delayA = (rfDelay - phase) / L + lp.groupDelay;
    var dc = SDR.filters.dcBlock(y, 2 * delayA); // keep the filters' warm-up out of the mean
    return {
      y: dc.y, delay: delayA + dc.groupDelay,
      inst: inst, ifOut: iff.y, ifDelay: iff.groupDelay, dc: y.length ? y[0] - dc.y[0] : 0
    };
  }

  // Above-threshold output SNR (linear) for message power Pm: 3·Pm·(Δf/W)²·(B_T/W)·CNR, CNR in B_T.
  // For a tone (Pm = ½) with Carson B_T this is the textbook 3β²(β+1)·CNR.
  function theorySnr(o) {
    var b = o.deviation / o.W;
    return 3 * o.pm * b * b * (o.bt / o.W) * o.cnr;
  }

  SDR.fm = {
    beta: beta, carson: carson, modulate: modulate, preEmphasis: preEmphasis, deEmphasis: deEmphasis,
    ifFilter: ifFilter, demodDiscriminator: demodDiscriminator, demodPll: demodPll, countClicks: countClicks,
    transmit: transmit, receive: receive, theorySnr: theorySnr
  };
})();
