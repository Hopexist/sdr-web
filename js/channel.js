// SDR.channel — channel impairments (stub, to be expanded). Pure, no DOM.
// Depends on: SDR.cx
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // Adds complex AWGN so that refPower / (noise power inside `bw` Hz) = cnrDb.
  // White complex noise of total variance σ² over fs puts σ²·bw/fs inside bw.
  // refPower defaults to the power of x; pass the carrier power (e.g. 1 for DSB-LC) for a true CNR.
  function addAwgnCnr(x, cnrDb, bw, fs, rng, opts) {
    var ref = opts && opts.refPower !== undefined ? opts.refPower : SDR.cx.power(x);
    var variance = (ref / Math.pow(10, cnrDb / 10)) * (fs / bw);
    return SDR.cx.add(x, rng.randnComplex(x.re.length, variance));
  }

  function phaseOffset(x, phaseRad) { return SDR.cx.rotate(x, phaseRad); }

  // Carrier frequency offset: multiply by e^{j2π·f·n/fs}.
  function freqOffset(x, f, fs) { return f ? SDR.cx.mixFreq(x, f, fs) : x; }

  // ---- Digital-link conventions: symbols with Es = 1, unit-energy pulses (Σg² = 1) ----
  // Then complex AWGN of total variance N0 = 1/(Es/N0) per sample gives Es/N0 per symbol after the
  // matched filter, and the per-sample SNR is Es/N0 / sps. The one place these conversions live:
  function esn0Db(ebn0Db, bitsPerSymbol) { return ebn0Db + 10 * Math.log10(bitsPerSymbol || 2); }
  function snrPerSampleDb(ebn0Db, bitsPerSymbol, sps) { return esn0Db(ebn0Db, bitsPerSymbol) - 10 * Math.log10(sps); }

  function addAwgnEbN0(x, ebn0Db, o, rng) {
    var N0 = Math.pow(10, -esn0Db(ebn0Db, o && o.bitsPerSymbol) / 10);
    return SDR.cx.add(x, rng.randnComplex(x.re.length, N0));
  }

  // Composable impairments: apply(x, [{ type, ...params, enabled? }], rng). Each entry is
  // IMPAIRMENTS[type](x, params, rng) → x. Phase 4 adds fading, multipath, phase noise, IQ imbalance,
  // DC offset and ADC quantization by registering more types here.
  var IMPAIRMENTS = {
    timing: function (x, p) { return p.sym ? SDR.filters.fractionalDelay(x, p.sym * p.sps) : x; },      // delay in symbols
    drift: function (x, p) { return p.ppm ? SDR.filters.resample(x, 1 + p.ppm * 1e-6) : x; },             // clock offset, ppm
    cfo: function (x, p) { return freqOffset(x, p.fRs / p.sps, 1); },                                     // fraction of Rs
    phase: function (x, p) { return p.deg ? phaseOffset(x, (p.deg * Math.PI) / 180) : x; },
    awgn: function (x, p, rng) { return addAwgnEbN0(x, p.ebn0Db, p, rng); },
    cnr: function (x, p, rng) { return addAwgnCnr(x, p.cnrDb, p.bw, p.fs, rng, p); }
  };

  function apply(x, list, rng) {
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.enabled === false) continue;
      var f = IMPAIRMENTS[it.type];
      if (!f) throw new Error('SDR.channel.apply: unknown impairment ' + it.type);
      x = f(x, it, rng);
    }
    return x;
  }

  SDR.channel = { addAwgnCnr: addAwgnCnr, phaseOffset: phaseOffset, freqOffset: freqOffset,
    esn0Db: esn0Db, snrPerSampleDb: snrPerSampleDb, addAwgnEbN0: addAwgnEbN0, apply: apply, IMPAIRMENTS: IMPAIRMENTS };
})();
