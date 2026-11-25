/**
 * @file SDR.ber — Monte Carlo BER sweep engine (DOM-free; main thread or Web Worker). Depends on SDR.qpsk, SDR.theory.
 * A sweep: { cfg (QPSK link config), param (config path or alias), values, stop: { minErrors, maxBits, maxSecondsPerPoint },
 * floorBer, seed }. getPath/setPath/resolveParam/paramInfo, parseValues('a:step:b' | list), deriveSeed(seed, i),
 * pointTask(cfg, seed, stop) (generator; adaptive frame sizes) / runPointSync, sweepTask(sweep, onPoint) (generator,
 * floor skip), requiredEbN0(results, targetBer) dB, implementationLoss(sim, theory, target) dB, diversitySlope(results)
 * (decades per decade), theoryKind/theoryBer/theoryCurve, toCSV/toJSON/fromJSON, createLibrary(storage),
 * canUseWorkers/createPool(url, n), estimateRemaining(sweep, results, bits/s) s, analogPoint/analogTheory (AM/FM, γ in dB).
 */
(function () {
  'use strict';
  var SDR = (self.SDR = self.SDR || {});
  var VERSION = '1.0.0';

  // Friendly parameter names → paths in the link config, with axis labels and scales.
  var PARAMS = {
    'ebn0Db': { label: 'Eb/N0 (dB)', unit: 'dB' },
    'channel.adc.bits': { label: 'ADC bits', alias: 'adc.bits' },
    'channel.adc.backoffDb': { label: 'ADC backoff (dB)', alias: 'adc.backoffDb' },
    'rx.carrierBnT': { label: 'Carrier loop BnT', log: true, alias: 'rx.carrier.bnT' },
    'rx.timingBnT': { label: 'Timing loop BnT', log: true, alias: 'rx.timing.bnT' },
    'channel.fading.fdTs': { label: 'Doppler fd·Ts', log: true, alias: 'fading.fdTs' },
    'channel.fading.kDb': { label: 'Rician K (dB)', alias: 'fading.kDb' },
    'pilotEvery': { label: 'Pilot spacing (symbols)', alias: 'pilots.spacing' },
    'channel.phaseDeg': { label: 'Phase offset (°)', alias: 'phaseDeg' },
    'channel.phaseNoise': { label: 'Phase-noise linewidth Δν·Ts', log: true, alias: 'phaseNoise' },
    'channel.cfoRs': { label: 'CFO (× Rs)', alias: 'cfoRs' },
    'channel.timingSym': { label: 'Timing offset (symbols)', alias: 'timingSym' },
    'rx.eqMu': { label: 'Equalizer step μ', log: true, alias: 'eq.mu' },
    'rx.eqTaps': { label: 'Equalizer taps', alias: 'eq.taps' },
    'rolloff': { label: 'RRC roll-off β' },
    'sps': { label: 'Samples per symbol' }
  };
  var ALIAS = {};
  Object.keys(PARAMS).forEach(function (k) { if (PARAMS[k].alias) ALIAS[PARAMS[k].alias] = k; });
  function resolveParam(p) { return ALIAS[p] || p; }
  function paramInfo(p) { return PARAMS[resolveParam(p)] || { label: p }; }

  // getPath(obj, 'a.b.c') → value or undefined; setPath creates missing objects along the way.
  function getPath(obj, path) {
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }
  function setPath(obj, path, value) {
    var parts = String(path).split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] === null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    return obj;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // "0:1:10" (start:step:stop, inclusive) or "1, 2, 5" or an array → numbers.
  function parseValues(spec) {
    if (Array.isArray(spec)) return spec.map(Number).filter(isFinite);
    var s = String(spec).trim(), m = s.match(/^(-?[\d.eE+-]+)\s*:\s*(-?[\d.eE+-]+)\s*:\s*(-?[\d.eE+-]+)$/);
    if (m) {
      var a = +m[1], st = +m[2], b = +m[3], out = [];
      if (!(st !== 0 && isFinite(a + st + b))) return [];
      for (var k = 0; k <= 10000; k++) { var v = a + k * st; if ((st > 0 && v > b + 1e-9) || (st < 0 && v < b - 1e-9)) break; out.push(+v.toPrecision(12)); }
      return out;
    }
    return s.split(/[\s,;]+/).filter(Boolean).map(Number).filter(isFinite);
  }

  // Deterministic per-point seed (splitmix/murmur finalizer of seed ⊕ golden-ratio·(i + 1)).
  function deriveSeed(seed, i) {
    var z = ((seed >>> 0) ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  var STOP = { minErrors: 100, maxBits: 1e7, maxSecondsPerPoint: 60 };
  function now() { return (self.performance || Date).now(); }

  // Frame size for the next frame of a point: aim for ≤ minErrors/4 expected errors (so a point stops close
  // to minErrors instead of overshooting at high BER), between MIN_FRAME and the config's nBits, and never past
  // maxBits. Depends only on what was simulated so far, so it is seed-reproducible.
  var MIN_FRAME = 2000;
  function nextFrameBits(cfg, stop, errors, bits) {
    var maxFrame = Math.max(MIN_FRAME, cfg.nBits || 20000), n;
    if (!bits) n = MIN_FRAME;
    else if (!errors) n = maxFrame;
    else n = (stop.minErrors / 4) / (errors / bits);
    n = Math.min(maxFrame, Math.max(MIN_FRAME, n), Math.max(MIN_FRAME, stop.maxBits - bits));
    return 2 * Math.round(n / 2);
  }

  // One point: frames of the streaming link (createLink → step) until a stop rule fires.
  // Yields { errors, bits } between steps; returns the point record.
  function* pointTask(cfg, seed, stopIn) {
    var stop = Object.assign({}, STOP, stopIn), rng = SDR.rng.createRng(seed), t0 = now();
    var errors = 0, bits = 0, ev = 0, evBits = 0, by = '';
    for (;;) {
      var link = SDR.qpsk.createLink(Object.assign({}, cfg, { nBits: nextFrameBits(cfg, stop, errors, bits) }), rng);
      while (!link.done) { link.step(96); yield { errors: errors, bits: bits }; }
      var r = link.finish(), nb = r.bitsTx.length;
      errors += r.errors; bits += nb;
      if (isFinite(r.evm)) { ev += r.evm * r.evm * nb; evBits += nb; }
      if (errors >= stop.minErrors) by = 'errors';
      else if (bits >= stop.maxBits) by = 'bits';
      else if ((now() - t0) / 1000 >= stop.maxSecondsPerPoint) by = 'time';
      if (by) break;
      yield { errors: errors, bits: bits };
    }
    var ci = SDR.theory.wilsonInterval(errors, bits);
    return { errors: errors, bits: bits, ber: bits ? errors / bits : NaN, ciLow: ci[0], ciHigh: ci[1],
      evmDb: evBits ? 10 * Math.log10(ev / evBits) : NaN, seconds: (now() - t0) / 1000, stoppedBy: by, seed: seed };
  }
  function runPointSync(cfg, seed, stop) {
    var it = pointTask(cfg, seed, stop), r;
    do { r = it.next(); } while (!r.done);
    return r.value;
  }

  // Config for point i of a sweep.
  function pointCfg(sweep, value) { return setPath(clone(sweep.cfg), resolveParam(sweep.param), value); }

  // Early stop (upward Eb/N0 sweeps only): once a point had 0 errors at maxBits, or BER < floorBer,
  // the remaining higher-SNR points are skipped and marked "below floor".
  function belowFloor(sweep, rec) {
    if (resolveParam(sweep.param) !== 'ebn0Db') return false;
    var vals = sweep.values, up = vals.length < 2 || vals[vals.length - 1] > vals[0];
    if (!up) return false;
    return (rec.errors === 0 && rec.stoppedBy === 'bits') || (rec.bits > 0 && rec.ber < (sweep.floorBer || 0));
  }
  function floorRecord(value) { return { value: value, errors: 0, bits: 0, ber: NaN, ciLow: NaN, ciHigh: NaN, evmDb: NaN, seconds: 0, stoppedBy: 'floor', skipped: true }; }

  // Whole sweep as a generator (main thread). onPoint(i, record) is called as each point finishes.
  // Yields { point, errors, bits } for progress.
  function* sweepTask(sweep, onPoint) {
    var results = [], floored = false;
    for (var i = 0; i < sweep.values.length; i++) {
      var v = sweep.values[i], rec;
      if (floored) rec = floorRecord(v);
      else {
        var it = pointTask(pointCfg(sweep, v), deriveSeed(sweep.seed >>> 0, i), sweep.stop), r;
        while (!(r = it.next()).done) yield { point: i, errors: r.value.errors, bits: r.value.bits };
        rec = Object.assign({ value: v }, r.value);
        floored = belowFloor(sweep, rec);
      }
      results.push(rec);
      if (onPoint) onPoint(i, rec);
      yield { point: i + 1, errors: 0, bits: 0 };
    }
    return results;
  }

  // ---------- derived results ----------
  // Value where log10(BER) crosses log10(target), interpolating linearly in log10(BER) vs the parameter.
  function requiredEbN0(results, target) {
    var pts = results.filter(function (r) { return r.ber > 0 && isFinite(r.ber); }).sort(function (a, b) { return a.value - b.value; });
    var lt = Math.log10(target);
    for (var i = 1; i < pts.length; i++) {
      var a = Math.log10(pts[i - 1].ber), b = Math.log10(pts[i].ber);
      if ((a - lt) * (b - lt) <= 0 && a !== b) return pts[i - 1].value + ((lt - a) / (b - a)) * (pts[i].value - pts[i - 1].value);
    }
    return NaN;
  }
  // Implementation loss = required(sim) − required(theory), both found by the same interpolation.
  function implementationLoss(sim, theory, target) { return requiredEbN0(sim, target) - requiredEbN0(theory, target); }
  // Diversity slope: decades of BER per decade of SNR, least-squares over the upper half of the points
  // with errors (≈ 1 for Rayleigh, steeper and growing for AWGN).
  function diversitySlope(results) {
    var pts = results.filter(function (r) { return r.ber > 0 && isFinite(r.ber); }).sort(function (a, b) { return a.value - b.value; });
    pts = pts.slice(Math.floor(pts.length / 2));
    if (pts.length < 2) return NaN;
    var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { var x = p.value / 10, y = Math.log10(p.ber); sx += x; sy += y; sxx += x * x; sxy += x * y; });
    return -(n * sxy - sx * sy) / (n * sxx - sx * sx);
  }

  // ---------- theory ----------
  // Which closed form fits a config: fading → Rayleigh/Rician (ideal CSI); carrier off + phase → static
  // phase error; differential → DE-QPSK; otherwise AWGN. ('none' when the channel has no noise.)
  function theoryKind(cfg) {
    var ch = cfg.channel || {};
    if (cfg.noise === false) return 'none';
    if (ch.fading) return ch.fading.model === 'rician' ? 'rician' : 'rayleigh';
    if (cfg.rx && cfg.rx.carrier === 'off' && ch.phaseDeg) return 'phase';
    if (cfg.diff) return 'diff';
    return 'awgn';
  }
  function theoryBer(cfg, kind) {
    var T = SDR.theory, eb = cfg.ebn0Db, ch = cfg.channel || {};
    switch (kind || theoryKind(cfg)) {
      case 'rayleigh': return T.qpskRayleigh(eb);
      case 'rician': return T.qpskRician(eb, ch.fading ? ch.fading.kDb : 10);
      case 'phase': return T.qpskPhaseError(eb, ((ch.phaseDeg || 0) * Math.PI) / 180);
      case 'diff': return T.dqpskAwgn(eb);
      case 'awgn': return T.qpskAwgn(eb);
      default: return NaN;
    }
  }
  // Theory along a sweep: value → BER, on a finer grid for Eb/N0 sweeps.
  function theoryCurve(sweep, kind) {
    var vals = sweep.values.slice(), p = resolveParam(sweep.param), xs = vals;
    if (p === 'ebn0Db' && vals.length > 1) {
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals); xs = [];
      for (var v = lo; v <= hi + 1e-9; v += (hi - lo) / 100) xs.push(v);
    }
    return xs.map(function (x) { return { value: x, ber: theoryBer(pointCfg(sweep, x), kind) }; });
  }

  // ---------- export / import ----------
  var CSV_COLUMNS = ['curve', 'param', 'value', 'errors', 'bits', 'ber', 'ci_low', 'ci_high', 'evm_db', 'seconds', 'stopped_by', 'seed'];
  function csvField(v) { var s = v === undefined || v === null || (typeof v === 'number' && !isFinite(v)) ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCSV(curves) {
    var lines = [CSV_COLUMNS.join(',')];
    curves.forEach(function (c) {
      (c.results || []).forEach(function (r) {
        lines.push([c.name, c.param, r.value, r.errors, r.bits, r.ber, r.ciLow, r.ciHigh, r.evmDb, r.seconds, r.stoppedBy, r.seed].map(csvField).join(','));
      });
    });
    return lines.join('\n') + '\n';
  }
  function toJSON(curves, extra) {
    return JSON.stringify(Object.assign({ app: 'sdr-web', kind: 'ber-run', version: VERSION, created: new Date().toISOString(), curves: curves }, extra || {}), null, 1);
  }
  function fromJSON(text) {
    var o = JSON.parse(text);
    if (!o || o.app !== 'sdr-web' || !Array.isArray(o.curves)) throw new Error('Not an sdr-web BER run');
    o.curves.forEach(function (c) { (c.results || []).forEach(function (r) { ['ber', 'ciLow', 'ciHigh', 'evmDb'].forEach(function (k) { if (r[k] === null) r[k] = NaN; }); }); });
    return o;
  }

  // ---------- saved-runs library (localStorage, failing soft) ----------
  // createLibrary(storage?) → { available, list(), save(name, run) → id, load(id), remove(id) }. Any storage error
  // falls back to an in-memory list (available = false), so the page keeps working in private mode.
  function createLibrary(storage, key) {
    key = key || 'sdr-web.ber.runs';
    var mem = [], ok = true;
    try { storage = storage || self.localStorage; storage.getItem(key); } catch (e) { ok = false; }
    function read() {
      if (!ok) return mem;
      try { return JSON.parse(storage.getItem(key) || '[]'); } catch (e) { ok = false; return mem; }
    }
    function write(list) {
      if (!ok) { mem = list; return; }
      try { storage.setItem(key, JSON.stringify(list)); } catch (e) { ok = false; mem = list; }
    }
    return {
      get available() { return ok; },
      list: function () { return read().map(function (r) { return { id: r.id, name: r.name, date: r.date, curves: r.run.curves.length }; }); },
      save: function (name, run) {
        var list = read(), id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
        list.unshift({ id: id, name: name, date: new Date().toISOString(), run: run });
        write(list.slice(0, 30));
        return id;
      },
      load: function (id) { var r = read().filter(function (x) { return x.id === id; })[0]; return r ? r.run : null; },
      remove: function (id) { write(read().filter(function (x) { return x.id !== id; })); }
    };
  }

  // ---------- Web Worker pool (http(s) only: file:// pages cannot start workers) ----------
  function canUseWorkers() {
    return typeof Worker !== 'undefined' && typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  }
  // createPool(url, n) → { size, run(job) → Promise<record>, terminate() } or null when workers are unavailable.
  function createPool(url, n) {
    if (!canUseWorkers()) return null;
    var workers = [], idle = [], queue = [], seq = 0, pending = {}, paused = false;
    try {
      for (var i = 0; i < n; i++) {
        var w = new Worker(url);
        w.onmessage = onMsg(w);
        w.onerror = function (e) { e.preventDefault && e.preventDefault(); };
        workers.push(w); idle.push(w);
      }
    } catch (e) { workers.forEach(function (x) { x.terminate(); }); return null; }
    function onMsg(w) {
      return function (ev) {
        var d = ev.data, p = pending[d.id];
        delete pending[d.id];
        idle.push(w);
        pump();
        if (p) { if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result); }
      };
    }
    function pump() {
      while (!paused && idle.length && queue.length) {
        var job = queue.shift(), w = idle.shift();
        w.postMessage({ id: job.id, cfg: job.cfg, seed: job.seed, stop: job.stop });
      }
    }
    return {
      size: n,
      run: function (job) {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          pending[id] = { resolve: resolve, reject: reject };
          queue.push({ id: id, cfg: job.cfg, seed: job.seed, stop: job.stop, tag: job.tag });
          pump();
        });
      },
      cancelQueued: function (pred) { queue = queue.filter(function (j) { return !pred(j); }); },
      pause: function () { paused = true; },
      resume: function () { paused = false; pump(); },
      terminate: function () { workers.forEach(function (w) { w.terminate(); }); workers = []; idle = []; queue = []; pending = {}; }
    };
  }

  // ---------- ETA ----------
  // Remaining seconds for the unfinished points, from the bits/s seen so far and a log-linear
  // extrapolation of the BER trend (bits needed ≈ min(maxBits, minErrors / BER)).
  function estimateRemaining(sweep, results, bitsPerSecond) {
    if (!(bitsPerSecond > 0)) return NaN;
    var stop = Object.assign({}, STOP, sweep.stop), done = results.filter(function (r) { return r && r.ber > 0; }), total = 0;
    for (var i = results.length; i < sweep.values.length; i++) {
      var est = 0.1;
      if (done.length >= 2) {
        var a = done[done.length - 2], b = done[done.length - 1], sl = (Math.log10(b.ber) - Math.log10(a.ber)) / ((b.value - a.value) || 1);
        est = Math.pow(10, Math.log10(b.ber) + sl * (sweep.values[i] - b.value));
      } else if (done.length) est = done[0].ber;
      var bitsNeeded = Math.min(stop.maxBits, stop.minErrors / Math.max(est, 1e-12));
      if (sweep.floorBer && est < sweep.floorBer) bitsNeeded = Math.min(bitsNeeded, stop.minErrors / sweep.floorBer);
      total += Math.min(bitsNeeded / bitsPerSecond, stop.maxSecondsPerPoint);
    }
    return total;
  }

  // ---------- analog output-SNR points (AM / FM), reusing SDR.am / SDR.fm ----------
  // x = baseband SNR γ = C/(N0·W) in dB, so AM and FM share one axis. Tone message 1 kHz, W = 5 kHz (AM) / 3 kHz (FM).
  // AM DSB-LC μ = 0.8: CNR in 2W = γ − 3.01 dB; coherent theory SNRout = μ²·Pm·γ. FM: CNR in B_T = γ − 10·log10(B_T/W),
  // theory above threshold 1.5·β²·γ.
  function analogPoint(kind, gammaDb, seed, beta) {
    var rng = SDR.rng.createRng(seed), i;
    if (kind === 'am-env' || kind === 'am-coh') {
      var FS = 48000, W = 5000, n = 12000, m = new Float64Array(n);
      for (i = 0; i < n; i++) m[i] = Math.sin((2 * Math.PI * 1000 * i) / FS);
      var x = SDR.am.modulate(m, { type: 'DSB-LC', mu: 0.8 });
      var rx = SDR.channel.addAwgnCnr(x, gammaDb - 10 * Math.log10(2), 2 * W, FS, rng, { refPower: 1 });
      var d = kind === 'am-env' ? SDR.am.demodEnvelope(rx, { fs: FS, audioBw: W }) : SDR.am.demodCoherent(rx, { fs: FS, audioBw: W, phaseEst: 0 });
      return SDR.dsp.measureOutputSnr(m, d.y, d.delay).snrDb;
    }
    var FSA = 48000, FSR = 384000, Wf = 3000, dev = beta * Wf, bt = SDR.fm.carson(dev, Wf), na = 4800, mA = new Float64Array(na);
    for (i = 0; i < na; i++) mA[i] = Math.sin((2 * Math.PI * 1000 * i) / FSA);
    var tx = SDR.fm.transmit(mA, { fsA: FSA, fsR: FSR, deviation: dev });
    var rr = SDR.channel.addAwgnCnr(tx.x, gammaDb - 10 * Math.log10(bt / Wf), bt, FSR, rng, { refPower: 1 });
    var r = SDR.fm.receive(rr, { fsA: FSA, fsR: FSR, deviation: dev, W: Wf, ifBw: bt, demod: 'disc', txDelay: tx.delay });
    return SDR.dsp.measureOutputSnr(mA, r.y, r.delay).snrDb;
  }
  function analogTheory(kind, gammaDb, beta) {
    if (kind === 'am-coh' || kind === 'am-env') return gammaDb + 10 * Math.log10(0.64 * 0.5);
    return gammaDb + 10 * Math.log10(1.5 * beta * beta);
  }

  SDR.ber = {
    VERSION: VERSION, PARAMS: PARAMS, STOP: STOP, resolveParam: resolveParam, paramInfo: paramInfo,
    getPath: getPath, setPath: setPath, clone: clone, parseValues: parseValues, deriveSeed: deriveSeed,
    pointTask: pointTask, runPointSync: runPointSync, pointCfg: pointCfg, sweepTask: sweepTask, belowFloor: belowFloor, floorRecord: floorRecord,
    requiredEbN0: requiredEbN0, implementationLoss: implementationLoss, diversitySlope: diversitySlope,
    theoryKind: theoryKind, theoryBer: theoryBer, theoryCurve: theoryCurve,
    CSV_COLUMNS: CSV_COLUMNS, toCSV: toCSV, toJSON: toJSON, fromJSON: fromJSON, createLibrary: createLibrary,
    canUseWorkers: canUseWorkers, createPool: createPool, estimateRemaining: estimateRemaining,
    analogPoint: analogPoint, analogTheory: analogTheory
  };
})();
