/**
 * @file SDR.audio — Web Audio helpers (browser only). The AudioContext is created on first use (a user gesture).
 * loadFile(file, { fs Hz, maxSeconds }) → Promise<Float64Array> (mono, resampled with OfflineAudioContext);
 * play(x, fs Hz, { gain, normalize }) → Promise (DC removed, peak normalized to 0.9, one source at a time);
 * stop(); setVolume(0…1); getVolume(); isPlaying().
 */
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  var ctx = null, master = null, source = null, volume = 0.5;

  function context() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser');
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // File → mono Float64Array at `fs`, trimmed to maxSeconds. Resampling uses OfflineAudioContext.
  function loadFile(file, opts) {
    opts = opts || {};
    var fs = opts.fs || 48000, maxSeconds = opts.maxSeconds || 10;
    return file.arrayBuffer().then(function (buf) {
      return new Promise(function (resolve, reject) { context().decodeAudioData(buf, resolve, reject); });
    }).then(function (ab) {
      var nIn = Math.min(ab.length, Math.round(maxSeconds * ab.sampleRate));
      var mono = new Float32Array(nIn);
      for (var c = 0; c < ab.numberOfChannels; c++) {
        var ch = ab.getChannelData(c);
        for (var i = 0; i < nIn; i++) mono[i] += ch[i] / ab.numberOfChannels;
      }
      if (ab.sampleRate === fs) return Float64Array.from(mono);
      var nOut = Math.round((nIn * fs) / ab.sampleRate);
      var off = new OfflineAudioContext(1, nOut, fs);
      var b = off.createBuffer(1, nIn, ab.sampleRate);
      b.getChannelData(0).set(mono);
      var src = off.createBufferSource();
      src.buffer = b;
      src.connect(off.destination);
      src.start();
      return off.startRendering().then(function (r) { return Float64Array.from(r.getChannelData(0)); });
    });
  }

  function stop() {
    if (source) { try { source.stop(); } catch (e) { /* already stopped */ } source = null; }
  }

  // Plays x (removing DC and normalizing peak to 0.9 unless normalize:false). One source at a time.
  // Resolves when playback ends or is stopped.
  function play(x, fs, opts) {
    opts = opts || {};
    var ac = context();
    stop();
    var n = x.length, mean = 0, peak = 0, i;
    var normalize = opts.normalize !== false;
    if (normalize) { for (i = 0; i < n; i++) mean += x[i]; mean /= n || 1; }
    for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i] - mean));
    var k = (normalize && peak > 0 ? 0.9 / peak : peak > 1 ? 1 / peak : 1) * (opts.gain === undefined ? 1 : opts.gain);
    var buf = ac.createBuffer(1, Math.max(1, n), fs);
    var d = buf.getChannelData(0);
    for (i = 0; i < n; i++) d[i] = (x[i] - mean) * k;
    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    source = src;
    return new Promise(function (resolve) {
      src.onended = function () { if (source === src) source = null; resolve(); };
      src.start();
    });
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  }

  SDR.audio = {
    loadFile: loadFile, play: play, stop: stop, setVolume: setVolume,
    getVolume: function () { return volume; },
    isPlaying: function () { return !!source; }
  };
})();
