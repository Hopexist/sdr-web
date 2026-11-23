// Tiny test runner + core tests + plot demos for tests.html.
(function () {
  'use strict';
  var SDR = window.SDR;
  var results = [];

  function fmt(v) {
    if (typeof v !== 'number') return String(v);
    return v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) ? v.toExponential(6) : String(+v.toPrecision(10));
  }

  function check(name, cond, detail) { results.push({ name: name, pass: !!cond, detail: detail || '' }); }

  function approx(name, actual, expected, tol) {
    var err = Math.abs(actual - expected);
    check(name, err <= tol, 'actual=' + fmt(actual) + '  expected=' + fmt(expected) + '  |err|=' + fmt(err) + '  tol=' + fmt(tol));
  }

  // A throwing group shows up red instead of killing the page. A group may return a Promise (async tests).
  var pending = [];
  function group(name, fn) {
    function fail(e) { check(name + ': unexpected exception', false, e && e.stack ? e.stack : String(e)); }
    try {
      var r = fn();
      if (r && typeof r.then === 'function') pending.push(r.then(null, fail));
    } catch (e) { fail(e); }
  }

  function meanVar(a) {
    var m = 0, i;
    for (i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    var v = 0;
    for (i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
    return [m, v / a.length];
  }

  function arraysClose(a, b, tol) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= tol)) return false;
    return true;
  }

  // ---------------- RNG ----------------
  group('RNG', function () {
    var a = SDR.rng.createRng(1234), b = SDR.rng.createRng(1234), c = SDR.rng.createRng(1235);
    var same = true, diff = false;
    for (var i = 0; i < 1000; i++) {
      var ua = a.uniform(), ub = b.uniform(), uc = c.uniform();
      if (ua !== ub) same = false;
      if (ua !== uc) diff = true;
    }
    check('RNG: same seed → same sequence (1000 draws)', same);
    check('RNG: different seed → different sequence', diff);
    check('RNG: seed exposed', a.seed === 1234, 'seed=' + a.seed);
    check('RNG: default algorithm is xoshiro128**', a.algorithm === 'xoshiro128**', a.algorithm);
    var m1 = SDR.rng.createRng(1234, 'mulberry32'), m2 = SDR.rng.createRng(1234, 'mulberry32'), mSame = true, mDiff = false;
    var x1 = SDR.rng.createRng(1234);
    for (i = 0; i < 1000; i++) { var v1 = m1.uniform(); if (v1 !== m2.uniform()) mSame = false; if (v1 !== x1.uniform()) mDiff = true; }
    check('RNG: mulberry32 still available and reproducible', mSame && mDiff);
    var threwAlgo = false;
    try { SDR.rng.createRng(1, 'nope'); } catch (e) { threwAlgo = true; }
    check('RNG: unknown algorithm throws', threwAlgo);

    var r = SDR.rng.createRng(7), n = 1e6, x = new Float64Array(n);
    for (i = 0; i < n; i++) x[i] = r.randn();
    var mv = meanVar(x);
    approx('RNG: randn mean ≈ 0 (1e6 samples)', mv[0], 0, 0.01);
    approx('RNG: randn variance ≈ 1 (1e6 samples)', mv[1], 1, 0.01);

    var u = SDR.rng.createRng(9), lo = 1, hi = 0;
    for (i = 0; i < 1e5; i++) { var v = u.uniform(); if (v < lo) lo = v; if (v > hi) hi = v; }
    check('RNG: uniform in [0,1)', lo >= 0 && hi < 1, 'min=' + fmt(lo) + ' max=' + fmt(hi));

    var z = SDR.rng.createRng(11).randnComplex(2e5, 2.5);
    approx('RNG: randnComplex total variance ≈ 2.5', SDR.cx.power(z), 2.5, 0.05);
    approx('RNG: randnComplex re variance ≈ 1.25', meanVar(z.re)[1], 1.25, 0.03);
    approx('RNG: randnComplex im variance ≈ 1.25', meanVar(z.im)[1], 1.25, 0.03);

    var bits = SDR.rng.createRng(3).randomBits(1e5), ones = 0, valid = bits instanceof Uint8Array;
    for (i = 0; i < bits.length; i++) { ones += bits[i]; if (bits[i] > 1) valid = false; }
    check('RNG: randomBits is Uint8Array of 0/1', valid);
    approx('RNG: randomBits fraction of ones ≈ 0.5', ones / bits.length, 0.5, 0.01);
  });

  // ---------------- erfc / Q ----------------
  group('erfc/Q', function () {
    var Q = SDR.mathx.Q;
    // High-precision references (the 6-digit values in the spec are themselves off by >1e-6 relative).
    [[0, 0.5], [1, 0.15865525393145707], [3, 1.3498980316301035e-3], [5, 2.866515718791939e-7]].forEach(function (p) {
      approx('Q(' + p[0] + ') rel. err < 1e-6', Q(p[0]) / p[1], 1, 1e-6);
    });
    approx('erfc(-1) = 2 − erfc(1)', SDR.mathx.erfc(-1), 2 - SDR.mathx.erfc(1), 1e-15);
    approx('db2pow(10) = 10', SDR.mathx.db2pow(10), 10, 1e-12);
    approx('db2lin(20) = 10', SDR.mathx.db2lin(20), 10, 1e-12);
    approx('pow2db(db2pow(-3.7)) round trip', SDR.mathx.pow2db(SDR.mathx.db2pow(-3.7)), -3.7, 1e-12);
    check('nextPow2: 1→1, 5→8, 1024→1024', SDR.mathx.nextPow2(1) === 1 && SDR.mathx.nextPow2(5) === 8 && SDR.mathx.nextPow2(1024) === 1024);
    var ls = SDR.mathx.linspace(0, 1, 5);
    check('linspace(0,1,5)', arraysClose(ls, [0, 0.25, 0.5, 0.75, 1], 1e-15), Array.from(ls).join(', '));
  });

  // ---------------- FFT ----------------
  group('FFT', function () {
    var N = 64, k0 = 5;
    var x = SDR.cx.mixFreq(SDR.cx.fromReal(new Float64Array(N).fill(1)), k0, N);
    SDR.fft.fft(x.re, x.im);
    var mag = SDR.cx.abs(x), best = 0;
    for (var i = 1; i < N; i++) if (mag[i] > mag[best]) best = i;
    check('FFT: tone at bin 5 peaks at bin 5', best === k0, 'peak bin=' + best + ' |X|=' + fmt(mag[best]));
    approx('FFT: tone peak magnitude = N', mag[k0], N, 1e-9);

    var r = SDR.rng.createRng(42), M = 1024, z = r.randnComplex(M, 1), orig = SDR.cx.copy(z);
    var e0 = 0;
    for (i = 0; i < M; i++) e0 += z.re[i] * z.re[i] + z.im[i] * z.im[i];
    SDR.fft.fft(z.re, z.im);
    var e1 = 0;
    for (i = 0; i < M; i++) e1 += z.re[i] * z.re[i] + z.im[i] * z.im[i];
    approx('FFT: Parseval Σ|x|² = Σ|X|²/N (rel.)', e1 / M / e0, 1, 1e-12);
    SDR.fft.ifft(z.re, z.im);
    var maxErr = 0;
    for (i = 0; i < M; i++) maxErr = Math.max(maxErr, Math.abs(z.re[i] - orig.re[i]), Math.abs(z.im[i] - orig.im[i]));
    check('FFT: fft→ifft round trip max error < 1e-12', maxErr < 1e-12, 'max err=' + fmt(maxErr));

    var threw = false, msg = '';
    try { SDR.fft.fft(new Float64Array(100), new Float64Array(100)); } catch (e) { threw = true; msg = e.message; }
    check('FFT: non-power-of-2 length throws', threw && /power of 2/.test(msg), msg);

    check('fftshift([0,1,2,3]) = [2,3,0,1]', arraysClose(SDR.fft.fftshift(Float64Array.from([0, 1, 2, 3])), [2, 3, 0, 1], 0));
    check('fftshift([0,1,2,3,4]) = [3,4,0,1,2]', arraysClose(SDR.fft.fftshift(Float64Array.from([0, 1, 2, 3, 4])), [3, 4, 0, 1, 2], 0));
  });

  // ---------------- DSP ----------------
  group('DSP', function () {
    var x = Float64Array.from([3, -1, 4, 1, -5, 9]);
    check('convolve(x, [1]) full = x', arraysClose(SDR.dsp.convolve(x, [1], 'full'), x, 0));
    check('convolve(x, [1]) same = x', arraysClose(SDR.dsp.convolve(x, [1], 'same'), x, 0));
    var full = SDR.dsp.convolve([1, 2, 3], [1, 1], 'full');
    check('convolve([1,2,3],[1,1]) full = [1,3,5,3]', arraysClose(full, [1, 3, 5, 3], 1e-15), Array.from(full).join(', '));
    var same = SDR.dsp.convolve([1, 2, 3, 4], [1, 2, 1], 'same');
    check('convolve([1,2,3,4],[1,2,1]) same = [4,8,12,11]', arraysClose(same, [4, 8, 12, 11], 1e-15), Array.from(same).join(', '));
    var cz = SDR.dsp.convolve({ re: [1, 2, 3], im: [0, 1, 0] }, [1, 1], 'full');
    check('convolve complex: re [1,3,5,3], im [0,1,1,0]', arraysClose(cz.re, [1, 3, 5, 3], 0) && arraysClose(cz.im, [0, 1, 1, 0], 0));
    var up = SDR.dsp.upsample([1, 2, 3], 3);
    check('upsample([1,2,3], 3)', arraysClose(up, [1, 0, 0, 2, 0, 0, 3, 0, 0], 0), Array.from(up).join(', '));
    var dn = SDR.dsp.decimate([0, 1, 2, 3, 4, 5, 6], 3);
    check('decimate([0..6], 3) = [0,3,6]', arraysClose(dn, [0, 3, 6], 0), Array.from(dn).join(', '));
    var h = SDR.dsp.hann(5);
    check('hann(5) = [0, .5, 1, .5, 0]', arraysClose(h, [0, 0.5, 1, 0.5, 0], 1e-15), Array.from(h).map(fmt).join(', '));

    // Welch: unit-power complex tone at 1 kHz, fs = 48 kHz.
    var fs = 48000, nfft = 1024;
    var tone = SDR.cx.mixFreq(SDR.cx.fromReal(new Float64Array(32768).fill(1)), 1000, fs);
    var psd = SDR.dsp.welchPSD(tone, fs, { nfft: nfft });
    var best = 0;
    for (var i = 1; i < nfft; i++) if (psd.psdDb[i] > psd.psdDb[best]) best = i;
    check('Welch: tone peak within one bin of 1 kHz', Math.abs(psd.freqs[best] - 1000) <= fs / nfft, 'peak at ' + fmt(psd.freqs[best]) + ' Hz');
    approx('Welch: tone peak ≈ 0 dB (±1 dB)', psd.psdDb[best], 0, 1);
    check('Welch: freqs span −fs/2 … fs/2', psd.freqs[0] === -fs / 2 && psd.freqs[nfft - 1] < fs / 2);

    // complex.power of e^{jωn}
    approx('cx.power(e^{jωn}) = 1', SDR.cx.power(tone), 1, 1e-12);
    var a = { re: Float64Array.from([1, 2]), im: Float64Array.from([3, -1]) };
    var p = SDR.cx.mul(a, SDR.cx.conj(a));
    check('cx.mul(a, conj(a)) = |a|²', arraysClose(p.re, [10, 5], 1e-15) && arraysClose(p.im, [0, 0], 1e-15));
    var rot = SDR.cx.rotate(a, Math.PI / 2);
    check('cx.rotate by π/2 maps 1+3j → −3+1j', Math.abs(rot.re[0] + 3) < 1e-12 && Math.abs(rot.im[0] - 1) < 1e-12);
  });

  // ---------------- Filters ----------------
  group('Filters', function () {
    var fs = 48000, d = SDR.filters.lowpass({ cutoff: 5000, fs: fs, transition: 500, attenuation: 60 });
    check('lowpass: odd length, group delay = (N−1)/2', d.taps.length % 2 === 1 && d.groupDelay === (d.taps.length - 1) / 2, 'N=' + d.taps.length + ' delay=' + d.groupDelay);
    var N = 1 << 16, re = new Float64Array(N), im = new Float64Array(N);
    re.set(d.taps);
    SDR.fft.fft(re, im);
    var maxDev = 0, maxStop = -Infinity;
    for (var k = 0; k <= N / 2; k++) {
      var f = (k * fs) / N, mag = Math.hypot(re[k], im[k]);
      if (f <= 5000 - 250) maxDev = Math.max(maxDev, Math.abs(mag - 1));
      if (f >= 5000 + 250) maxStop = Math.max(maxStop, 20 * Math.log10(mag));
    }
    check('lowpass: passband ripple ≤ 2δ (δ = 10^(−60/20))', maxDev <= 2 * d.ripple, 'max |H|−1 = ' + fmt(maxDev) + ', δ = ' + fmt(d.ripple));
    check('lowpass: stopband ≤ −59 dB', maxStop <= -59, 'max stopband = ' + maxStop.toFixed(2) + ' dB');
    // Causal FIR delay: an impulse comes out centred at groupDelay.
    var imp = new Float64Array(2000); imp[100] = 1;
    var y = SDR.filters.fir(imp, d.taps), pk = 0;
    for (var i = 0; i < y.length; i++) if (y[i] > y[pk]) pk = i;
    check('fir: impulse peak delayed by groupDelay', pk === 100 + d.groupDelay, 'peak at ' + pk);
    var rx = SDR.rng.createRng(8).randnComplex(20000, 1).re;
    var fast = SDR.filters.fir(rx, d.taps), direct = SDR.dsp.convolve(rx, d.taps, 'full').subarray(0, rx.length), maxE = 0;
    for (i = 0; i < rx.length; i++) maxE = Math.max(maxE, Math.abs(fast[i] - direct[i]));
    check('fir: FFT overlap-add path matches direct convolution (< 1e-12)', maxE < 1e-12, 'max err=' + fmt(maxE));
    var zc = SDR.rng.createRng(9).randnComplex(20000, 1), fc = SDR.filters.firComplex(zc, d.taps);
    var re2 = SDR.filters.fir(zc.re, d.taps), im2 = SDR.filters.fir(zc.im, d.taps), maxC = 0;
    for (i = 0; i < zc.re.length; i++) maxC = Math.max(maxC, Math.abs(fc.re[i] - re2[i]), Math.abs(fc.im[i] - im2[i]));
    check('firComplex: one complex pass = filtering re and im separately (< 1e-12)', maxC < 1e-12, 'max err=' + fmt(maxC));
    var dc = SDR.filters.dcBlock(Float64Array.from([3, 4, 5]));
    check('dcBlock: removes mean, groupDelay 0', arraysClose(dc.y, [-1, 0, 1], 1e-15) && dc.groupDelay === 0);
  });

  // ---------------- AM + channel ----------------
  function tone(n, f, fs) {
    var m = new Float64Array(n);
    for (var i = 0; i < n; i++) m[i] = Math.sin((2 * Math.PI * f * i) / fs);
    return m;
  }
  function corrAligned(ref, out, delay) {
    var sr = 0, so = 0, sro = 0;
    for (var n = delay; n < ref.length - delay; n++) { var r = ref[n], y = out[n + delay]; sr += r * r; so += y * y; sro += r * y; }
    return sro / Math.sqrt(sr * so);
  }

  group('AM', function () {
    var fs = 48000, n = 24000, m = tone(n, 1000, fs);
    var lc = SDR.am.modulate(m, { type: 'DSB-LC', mu: 0.8 });
    var env = SDR.am.demodEnvelope(lc, { fs: fs, audioBw: 5000 });
    var rho = corrAligned(m, env.y, env.delay);
    check('AM loopback: envelope detector, corr > 0.99', rho > 0.99, 'corr=' + fmt(rho) + ' delay=' + env.delay);
    var coh = SDR.am.demodCoherent(lc, { fs: fs, audioBw: 5000, phaseEst: 0 });
    rho = corrAligned(m, coh.y, coh.delay);
    check('AM loopback: coherent detector, corr > 0.99', rho > 0.99, 'corr=' + fmt(rho));

    var sc = SDR.am.modulate(m, { type: 'DSB-SC' }), dphi = 40 * Math.PI / 180;
    var rx = SDR.channel.phaseOffset(sc, dphi);
    var out = SDR.am.demodCoherent(rx, { fs: fs, audioBw: 5000, phaseEst: 0, dcBlock: false });
    var g = SDR.am.measureOutputSnr(m, out.y, out.delay).gain;
    approx('DSB-SC: phase error 40° scales output by cos Δφ (±2%)', g / Math.cos(dphi), 1, 0.02);

    var meas = SDR.am.measureOutputSnr(m, env.y, env.delay);
    check('measureOutputSnr: noiseless loopback > 60 dB', meas.snrDb > 60, 'SNR=' + meas.snrDb.toFixed(1) + ' dB');

    // CNR: refPower / (noise power in bw), bw = 2W = 10 kHz.
    var rng = SDR.rng.createRng(99), cnrs = [0, 20, 35];
    cnrs.forEach(function (c) {
      var y = SDR.channel.addAwgnCnr(lc, c, 10000, fs, rng, { refPower: 1 });
      var noise = SDR.cx.sub(y, lc), cnrMeas = 10 * Math.log10(1 / (SDR.cx.power(noise) * 10000 / fs));
      approx('channel: measured CNR matches ' + c + ' dB (±0.3 dB)', cnrMeas, c, 0.3);
    });
    var y0 = SDR.channel.addAwgnCnr(sc, 10, 10000, fs, SDR.rng.createRng(5));
    var cn = 10 * Math.log10(SDR.cx.power(sc) / (SDR.cx.power(SDR.cx.sub(y0, sc)) * 10000 / fs));
    approx('channel: default refPower = signal power (DSB-SC)', cn, 10, 0.3);
  });

  // ---------------- Controls ----------------
  group('Controls', function () {
    var host = document.createElement('div');
    document.body.appendChild(host);
    var got = [];
    var s = SDR.ui.slider({ key: 'mu', label: 'μ', min: 0, max: 1.5, step: 0.01, value: 0.8, onInput: function (v) { got.push(v); } });
    host.appendChild(s.el);
    s.range.value = 1.23; s.range.dispatchEvent(new Event('input'));
    check('slider: range → number box', s.number.value === '1.23' && s.get() === 1.23 && got[got.length - 1] === 1.23, 'number=' + s.number.value);
    s.number.value = '0.456'; s.number.dispatchEvent(new Event('change'));
    check('slider: number box → range (quantized to step)', Math.abs(+s.range.value - 0.46) < 1e-9 && s.get() === 0.46, 'range=' + s.range.value);
    s.number.value = '9'; s.number.dispatchEvent(new Event('change'));
    check('slider: number box clamps to max', s.get() === 1.5 && s.range.value === '1.5');

    var lg = SDR.ui.slider({ key: 'f', label: 'f', min: 100, max: 5000, log: true, value: 1000 });
    host.appendChild(lg.el);
    lg.range.value = 1000; lg.range.dispatchEvent(new Event('input'));
    approx('log slider: top of range = max', lg.get(), 5000, 1e-9);
    lg.number.value = '316'; lg.number.dispatchEvent(new Event('change'));
    approx('log slider: number → position', +lg.range.value, Math.round(1000 * Math.log(3.16) / Math.log(50)), 0);

    var defaults = { mu: 0.8, cnr: 20, noise: true, demod: 'envelope', seed: 1 };
    var st = { mu: 1.25, cnr: -3.5, noise: false, demod: 'coherent', seed: 42 };
    var back = SDR.ui.decodeHash('#' + SDR.ui.encodeHash(st), defaults);
    check('hash: encode → decode round trip', JSON.stringify(back) === JSON.stringify(st), SDR.ui.encodeHash(st));
    var partial = SDR.ui.decodeHash('#cnr=7&bogus=1&mu=abc', defaults);
    check('hash: missing/unknown/invalid keys fall back to defaults', partial.cnr === 7 && partial.mu === 0.8 && !('bogus' in partial));

    var tg = SDR.ui.toggle({ key: 'noise', label: 'n', checked: true });
    var se = SDR.ui.select({ key: 'demod', label: 'd', options: ['envelope', 'coherent'], value: 'envelope' });
    var ctrls = [s, tg, se];
    SDR.ui.applyState(ctrls, SDR.ui.decodeHash('#' + SDR.ui.encodeHash({ mu: 0.33, noise: false, demod: 'coherent' }), { mu: 0, noise: true, demod: '' }));
    var after = SDR.ui.stateOf(ctrls);
    check('hash → controls → state round trip', after.mu === 0.33 && after.noise === false && after.demod === 'coherent', JSON.stringify(after));
    host.remove();
  });

  // ---------------- Plot (smoke) ----------------
  group('Plot', function () {
    var c = document.createElement('canvas');
    var p = SDR.plot.createPlot(c, { width: 400, height: 250, yScale: 'log', title: 'smoke' });
    p.setSeries([
      { type: 'line', x: [0, 1, 2], y: [1, 0.1, 0.01], label: 'line' },
      { type: 'scatter', x: [0, 1, 2], y: [1, 0.1, 0.01], label: 'pts' },
      { type: 'errorbar', x: [0, 1, 2], y: [1, 0.1, 0.01], yLow: [0.5, 0.05, 0.005], yHigh: [2, 0.2, 0.02], label: 'err' }
    ]);
    var url = p.toPNG();
    check('Plot: line/scatter/errorbar on log axis draw; toPNG gives PNG data URL', /^data:image\/png;base64,/.test(url), url.slice(0, 30) + '…');
    check('Plot: not zoomed initially', !p.isZoomed());
    p.setView({ x0: 0.5, x1: 1.5, y0: 0.01, y1: 1 });
    p.setData([{ type: 'line', x: [0, 1, 2, 3], y: [1, 0.5, 0.2, 0.1], label: 'new' }]);
    var v = p.getView();
    check('Plot: setData keeps user zoom', v && v.x0 === 0.5 && v.x1 === 1.5);
    p.draw();
    var csv = p.toCSV().trim().split('\n');
    check('Plot: CSV exports only the visible x-range', csv[0] === 'series,x,y' && csv.length === 2 && csv[1] === 'new,1,0.5', csv.join(' | '));
    p.resetView();
    check('Plot: resetView returns to auto', !p.isZoomed());
    p.destroy();
  });

  // ---------------- Phase 2: rate change, emphasis, Bessel, FM ----------------
  group('Rate change', function () {
    var fs = 48000, n = 4800, x = tone(n, 1000, fs);
    var up = SDR.filters.interpolate(x, 8), dn = SDR.filters.decimateFiltered(up.y, 8, { phase: 0 });
    var D = up.groupDelay + dn.groupDelay, ph = D % 8;
    dn = SDR.filters.decimateFiltered(up.y, 8, { phase: ph });
    var d = (D - ph) / 8, e = 0, p = 0;
    for (var k = 200; k < n - 200; k++) { var r = x[k - d]; p += r * r; e += (dn.y[k] - r) * (dn.y[k] - r); }
    var errDb = 10 * Math.log10(e / p);
    check('interpolate ×8 → decimate ÷8 round trip of a 1 kHz tone < −60 dB', errDb < -60, 'error = ' + errDb.toFixed(1) + ' dB, delay = ' + d + ' samples @48k');
    var cz = SDR.filters.interpolate({ re: Float64Array.from([1, 0, 0]), im: new Float64Array(3) }, 4);
    check('interpolate accepts complex input', cz.y.re.length === 12 && cz.y.im.length === 12);

    var tn = tone(9600, 3000, fs), emp = SDR.fm.deEmphasis(SDR.fm.preEmphasis(tn, { fsA: fs, tau: 75e-6 }), { fsA: fs, tau: 75e-6 }), me = 0;
    for (k = 0; k < tn.length; k++) me = Math.max(me, Math.abs(emp[k] - tn[k]));
    check('deEmphasis(preEmphasis(x)) ≈ x (3 kHz tone, 75 µs)', me < 1e-9, 'max err = ' + fmt(me));
    var pre = SDR.fm.preEmphasis(tn, { fsA: fs, tau: 75e-6 }), pk = 0;
    for (k = 4800; k < tn.length; k++) pk = Math.max(pk, Math.abs(pre[k]));
    check('pre-emphasis boosts a 3 kHz tone (raises peak deviation)', pk > 1.5, 'gain = ' + pk.toFixed(2));
  });

  group('Bessel', function () {
    var J = SDR.mathx.besselJ;
    [[0, 1, 0.7651976865579666], [1, 1, 0.44005058574493355], [2, 5, 0.04656511627775222], [0, 10, -0.2459357644513483],
      [1, 10, 0.04347274616886144], [5, 10, -0.2340615281867936], [0, 2.404825557695773, 0], [-3, 2, -0.12894324947440206]].forEach(function (t) {
      approx('J_' + t[0] + '(' + +t[1].toFixed(4) + ') to 1e-8', J(t[0], t[1]), t[2], 1e-8);
    });
  });

  var FSA = 48000, FSR = 384000;
  function fmLoop(beta, demod, extra) {
    var W = 3000, dev = beta * W, mA = tone(24000, 1000, FSA);
    var tx = SDR.fm.transmit(mA, { fsA: FSA, fsR: FSR, deviation: dev });
    var rx = extra && extra.rx ? extra.rx(tx.x) : tx.x;
    var r = SDR.fm.receive(rx, { fsA: FSA, fsR: FSR, deviation: dev, W: W, ifBw: SDR.fm.carson(dev, W), demod: demod, loopBw: 30000, txDelay: tx.delay });
    return { mA: mA, tx: tx, r: r, dev: dev, W: W };
  }

  group('FM', function () {
    [0.5, 2, 5].forEach(function (b) {
      ['disc', 'pll'].forEach(function (d) {
        var L = fmLoop(b, d), rho = corrAligned(L.mA, L.r.y, L.r.delay);
        check('FM loopback ' + (d === 'pll' ? 'PLL' : 'discriminator') + ', β = ' + b + ': corr > 0.99', rho > 0.99, 'corr = ' + rho.toFixed(6));
      });
    });

    [2, 5].forEach(function (b) {
      var W = 3000, dev = b * W, n = 1 << 16, m = tone(n, W, FSR);
      var obw = SDR.dsp.occupiedBandwidth(SDR.fm.modulate(m, { fsR: FSR, deviation: dev }), FSR);
      var car = SDR.fm.carson(dev, W);
      check('98% bandwidth within 10% of Carson, β = ' + b, Math.abs(obw / car - 1) < 0.1, 'measured ' + obw.toFixed(0) + ' Hz, Carson ' + car + ' Hz');
    });

    // Exactly periodic tone (128 cycles in 2^15 samples) → each line sits in one FFT bin.
    [1, 2.4].forEach(function (b) {
      var N = 1 << 15, fm = 1500, m = tone(N, fm, FSR), x = SDR.fm.modulate(m, { fsR: FSR, deviation: b * fm });
      SDR.fft.fft(x.re, x.im);
      for (var k = 0; k <= 3; k++) {
        var bin = k * 128, pw = (x.re[bin] * x.re[bin] + x.im[bin] * x.im[bin]) / (N * N), th = Math.pow(SDR.mathx.besselJ(k, b), 2);
        approx('line ' + k + ' power = J_' + k + '(' + b + ')² within 0.5 dB', 10 * Math.log10(pw), 10 * Math.log10(th), 0.5);
      }
    });

    // Above threshold: CNR 25 dB in B_T, β = 2 → theory 3β²(β+1)·CNR.
    var W = 3000, dev = 6000, bt = SDR.fm.carson(dev, W), mA = tone(24000, 1000, FSA);
    var tx = SDR.fm.transmit(mA, { fsA: FSA, fsR: FSR, deviation: dev });
    var rx = SDR.channel.addAwgnCnr(tx.x, 25, bt, FSR, SDR.rng.createRng(21), { refPower: 1 });
    var r = SDR.fm.receive(rx, { fsA: FSA, fsR: FSR, deviation: dev, W: W, ifBw: bt, demod: 'disc', txDelay: tx.delay });
    var meas = SDR.dsp.measureOutputSnr(mA, r.y, r.delay).snrDb;
    var th = 10 * Math.log10(3 * 4 * 3 * Math.pow(10, 2.5));
    approx('FM above threshold (CNR 25 dB, β = 2): SNR within 1.5 dB of 3β²(β+1)·CNR', meas, th, 1.5);
    var clicks = SDR.fm.countClicks(r.ifOut, SDR.fm.ifFilter(tx.x, { fsR: FSR, bw: bt }).y, 2 * r.ifDelay);
    check('FM clicks: none at 25 dB CNR', clicks === 0, clicks + ' clicks');
    var rxLow = SDR.channel.addAwgnCnr(tx.x, 2, bt, FSR, SDR.rng.createRng(22), { refPower: 1 });
    var rLow = SDR.fm.receive(rxLow, { fsA: FSA, fsR: FSR, deviation: dev, W: W, ifBw: bt, demod: 'disc', txDelay: tx.delay });
    var clicksLow = SDR.fm.countClicks(rLow.ifOut, SDR.fm.ifFilter(tx.x, { fsR: FSR, bw: bt }).y, 2 * rLow.ifDelay);
    check('FM clicks: many at 2 dB CNR', clicksLow > 20, clicksLow + ' clicks in 0.5 s');

    // Frequency offset → DC of offset/Δf before DC removal.
    var off = 2000, Lo = fmLoop(2, 'disc', { rx: function (x) { return SDR.channel.freqOffset(x, off, FSR); } }), s = 0, cnt = 0;
    for (var i = 2000; i < Lo.r.inst.length; i++) { s += Lo.r.inst[i]; cnt++; }
    approx('frequency offset 2 kHz → discriminator DC = 2k/6k', s / cnt, off / Lo.dev, 0.005);
    approx('… and the audio output DC before removal matches', Lo.r.dc, off / Lo.dev, 0.005);
  });

  group('runChunked', function () {
    // Iteration cap: under headless --virtual-time-budget, performance.now() does not advance while spinning.
    function busy(ms) { var t = performance.now(); for (var k = 0; k < 2e6 && performance.now() - t < ms; k++) { /* spin */ } }
    var finallyRan = false;
    function* work() { for (var i = 0; i < 60; i++) { busy(2); yield i / 60; } return 'ok'; }
    function* endless() { try { for (;;) { busy(2); yield 0; } } finally { finallyRan = true; } }
    var p1 = SDR.ui.runChunked(work).then(function (res) {
      check('runChunked: completes and returns the generator value', res.done && res.value === 'ok', res.slices + ' slices');
      check('runChunked: no slice blocks more than 20 ms', res.maxSliceMs < 20, 'max slice ' + res.maxSliceMs.toFixed(1) + ' ms');
    });
    var ac = new AbortController(), progressSeen = 0;
    var p2 = SDR.ui.runChunked(endless, { signal: ac.signal, onProgress: function () { if (++progressSeen === 2) ac.abort(); } }).then(function (res) {
      check('runChunked: abort stops the task and runs its finally', res.aborted === true && finallyRan, 'aborted after ' + res.slices + ' slices');
    });
    return Promise.all([p1, p2]);
  });

  // ---------------- Phase 3: QPSK ----------------
  var IDEAL = { cfo: 'ideal', timing: 'ideal', carrier: 'ideal', frame: 'ideal' };
  function runUntil(cfg, minErr, maxBits, seed) {
    var rng = SDR.rng.createRng(seed), e = 0, n = 0;
    while (e < minErr && n < maxBits) { var r = SDR.qpsk.runLink(cfg, rng); e += r.errors; n += r.bitsTx.length; }
    return { e: e, n: n, ber: e / n, ci: SDR.theory.wilsonInterval(e, n) };
  }
  function inCi(th, r) { return th >= r.ci[0] && th <= r.ci[1]; }
  function ciText(r, th) { return 'BER ' + r.ber.toExponential(3) + ' (' + r.e + '/' + r.n + '), CI [' + r.ci[0].toExponential(2) + ', ' + r.ci[1].toExponential(2) + '], theory ' + th.toExponential(3); }

  group('QPSK mapping', function () {
    var bits = SDR.rng.createRng(31).randomBits(2000), s = SDR.mapping.qpskMap(bits), back = SDR.mapping.qpskDemapHard(s), same = true;
    for (var i = 0; i < bits.length; i++) if (bits[i] !== back[i]) same = false;
    check('map → hard demap round trip', same);
    approx('mean |s|² = 1 (Es = 1)', SDR.cx.power(s), 1, 1e-12);
    // Points in angular order: 00 (45°), 10 (135°), 11 (225°), 01 (315°). Each pair of neighbours must differ by one bit.
    var order = [[0, 0], [1, 0], [1, 1], [0, 1]], ok = true, detail = [];
    for (var a = 0; a < 4; a++) {
      var A = order[a], B = order[(a + 1) % 4];
      var pa = SDR.mapping.qpskMap(Uint8Array.from(A)), pb = SDR.mapping.qpskMap(Uint8Array.from(B));
      var ang = Math.atan2(pb.im[0], pb.re[0]) - Math.atan2(pa.im[0], pa.re[0]);
      ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      var diff = (A[0] !== B[0]) + (A[1] !== B[1]);
      if (Math.abs(ang - Math.PI / 2) > 1e-9 || diff !== 1) ok = false;
      detail.push(A.join('') + '→' + B.join('') + ' ' + Math.round(ang * 180 / Math.PI) + '°');
    }
    check('Gray: 90°-adjacent points differ in exactly one bit', ok, detail.join(', '));
    var llr = SDR.mapping.qpskDemapLlr({ re: Float64Array.from([0.5]), im: Float64Array.from([-0.25]) }, 0.1);
    approx('LLR = 2√2·y/N0 (I axis)', llr[0], 2 * Math.SQRT2 * 0.5 / 0.1, 1e-12);
    var enc = SDR.mapping.diffEncode(bits, 0), rotOk = true;
    [0, 1, 2, 3].forEach(function (q) {
      var rr = SDR.cx.rotate(enc, q * Math.PI / 2), rref = { re: Math.cos(Math.PI / 4 + q * Math.PI / 2), im: Math.sin(Math.PI / 4 + q * Math.PI / 2) };
      var dec = SDR.mapping.diffDecode(rr, rref);
      for (var k = 0; k < bits.length; k++) if (dec[k] !== bits[k]) rotOk = false;
    });
    check('differential encode/decode round trip under 0/90/180/270° rotation', rotOk);
  });

  group('LFSR', function () {
    [5, 6, 7, 8, 9, 10].forEach(function (m) {
      var s = SDR.seq.mseq(m), N = s.length, ones = 0, i, k, ok = true;
      for (i = 0; i < N; i++) ones += s[i];
      // Periodic autocorrelation of the ±1 version: N at lag 0, −1 at every other lag.
      for (k = 1; k < N && ok; k++) { var acc = 0; for (i = 0; i < N; i++) acc += (1 - 2 * s[i]) * (1 - 2 * s[(i + k) % N]); if (acc !== -1) ok = false; }
      check('m-sequence degree ' + m + ': period ' + N + ' = 2^m − 1, ' + ones + ' ones, autocorrelation −1 off-peak', N === (1 << m) - 1 && ones === 1 << (m - 1) && ok);
    });
  });

  group('RRC', function () {
    [0.2, 0.35, 0.5].forEach(function (b) {
      var h = SDR.filters.rrcTaps(b, 8, 16), e = 0, i;
      for (i = 0; i < h.taps.length; i++) e += h.taps[i] * h.taps[i];
      var p = SDR.dsp.convolve(h.taps, h.taps, 'full'), c = 2 * h.groupDelay, isi = 0;
      for (var k = 1; c + k * 8 < p.length; k++) isi += p[c + k * 8] * p[c + k * 8] + p[c - k * 8] * p[c - k * 8];
      var isiDb = 10 * Math.log10(isi / (p[c] * p[c]));
      check('RRC β = ' + b + ': unit energy, odd length, RRC∗RRC ISI < −40 dB (span 16)', Math.abs(e - 1) < 1e-12 && h.taps.length % 2 === 1 && isiDb < -40, 'ISI ' + isiDb.toFixed(1) + ' dB, N = ' + h.taps.length);
    });
    var hs = SDR.filters.rrcTaps(0.25, 4, 8); // t = ±Ts/(4β) = ±1 symbol lands exactly on a tap
    check('RRC special case t = ±Ts/(4β) is finite', Array.prototype.every.call(hs.taps, isFinite));
  });

  group('Channel conventions', function () {
    [4, 8].forEach(function (sps) {
      var rng = SDR.rng.createRng(9), tx = SDR.qpsk.transmit(Object.assign({}, SDR.qpsk.DEFAULTS, { sps: sps, nBits: 200000 }), rng);
      var y = SDR.channel.addAwgnEbN0(tx.x, 6, { bitsPerSymbol: 2, sps: sps }, rng), L = tx.x.re.length;
      var ps = SDR.cx.power({ re: tx.x.re.subarray(2000, L - 2000), im: tx.x.im.subarray(2000, L - 2000) }), pn = SDR.cx.power(SDR.cx.sub(y, tx.x));
      approx('per-sample SNR = Es/N0 − 10·log10(sps) at sps ' + sps + ' (±0.1 dB)', 10 * Math.log10(ps / pn), SDR.channel.snrPerSampleDb(6, 2, sps), 0.1);
    });
    var x = tone(4000, 2400, 48000), d = 3.37, y2 = SDR.filters.fractionalDelay(x, d), e = 0, p = 0;
    for (var n = 100; n < 3900; n++) { var r = Math.sin(2 * Math.PI * 2400 * (n - d) / 48000); e += (y2[n] - r) * (y2[n] - r); p += r * r; }
    var eDb = 10 * Math.log10(e / p);
    check('fractionalDelay 3.37 samples on an in-band tone (0.05 fs) < −50 dB', eDb < -50, 'error ' + eDb.toFixed(1) + ' dB');
    var z = SDR.channel.apply({ re: Float64Array.from([1, 2]), im: new Float64Array(2) }, [{ type: 'phase', deg: 90 }, { type: 'awgn', enabled: false }], null);
    check('channel.apply: composable list, disabled entries skipped', Math.abs(z.im[1] - 2) < 1e-12 && Math.abs(z.re[1]) < 1e-12);
  });

  group('QPSK link', function () {
    [2, 4, 8].forEach(function (sps) {
      var r = SDR.qpsk.runLink({ noise: false, sps: sps, rx: IDEAL }, SDR.rng.createRng(1));
      check('noiseless loopback, all stages ideal, sps ' + sps + ': 0 errors', r.errors === 0, r.errors + ' errors, EVM ' + r.evmDb.toFixed(1) + ' dB');
    });
    var cases = [['phase 0°', { phaseDeg: 0 }], ['phase 90°', { phaseDeg: 90 }], ['phase 180°', { phaseDeg: 180 }], ['phase 270°', { phaseDeg: 270 }],
      ['CFO +0.02 Rs', { cfoRs: 0.02 }], ['CFO −0.02 Rs', { cfoRs: -0.02 }], ['timing 0.1', { timingSym: 0.1 }], ['timing 0.5', { timingSym: 0.5 }],
      ['timing 0.9', { timingSym: 0.9 }], ['drift +100 ppm', { driftPpm: 100 }], ['drift −100 ppm', { driftPpm: -100 }]];
    cases.forEach(function (c) {
      var r = SDR.qpsk.runLink({ noise: false, sps: 4, channel: c[1] }, SDR.rng.createRng(2));
      check('noiseless, all stages real, ' + c[0] + ': 0 errors after lock', r.errors === 0 && r.lock.timing.locked && r.lock.carrier.locked,
        r.errors + ' errors; timing lock ' + r.lock.timing.convergence + ' sym, carrier lock ' + r.lock.carrier.convergence + ' sym');
    });
    var txt = 'Hello from Buffalo!', rt = SDR.qpsk.runLink({ noise: false, sps: 4, bits: SDR.qpsk.textToBits(txt), channel: { phaseDeg: 70, cfoRs: 0.01, timingSym: 0.3 } }, SDR.rng.createRng(3));
    var back = SDR.qpsk.bitsToText(rt.bitsRx);
    check('text mode: "' + txt + '" round-trips exactly (no noise, real sync)', back === txt, JSON.stringify(back));
    var rd = SDR.qpsk.runLink({ noise: false, sps: 4, diff: true, channel: { phaseDeg: 130 } }, SDR.rng.createRng(4));
    check('differential mode, noiseless, phase 130°: 0 errors', rd.errors === 0, rd.errors + ' errors');

    var cfoR = SDR.qpsk.runLink({ ebn0Db: 10, sps: 4, nBits: 20000, channel: { cfoRs: 0.0371 } }, SDR.rng.createRng(5));
    check('4th-power CFO estimate within 1e-3 Rs (10 dB, true 0.0371 Rs)', Math.abs(cfoR.est.fHat * 4 - 0.0371) < 1e-3, 'estimate ' + (cfoR.est.fHat * 4).toFixed(6) + ' Rs');
    var g = SDR.qpsk.runLink({ noise: false, sps: 4, channel: { timingSym: 0.5 } }, SDR.rng.createRng(6));
    check('Gardner converges within 500 symbols (default BnT, offset 0.5)', g.lock.timing.locked && g.lock.timing.convergence < 500, g.lock.timing.convergence + ' symbols');
    var pl = SDR.qpsk.runLink({ noise: false, sps: 4, channel: { phaseDeg: 40 } }, SDR.rng.createRng(7));
    check('carrier PLL locks within 300 symbols (default BnT, 40°)', pl.lock.carrier.locked && pl.lock.carrier.convergence < 300, pl.lock.carrier.convergence + ' symbols');
  });

  group('QPSK BER vs theory', function () {
    // Symbol level, no pulse shaping: complex noise of variance N0 per symbol.
    [0, 4, 7].forEach(function (eb, idx) {
      var rng = SDR.rng.createRng(40 + idx), N0 = Math.pow(10, -SDR.channel.esn0Db(eb, 2) / 10), e = 0, n = 0;
      while (e < 200) {
        var bits = rng.randomBits(20000), s = SDR.mapping.qpskMap(bits), y = SDR.cx.add(s, rng.randnComplex(s.re.length, N0)), d = SDR.mapping.qpskDemapHard(y);
        for (var i = 0; i < bits.length; i++) if (d[i] !== bits[i]) e++;
        n += bits.length;
      }
      var r = { e: e, n: n, ber: e / n, ci: SDR.theory.wilsonInterval(e, n) }, th = SDR.theory.qpskAwgn(eb);
      check('symbol-level AWGN BER at ' + eb + ' dB inside Wilson 95% CI of theory (≥200 errors)', inCi(th, r), ciText(r, th));
    });
    [0, 4, 7].forEach(function (eb) {
      var r = runUntil({ ebn0Db: eb, sps: 4, nBits: 100000, rx: IDEAL }, 200, 5e6, 50 + eb), th = SDR.theory.qpskAwgn(eb);
      check('full RRC link, ideal sync, ' + eb + ' dB: inside Wilson CI of theory', inCi(th, r), ciText(r, th));
    });
    var rs = runUntil({ ebn0Db: 8, sps: 4, nBits: 100000 }, 1e9, 500000, 5), eq = SDR.theory.qpskEbn0ForBer(rs.ber);
    check('real sync at 8 dB: implementation loss < 0.5 dB', 8 - eq < 0.5 && rs.e > 30, 'BER ' + rs.ber.toExponential(3) + ' (' + rs.e + ' errors) ≙ ' + eq.toFixed(2) + ' dB → loss ' + (8 - eq).toFixed(2) + ' dB');
    var ph = runUntil({ ebn0Db: 6, sps: 4, nBits: 100000, channel: { phaseDeg: 20 }, rx: { cfo: 'ideal', timing: 'ideal', carrier: 'off', frame: 'ideal' } }, 300, 5e6, 7);
    var thp = SDR.theory.qpskPhaseError(6, 20 * Math.PI / 180);
    check('static phase error 20° (carrier off), 6 dB: matches qpskPhaseError', inCi(thp, ph), ciText(ph, thp));
    var w = SDR.theory.wilsonInterval(10, 100);
    check('wilsonInterval(10, 100) ≈ [0.0552, 0.1744]', Math.abs(w[0] - 0.0552) < 1e-3 && Math.abs(w[1] - 0.1744) < 1e-3, w.map(function (v) { return v.toFixed(4); }).join(', '));
  });

  // ---------------- Phase 4: streaming link, channel model, equalizers ----------------
  group('Streaming link', function () {
    var cfgs = [['default, 10 dB', { ebn0Db: 10, span: 10 }],
      ['everything on, 8 dB', { ebn0Db: 8, span: 10, channel: { phaseDeg: 30, cfoRs: 0.03, timingSym: 0.6, driftPpm: 100 } }]];
    cfgs.forEach(function (c) {
      var b = SDR.qpsk.runLinkBatch(c[1], SDR.rng.createRng(11));
      [64, 257, 4096].forEach(function (bs) {
        var s = SDR.qpsk.runLink(Object.assign({}, c[1], { blockSymbols: bs }), SDR.rng.createRng(11)), diff = 0;
        for (var i = 0; i < b.bitsRx.length; i++) if (b.bitsRx[i] !== s.bitsRx[i]) diff++;
        check('streaming = batch bit-exact (' + c[0] + ', block ' + bs + ' symbols)', diff === 0 && s.errors === b.errors && s.frameStart === b.frameStart,
          diff + ' bits differ; errors ' + s.errors + ' vs ' + b.errors);
      });
    });
    var h = SDR.filters.rrcTaps(0.2, 8, SDR.filters.rrcAutoSpan(0.2)), p = SDR.dsp.convolve(h.taps, h.taps, 'full'), c0 = 2 * h.groupDelay, isi = 0;
    for (var k = 1; c0 + k * 8 < p.length; k++) isi += p[c0 + k * 8] * p[c0 + k * 8] + p[c0 - k * 8] * p[c0 - k * 8];
    var isiDb = 10 * Math.log10(isi / (p[c0] * p[c0]));
    check('RRC automatic span (β 0.2 → ' + SDR.filters.rrcAutoSpan(0.2) + ' symbols): ISI < −45 dB', isiDb < -45, 'ISI ' + isiDb.toFixed(1) + ' dB');
  });

  group('Channel identity', function () {
    var rng = SDR.rng.createRng(3), x = rng.randnComplex(2000, 1);
    var off = [{ type: 'timing', sym: 0, sps: 4 }, { type: 'drift', ppm: 0 }, { type: 'cfo', fRs: 0, sps: 4 }, { type: 'phasenoise', linewidthTs: 0, sps: 4 },
      { type: 'phase', deg: 0 }, { type: 'iq', epsDb: 0, phiDeg: 0 }, { type: 'dc', rel: 0 }, { type: 'awgn', enabled: false }];
    var y = SDR.channel.apply(x, off, rng), same = y.re.length === x.re.length;
    for (var i = 0; same && i < x.re.length; i++) if (y.re[i] !== x.re[i] || y.im[i] !== x.im[i]) same = false;
    check('every impairment off → channel is exactly the identity', same);
  });

  group('Fading', function () {
    var f = SDR.channel.createFading({ model: 'rayleigh', mode: 'block', blockSymbols: 1, sps: 1 }, SDR.rng.createRng(1)), n = 200000, pw = 0, R = [0.3, 0.7, 1.2], cnt = [0, 0, 0], i;
    for (i = 0; i < n; i++) { var hh = f.hAt(i), a = Math.hypot(hh.re, hh.im); pw += a * a; R.forEach(function (r, j) { if (a < r) cnt[j]++; }); }
    approx('Rayleigh: E|h|² = 1 (±1%)', pw / n, 1, 0.01);
    R.forEach(function (r, j) { approx('Rayleigh CDF P(|h| < ' + r + ') = 1 − e^{−r²}', cnt[j] / n, 1 - Math.exp(-r * r), 0.005); });
    var fd = 0.01, lags = [10, 25, 50], acc = [0, 0, 0], P = 0, real = 60, len = 3000;
    for (var s = 0; s < real; s++) {
      var g = SDR.channel.createFading({ mode: 'jakes', fdTs: fd, sps: 1 }, SDR.rng.createRng(100 + s)), hr = new Float64Array(len), hi = new Float64Array(len);
      for (i = 0; i < len; i++) { var v = g.hAt(i); hr[i] = v.re; hi[i] = v.im; }
      for (i = 0; i < len - 60; i++) { P += hr[i] * hr[i] + hi[i] * hi[i]; lags.forEach(function (L, j) { acc[j] += hr[i + L] * hr[i] + hi[i + L] * hi[i]; }); }
    }
    approx('Jakes: E|h|² = 1 (±2%)', P / (real * (len - 60)), 1, 0.02);
    lags.forEach(function (L, j) { approx('Jakes autocorrelation at lag ' + L + ' ≈ J0(2π·fd·τ) (fd·Ts = 0.01)', acc[j] / P, SDR.mathx.besselJ(0, 2 * Math.PI * fd * L), 0.05); });
    [10, 20].forEach(function (kDb) {
      var g = SDR.channel.createFading({ model: 'rician', mode: 'block', blockSymbols: 1, sps: 1, kDb: kDb }, SDR.rng.createRng(5)), mr = 0, mi = 0, p2 = 0, N = 100000;
      for (i = 0; i < N; i++) { var v = g.hAt(i); mr += v.re; mi += v.im; p2 += v.re * v.re + v.im * v.im; }
      mr /= N; mi /= N;
      approx('Rician: measured K = ' + kDb + ' dB (±0.5 dB)', 10 * Math.log10((mr * mr + mi * mi) / (p2 / N - mr * mr - mi * mi)), kDb, 0.5);
    });
    approx('qpskRician(K → −∞) = qpskRayleigh (10 dB)', SDR.theory.qpskRician(10, -Infinity) / SDR.theory.qpskRayleigh(10), 1, 1e-6);
    approx('Rician K = 20 dB is within 0.5 dB of AWGN (at 10 dB)', SDR.theory.qpskEbn0ForBer(SDR.theory.qpskRician(10, 20)), 10, 0.5);
  });

  group('BER under fading', function () {
    [0, 10, 20].forEach(function (eb) {
      var r = runUntil({ ebn0Db: eb, sps: 4, nBits: 20000, rx: IDEAL, channel: { fading: { model: 'rayleigh', mode: 'block', blockSymbols: 1 } } }, 300, 4e6, eb + 1);
      var th = SDR.theory.qpskRayleigh(eb);
      check('Rayleigh block fading + ideal CSI, ' + eb + ' dB: inside Wilson CI of qpskRayleigh', inCi(th, r), ciText(r, th));
    });
    var rk = runUntil({ ebn0Db: 10, sps: 4, nBits: 20000, rx: IDEAL, channel: { fading: { model: 'rician', mode: 'block', blockSymbols: 1, kDb: 10 } } }, 300, 4e6, 3);
    var thk = SDR.theory.qpskRician(10, 10);
    check('Rician K = 10 dB, 10 dB: inside Wilson CI of qpskRician', inCi(thk, rk), ciText(rk, thk));
    var jk = { model: 'rayleigh', mode: 'jakes', fdTs: 1e-3 };
    var a = runUntil({ ebn0Db: 20, sps: 4, nBits: 40000, rx: IDEAL, channel: { fading: jk } }, 200, 2e6, 1);
    var b = runUntil({ ebn0Db: 20, sps: 4, nBits: 40000, pilotEvery: 8, rx: Object.assign({}, IDEAL, { carrier: 'pilot' }), channel: { fading: jk } }, 200, 2e6, 1);
    var loss = SDR.theory.rayleighEbn0ForBer(a.ber) - SDR.theory.rayleighEbn0ForBer(b.ber);
    check('pilot-aided (every 8) at fd·Ts = 1e-3, 20 dB: within 2 dB of ideal CSI', loss < 2,
      'ideal ' + a.ber.toExponential(2) + ', pilot ' + b.ber.toExponential(2) + ' → ' + loss.toFixed(2) + ' dB');
  });

  group('Equalizers', function () {
    var mild = SDR.channel.multipathPresets('mild');
    var lms = SDR.qpsk.runLink({ ebn0Db: 12, sps: 4, nBits: 20000, channel: { multipath: { taps: mild } }, rx: { eq: 'lms', eqTaps: 11, eqMain: 3, eqMu: 0.02 } }, SDR.rng.createRng(2));
    var ref = SDR.qpsk.runLink({ ebn0Db: 12, sps: 4, nBits: 20000 }, SDR.rng.createRng(2));
    check('LMS on "3-tap mild" converges within 300 symbols', lms.eq.convergence < 300, lms.eq.convergence + ' symbols, MSE ' + lms.eq.mseDb.toFixed(1) + ' dB');
    // At 12 dB both BERs are ~1e-8 (unmeasurable), so compare the Es/N0 each link delivers (from EVM).
    check('LMS at 12 dB: within 1 dB of the no-multipath link (Es/N0 from EVM)', ref.esn0EstDb - lms.esn0EstDb < 1 && lms.errors === 0,
      'no multipath ' + ref.esn0EstDb.toFixed(2) + ' dB, LMS ' + lms.esn0EstDb.toFixed(2) + ' dB, errors ' + lms.errors);
    var q = SDR.qpsk.runLink({ noise: false, sps: 4, nBits: 8000, channel: { multipath: { taps: mild } }, rx: { eq: 'lms', eqTaps: 11, eqMain: 3, eqMu: 0.05 } }, SDR.rng.createRng(2));
    var f = []; for (var i = 0; i < 64; i++) f.push(-0.5 + i / 64);
    var resp = SDR.eq.responseDb(q.eq.combined, f), mean = resp.reduce(function (s, v) { return s + v; }, 0) / resp.length, dev = 0;
    resp.forEach(function (v) { dev = Math.max(dev, Math.abs(v - mean)); });
    check('channel·equalizer response flat within ±1 dB once converged (LMS, noiseless)', dev < 1, '±' + dev.toFixed(2) + ' dB');
    var cma = SDR.qpsk.runLink({ ebn0Db: 15, sps: 4, nBits: 8000, channel: { multipath: { taps: mild }, phaseDeg: 50 }, rx: { eq: 'cma', eqTaps: 11, eqMain: 3, eqMu: 0.01 } }, SDR.rng.createRng(2));
    check('CMA (blind) converges on the same channel; PLL + preamble fix the rotation', cma.errors === 0 && cma.lock.carrier.locked, cma.errors + ' errors, convergence ' + cma.eq.convergence + ' symbols');
    var zf = SDR.qpsk.runLink({ noise: false, sps: 4, nBits: 4000, channel: { multipath: { taps: SDR.channel.multipathPresets('2ray') } }, rx: { eq: 'zf', eqTaps: 15, eqMain: 6 } }, SDR.rng.createRng(2));
    check('ideal ZF equalizer on 2-ray: 0 errors noiseless', zf.errors === 0, zf.errors + ' errors');
  });

  group('IQ, ADC, phase noise, DC', function () {
    var iq = SDR.qpsk.runLink({ ebn0Db: 20, nBits: 20000, channel: { iq: { epsDb: 1, phiDeg: 5 } }, rx: { iqCorrect: true } }, SDR.rng.createRng(4));
    check('IQ correction (ε = 1 dB, φ = 5°): IRR > 40 dB after', iq.channel.iq.irrAfterDb > 40, 'before ' + iq.channel.iq.irrBeforeDb.toFixed(1) + ' dB, after ' + iq.channel.iq.irrAfterDb.toFixed(1) + ' dB');
    [4, 8, 12].forEach(function (N) {
      var r = SDR.qpsk.runLink({ noise: false, nBits: 20000, channel: { adc: { bits: N, backoffDb: 12 } } }, SDR.rng.createRng(5));
      approx('ADC ' + N + ' bits, 12 dB backoff: SQNR ≈ 6.02N + 1.76 − backoff (±1 dB), no clipping', r.channel.adc.sqnrDb, SDR.theory.adcSqnr(N, 12), 1);
      check('ADC ' + N + ' bits: clip rate 0 at 12 dB backoff', r.channel.adc.clipRate === 0);
    });
    var lw = 1e-3, pn = SDR.qpsk.runLink({ noise: false, nBits: 40000, sps: 4, channel: { phaseNoise: lw } }, SDR.rng.createRng(6)), th = pn.traces.phaseNoise, s = 0, s2 = 0, m = 0;
    for (var i = 4; i < th.length; i += 4) { var d = th[i] - th[i - 4]; s += d; s2 += d * d; m++; }
    approx('phase noise: per-symbol increment variance = 2π·Δν·Ts (±5%)', (s2 / m - (s / m) * (s / m)) / (2 * Math.PI * lw), 1, 0.05);
    var dcb = SDR.filters.createDcBlocker(0.999), n = 60000, x = { re: new Float64Array(n), im: new Float64Array(n) }, rng = SDR.rng.createRng(7);
    for (i = 0; i < n; i++) { x.re[i] = 0.5 + 0.1 * rng.randn(); x.im[i] = -0.3 + 0.1 * rng.randn(); }
    var y = dcb.process(x), mr = 0, mi = 0;
    for (i = n / 2; i < n; i++) { mr += y.re[i]; mi += y.im[i]; }
    var res = 20 * Math.log10(Math.hypot(mr / (n / 2), mi / (n / 2)) / Math.hypot(0.5, 0.3));
    check('DC blocker (pole 0.999) removes the offset to < −40 dB after settling', res < -40, res.toFixed(1) + ' dB');
  });

  // ---------------- render results ----------------
  Promise.all(pending).then(render);
  function render() {
  var nPass = results.filter(function (r) { return r.pass; }).length;
  var summary = document.getElementById('summary');
  summary.textContent = (nPass === results.length ? 'PASS ' : 'FAIL ') + nPass + ' / ' + results.length + ' tests passed';
  summary.className = nPass === results.length ? 'pass' : 'fail';
  var tbody = document.getElementById('results');
  results.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.className = r.pass ? 'pass' : 'fail';
    var td1 = document.createElement('td'), td2 = document.createElement('td');
    td1.textContent = (r.pass ? '✓ ' : '✗ ') + r.name;
    td2.className = 'detail';
    td2.textContent = r.detail;
    tr.appendChild(td1); tr.appendChild(td2);
    tbody.appendChild(tr);
  });
  }

  // ---------------- demos ----------------
  var fsd = 8000, nS = 400, t = new Float64Array(nS), s = new Float64Array(nS);
  for (var i = 0; i < nS; i++) { t[i] = (i / fsd) * 1000; s[i] = Math.sin(2 * Math.PI * 100 * i / fsd); }
  SDR.plot.createPlot(document.getElementById('demo-sine'), { title: '100 Hz sine', xLabel: 'time (ms)', yLabel: 'amplitude' })
    .setSeries([{ type: 'line', x: t, y: s, label: 'sin(2π·100·t)' }]);

  var fs2 = 48000, rng = SDR.rng.createRng(2024), n2 = 1 << 16;
  var one = SDR.cx.fromReal(new Float64Array(n2).fill(1));
  var sig = SDR.cx.add(SDR.cx.mixFreq(one, -6000, fs2), SDR.cx.scale(SDR.cx.mixFreq(one, 9000, fs2), Math.sqrt(0.1)));
  sig = SDR.cx.add(sig, rng.randnComplex(n2, 0.01));
  var w = SDR.dsp.welchPSD(sig, fs2, { nfft: 1024 });
  var fk = Array.from(w.freqs, function (f) { return f / 1000; });
  SDR.plot.createPlot(document.getElementById('demo-psd'), {
    title: 'Welch PSD: 0 dB tone at −6 kHz, −10 dB tone at +9 kHz, noise −20 dB total',
    xLabel: 'frequency (kHz)', yLabel: 'power per bin (dB)'
  }).setSeries([{ type: 'line', x: fk, y: w.psdDb, label: 'PSD' }]);

  var xdB = SDR.mathx.linspace(0, 10, 101);
  var q = Array.from(xdB, function (d) { return SDR.mathx.Q(Math.sqrt(2 * SDR.mathx.db2pow(d))); });
  var xi = SDR.mathx.linspace(0, 10, 11);
  var qi = Array.from(xi, function (d) { return SDR.mathx.Q(Math.sqrt(2 * SDR.mathx.db2pow(d))); });
  SDR.plot.createPlot(document.getElementById('demo-q'), {
    title: 'Q(√(2x)): BPSK/QPSK bit error rate', xLabel: 'x = Eb/N0 (dB)', yLabel: 'BER', yScale: 'log'
  }).setSeries([
    { type: 'line', x: xdB, y: q, label: 'theory' },
    { type: 'scatter', x: xi, y: qi, label: 'integer dB', radius: 3.5 }
  ]);

  var cloud = SDR.rng.createRng(5).randnComplex(5000, 0.5);
  SDR.plot.createPlot(document.getElementById('demo-cloud'), {
    title: 'Equal-aspect scatter: complex Gaussian (should look circular)', xLabel: 'I', yLabel: 'Q', equalAspect: true, height: 360
  }).setSeries([{ type: 'scatter', x: cloud.re, y: cloud.im, radius: 1.5, label: '5000 samples' }]);
})();
