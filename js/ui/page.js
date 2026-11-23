// SDR.page — shared scaffold for simulator pages (AM, FM, ...).
// Provides: controls panel + status bar, readouts card, plot cards, message source (tone / two-tone /
// chirp / audio file), seed control, live preview/commit wiring, URL-hash state with reset/copy link,
// play buttons, and chunked sweeps. The page script supplies run(state, full) and optional sync(state).
//
// HTML contract: <aside id="controls"></aside> and <section id="plots"> … <details> explainer </details></section>.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var ui = SDR.ui;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // o: { defaults, run(state, full) → { original, received, demodulated } (each { x, fs }) for playback,
  //      sync(state), readouts: [[id, label], …], fs = 48000, maxFileSeconds = 10 }
  function create(o) {
    var FS = o.fs || 48000;
    var panel = document.getElementById('controls');
    var plots = document.getElementById('plots');
    var explainer = plots.querySelector('details');
    var status = ui.statusBar(panel);
    var controls = [];
    var fileMsg = null, fileMissing = false, last = null, src = null;

    // Readouts card + interaction hint at the top of the plot column.
    var card = el('div', 'card readouts');
    card.setAttribute('aria-live', 'polite');
    var dl = el('dl'), readEls = {};
    (o.readouts || []).forEach(function (r) {
      var d = el('div'), dd = el('dd', 'num', '–');
      dd.id = 'r-' + r[0];
      readEls[r[0]] = dd;
      d.appendChild(el('dt', '', r[1])); d.appendChild(dd);
      dl.appendChild(d);
    });
    card.appendChild(dl);
    var explain = el('p', 'explain');
    explain.id = 'r-explain';
    card.appendChild(explain);
    plots.insertBefore(card, plots.firstChild);
    plots.insertBefore(el('p', 'muted hint', 'Plots: hover to read values · wheel to zoom (Shift: x only, Alt: y only) · drag to pan · ' +
      'right-drag or Ctrl+drag to box-zoom · double-click to reset · click legend entries to hide them.'), card.nextSibling);
    function addCard(c) { plots.insertBefore(c, explainer || null); return c; }

    function state() { return ui.stateOf(controls); }

    function baseSync(s) {
      if (src) {
        src.f.setDisabled(s.src !== 'tone');
        src.file.el.hidden = s.src !== 'file';
      }
      if (o.sync) o.sync(s);
    }

    function run(full) {
      var t0 = performance.now(), s = state();
      baseSync(s);
      fileMissing = false;
      var r = o.run(s, full);
      if (!full) return;
      last = r;
      if (fileMissing) status.set('No audio file loaded yet: showing a tone. Choose a file below.', 'err');
      else status.set('Done in ' + Math.round(performance.now() - t0) + ' ms', 'ok');
    }

    function commit() {
      run(true);
      ui.writeHash(state());
    }

    var page = {
      fs: FS, status: status, controls: controls, state: state, commit: commit,
      live: ui.live({ preview: function () { run(false); }, commit: commit }),

      register: function (c) { if (c && c.key) controls.push(c); return c; },

      // Appends a <fieldset> of controls (or plain elements) to the panel; keyed controls join the URL state.
      group: function (legend, items) {
        items.forEach(page.register);
        var g = ui.group(legend, items);
        panel.appendChild(g);
        return g;
      },

      setReadouts: function (map) { Object.keys(map).forEach(function (k) { if (readEls[k]) readEls[k].textContent = map[k]; }); },
      setExplain: function (t) { explain.textContent = t; },

      addPlot: function (opts) {
        var c = addCard(el('div', 'card plot')), canvas = el('canvas');
        c.appendChild(canvas);
        return SDR.plot.createPlot(canvas, opts);
      },

      // Message source controls: src (select), f (tone frequency slider, log), file input.
      sourceControls: function (so) {
        so = so || {};
        src = {
          src: ui.select({ key: 'src', label: 'Message', value: 'tone', onChange: commit,
            title: 'Message signal m(t), normalized so |m| ≤ 1',
            options: [{ value: 'tone', label: 'Tone' }, { value: 'twotone', label: 'Two-tone (700 + 1900 Hz)' },
              { value: 'chirp', label: 'Chirp (200 Hz → 4 kHz, 1 s)' }, { value: 'file', label: 'Audio file…' }] }),
          f: ui.slider({ key: 'f', label: 'Tone frequency', min: so.fMin || 100, max: so.fMax || 5000, log: true, unit: 'Hz',
            value: so.f || 1000, title: 'Frequency of the test tone (log scale)', onInput: page.live.input, onChange: page.live.commit }),
          file: ui.fileInput({ label: 'Audio file (first ' + (o.maxFileSeconds || 10) + ' s used)', accept: 'audio/*', onFile: loadFile,
            title: 'Any format your browser can decode; mixed to mono and resampled to 48 kHz' })
        };
        return [src.src, src.f, src.file];
      },

      // Seconds of message to simulate: whole file when the source is a loaded file, else fullS / previewS.
      duration: function (s, full, fullS, previewS) {
        return full ? (s.src === 'file' && fileMsg ? fileMsg.length / FS : fullS) : previewS;
      },

      // n samples of the message at fs, band-limited to bw (files only; synthetic sources are already in band).
      message: function (s, n, bw) {
        var m = new Float64Array(n), i, t;
        if (s.src === 'file' && fileMsg) {
          var raw = fileMsg.subarray(0, Math.min(n, fileMsg.length));
          var lp = SDR.filters.lowpass({ cutoff: bw, fs: FS, transition: 500 });
          var padded = new Float64Array(raw.length + lp.groupDelay);
          padded.set(raw);
          m = SDR.filters.fir(padded, lp.taps).slice(lp.groupDelay); // band-limit to W, delay removed
          var peak = 0;
          for (i = 0; i < m.length; i++) peak = Math.max(peak, Math.abs(m[i]));
          if (peak > 0) for (i = 0; i < m.length; i++) m[i] /= peak;
          return m;
        }
        if (s.src === 'file') fileMissing = true;
        var kind = s.src === 'file' ? 'tone' : s.src;
        for (i = 0; i < n; i++) {
          t = i / FS;
          if (kind === 'tone') m[i] = Math.sin(2 * Math.PI * s.f * t);
          else if (kind === 'twotone') m[i] = 0.5 * (Math.sin(2 * Math.PI * 700 * t) + Math.sin(2 * Math.PI * 1900 * t));
          else { var tau = t % 1; m[i] = Math.sin(2 * Math.PI * (200 * tau + 1900 * tau * tau)); } // 200→4000 Hz, phase-continuous per 1 s
        }
        return m;
      },

      seedControl: function () {
        var seed = ui.number({ key: 'seed', label: 'Seed', value: o.defaults.seed, min: 0, step: 1, onChange: commit,
          title: 'Random seed for the channel noise; the same seed reproduces the same run' });
        var dice = ui.button({ label: '🎲', ariaLabel: 'Random seed', title: 'Pick a random seed', onClick: function () {
          seed.set(Math.floor(Math.random() * 1e6), true); commit();
        } });
        seed.el.appendChild(dice.el);
        return seed;
      },

      // Sweep card: Start/Stop/progress, optional extra controls, and a plot. task(state, plot) is a
      // generator yielding progress in [0, 1]; it runs through SDR.ui.runChunked.
      addSweep: function (so) {
        var c = addCard(el('div', 'card plot'));
        var row = el('div', 'btn-row');
        var start = ui.button({ label: so.label || 'Compute SNR curve', title: so.title, cls: 'primary', onClick: begin });
        var stop = ui.button({ label: 'Stop', title: 'Stop the sweep', onClick: function () { if (ac) ac.abort(); } });
        var prog = el('progress');
        prog.max = 1; prog.hidden = true;
        stop.setDisabled(true);
        start.el.id = 'sweep-start'; stop.el.id = 'sweep-stop'; prog.id = 'sweep-progress';
        row.appendChild(start.el); row.appendChild(stop.el); row.appendChild(prog);
        c.appendChild(row);
        (so.extra || []).forEach(function (x) { page.register(x); c.appendChild(x.el || x); });
        var canvas = el('canvas');
        c.appendChild(canvas);
        var plot = SDR.plot.createPlot(canvas, so.plot);
        var ac = null;
        function begin() {
          if (ac) return;
          ac = new AbortController();
          start.setDisabled(true); stop.setDisabled(false);
          prog.value = 0; prog.hidden = false;
          status.set('Sweeping…');
          var t0 = performance.now();
          ui.runChunked(so.task(state(), plot), { signal: ac.signal, onProgress: function (p) { prog.value = p; } }).then(function (res) {
            ac = null;
            start.setDisabled(false); stop.setDisabled(true); prog.hidden = true;
            if (res.error) status.set('Sweep failed: ' + res.error.message, 'err');
            else status.set((res.aborted ? 'Sweep stopped' : 'Sweep done in ' + Math.round(performance.now() - t0) + ' ms') +
              ' (longest slice ' + Math.round(res.maxSliceMs) + ' ms)', 'ok');
          });
        }
        return plot;
      },

      start: function () {
        // Listen group + link buttons go last in the panel.
        var volume = ui.slider({ label: 'Volume', min: 0, max: 100, step: 1, unit: '%', value: 50,
          title: 'Playback volume', onInput: function (v) { SDR.audio.setVolume(v / 100); } });
        // Sounds come from the last full run, or (when o.renderAudio is given) from a separate longer
        // render, cached per setup so repeated plays are instant.
        var audioCache = null;
        function sounds(cb) {
          if (!o.renderAudio) { if (!last) run(true); return cb(last); }
          var key = ui.encodeHash(state()) + '|' + (fileMsg ? fileMsg.length : 0);
          if (audioCache && audioCache.key === key) return cb(audioCache.s);
          status.set('Rendering audio…');
          setTimeout(function () { // let the status paint first
            audioCache = { key: key, s: o.renderAudio(state()) };
            cb(audioCache.s);
          }, 20);
        }
        function playBtn(label, title, which) {
          return ui.button({ label: '▶ Play ' + label, title: title, onClick: function () {
            sounds(function (snds) {
              var snd = snds[which];
              status.set('Playing ' + label + '…');
              SDR.audio.setVolume(volume.get() / 100);
              SDR.audio.play(snd.x, snd.fs).then(function () { if (!SDR.audio.isPlaying()) status.set('Ready'); });
            });
          } });
        }
        var playRow = el('div', 'btn-row');
        [playBtn('original', 'Play the message m(t)', 'original'),
          playBtn('received', o.receivedTitle || 'Play the received signal', 'received'),
          playBtn('demodulated', 'Play the detector output', 'demodulated'),
          ui.button({ label: '■ Stop', title: 'Stop playback', onClick: function () { SDR.audio.stop(); status.set('Stopped'); } })
        ].forEach(function (b) { playRow.appendChild(b.el); });
        panel.appendChild(ui.group('Listen', [playRow, volume]));

        var linkRow = el('div', 'btn-row');
        linkRow.appendChild(ui.button({ label: 'Reset to defaults', title: 'Restore every control to its default', onClick: function () {
          ui.applyState(controls, o.defaults); commit();
        } }).el);
        linkRow.appendChild(ui.button({ label: 'Copy link', title: 'Copy a link that restores this exact setup', onClick: function () {
          ui.writeHash(state());
          ui.copyText(location.href).then(function () { status.set('Link copied', 'ok'); },
            function () { status.set('Copy failed. The link is in the address bar.', 'err'); });
        } }).el);
        panel.appendChild(linkRow);

        function loadFromHash() { ui.applyState(controls, ui.readHash(o.defaults)); run(true); }
        window.addEventListener('hashchange', loadFromHash);
        loadFromHash();
        if (!fileMissing) status.set('Ready', 'ok');
      }
    };

    function loadFile(f) {
      status.set('Decoding audio…');
      var t0 = performance.now();
      SDR.audio.loadFile(f, { fs: FS, maxSeconds: o.maxFileSeconds || 10 }).then(function (x) {
        var peak = 0;
        for (var i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
        if (peak > 0) for (i = 0; i < x.length; i++) x[i] /= peak;
        fileMsg = x;
        src.src.set('file', true);
        commit();
        status.set('Loaded ' + f.name + ' (' + (x.length / FS).toFixed(1) + ' s) in ' + Math.round(performance.now() - t0) + ' ms', 'ok');
      }, function (e) { status.set('Could not decode audio: ' + (e && e.message ? e.message : e), 'err'); });
    }

    return page;
  }

  SDR.page = { create: create };
})();
