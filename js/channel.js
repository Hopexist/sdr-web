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

  SDR.channel = { addAwgnCnr: addAwgnCnr, phaseOffset: phaseOffset, freqOffset: freqOffset };
})();
