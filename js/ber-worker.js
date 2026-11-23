// Classic Web Worker for BER sweeps (http(s) only). Loads the same DSP files as the page, then runs one
// sweep point per message with SDR.ber.runPointSync: identical code and seed → identical results.
/* global importScripts */
self.window = self;   // the DSP files attach to window.SDR
importScripts('core/rng.js', 'core/complex.js', 'core/mathx.js', 'core/fft.js', 'core/dsp.js', 'core/filters.js',
  'channel.js', 'theory.js', 'digital/mapping.js', 'digital/sequences.js', 'digital/sync.js', 'digital/equalizer.js',
  'digital/qpsk.js', 'ber.js');

self.onmessage = function (ev) {
  var d = ev.data;
  try {
    self.postMessage({ id: d.id, result: self.SDR.ber.runPointSync(d.cfg, d.seed, d.stop) });
  } catch (e) {
    self.postMessage({ id: d.id, error: String(e && e.message || e) });
  }
};
