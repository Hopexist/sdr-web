/**
 * @file BER page wiring (DOM): sweep builder (curves edited with SDR.qpskControls), SDR.ber engine on the main thread
 * or a worker pool, live log-BER plot, results/summary tables, export/import, saved runs, Analog SNR tab.
 */
(function () {
  'use strict';
  var ui = SDR.ui, B = SDR.ber, PAL = SDR.plot.PALETTE, QD = SDR.qpskControls.DEFAULTS;
  var page = SDR.page.create({ defaults: {}, run: function () {}, readouts: false, audio: false });
  var status = page.status, panel = document.getElementById('controls');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function fmtS(s) { if (!isFinite(s)) return '–'; s = Math.round(s); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }
  function fmtE(v, d) { return isFinite(v) ? (v === 0 ? '0' : v.toExponential(d === undefined ? 2 : d)) : '–'; }

  // ---------- curves ----------
  // QPSK UI state for BER work: ideal sync, sps 4, 20 000-bit frames.
  function st(over) {
    return Object.assign({}, QD, { sps: 4, nbits: 20000, phase: 0, cfo: 0, timing: 0, drift: 0, cfoMode: 'ideal', timingMode: 'ideal',
      carrierMode: 'ideal', frameMode: 'ideal', noise: true, input: 'random' }, over || {});
  }
  var nextId = 1;
  function curve(o) {
    return Object.assign({ id: nextId++, name: 'Curve', color: PAL[(nextId - 2) % PAL.length], enabled: true, state: st(), param: 'ebn0Db', values: '0:1:9',
      stop: { minErrors: 100, maxBits: 2e6, maxSecondsPerPoint: 30 }, floorBer: 1e-7, theory: 'auto', seed: 1, results: [] }, o);
  }

  var PRESETS = [
    { name: 'QPSK AWGN vs theory', note: 'Markers should sit on the line, each error bar covering it: Q(√(2Eb/N0)).',
      curves: function () { return [curve({ name: 'QPSK, ideal sync', values: '0:1:9', stop: { minErrors: 100, maxBits: 3e6, maxSecondsPerPoint: 30 } })]; } },
    { name: 'Rayleigh vs AWGN', note: 'Rayleigh (ideal CSI) falls one decade per 10 dB, the 1/SNR slope; AWGN dives. The gap at 1e-4 is about 25 dB.',
      curves: function () { return [
        curve({ name: 'AWGN', values: '0:1:9', stop: { minErrors: 100, maxBits: 3e6, maxSecondsPerPoint: 30 } }),
        curve({ name: 'Rayleigh, ideal CSI', state: st({ fadeOn: true, fadeModel: 'rayleigh', fadeMode: 'block', fadeBlock: 1 }), values: '0:5:30', stop: { minErrors: 100, maxBits: 1e6, maxSecondsPerPoint: 30 } })]; } },
    { name: 'Static phase error 0/10/20/30°', note: 'With no carrier recovery, a fixed phase error shifts the curve right and, at 30°, bends it towards a floor.',
      curves: function () { return [0, 10, 20, 30].map(function (d) { return curve({ name: 'φ = ' + d + '°', state: st({ phase: d, carrierMode: 'off' }), values: '0:1:10', stop: { minErrors: 100, maxBits: 2e6, maxSecondsPerPoint: 20 } }); }); } },
    { name: 'Real sync vs ideal sync', note: 'The horizontal gap between the two curves at 1e-3 / 1e-4 is the implementation loss of the real receiver (see the summary).',
      curves: function () { return [
        curve({ name: 'Ideal sync', values: '0:1:9', stop: { minErrors: 100, maxBits: 3e6, maxSecondsPerPoint: 30 } }),
        curve({ name: 'Real sync (CFO, timing, phase)', state: st({ phase: 30, cfo: 0.01, timing: 0.3, cfoMode: 'real', timingMode: 'real', carrierMode: 'real', frameMode: 'real' }),
          values: '0:1:9', stop: { minErrors: 100, maxBits: 3e6, maxSecondsPerPoint: 30 } })]; } },
    { name: 'BER vs ADC bits', note: 'At 8 dB both reach the unquantized BER by ~5 bits. At 2–3 bits, 12 dB backoff wastes levels and loses more than clipping does: QPSK decisions only need signs (higher-order QAM would suffer from clipping).',
      curves: function () { return [
        curve({ name: '12 dB backoff (no clipping)', state: st({ ebn0: 8, adcOn: true, adcBits: 8, adcBackoff: 12 }), param: 'channel.adc.bits', values: '2:1:12', stop: { minErrors: 100, maxBits: 1e6, maxSecondsPerPoint: 20 } }),
        curve({ name: '0 dB backoff (clipping)', state: st({ ebn0: 8, adcOn: true, adcBits: 8, adcBackoff: 0 }), param: 'channel.adc.bits', values: '2:1:12', stop: { minErrors: 100, maxBits: 1e6, maxSecondsPerPoint: 20 } })]; } },
    { name: 'Loop bandwidth vs phase noise', note: 'A U shape at 7 dB: too narrow and the PLL cycle-slips on the phase walk, too wide and loop noise dominates. The optimum BnT grows with the linewidth (each slip ruins the rest of a 4000-bit frame).',
      curves: function () { return [2e-5, 1e-4, 3e-4].map(function (lw) { return curve({ name: 'Δν·Ts = ' + lw, state: st({ ebn0: 7, nbits: 4000, pnOn: true, pnLw: lw, carrierMode: 'real' }),
        param: 'rx.carrierBnT', values: '0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128', stop: { minErrors: 100, maxBits: 4e5, maxSecondsPerPoint: 20 } }); }); } },
    { name: 'Equalizers on multipath', note: 'On "3-tap mild": no equalizer floors out, LMS and ideal ZF sit close to AWGN, CMA needs longer to converge.',
      curves: function () { var mp = { mpOn: true, mpPreset: 'mild', carrierMode: 'real', frameMode: 'real' }; return [
        curve({ name: 'No equalizer', state: st(Object.assign({ eq: 'off' }, mp)), values: '0:2:12' }),
        curve({ name: 'LMS', state: st(Object.assign({ eq: 'lms', eqTaps: 11, eqMain: 3, eqMu: 0.02 }, mp)), values: '0:2:12' }),
        curve({ name: 'CMA', state: st(Object.assign({ eq: 'cma', eqTaps: 11, eqMain: 3, eqMu: 0.01 }, mp)), values: '0:2:12' }),
        curve({ name: 'Ideal ZF', state: st(Object.assign({ eq: 'zf', eqTaps: 11, eqMain: 3 }, mp)), values: '0:2:12' })]; } },
    { name: 'Pilot spacing vs Doppler', note: 'Pilot-aided tracking holds until the spacing approaches the coherence time (≈ 0.4/fd·Ts symbols); faster fading lifts the curve sooner.',
      curves: function () { return [1e-3, 3e-3, 1e-2].map(function (fd) { return curve({ name: 'fd·Ts = ' + fd, state: st({ ebn0: 20, fadeOn: true, fadeModel: 'rayleigh', fadeMode: 'jakes', fdTs: fd, carrierMode: 'pilot', pilotEvery: 8 }),
        param: 'pilotEvery', values: '4, 6, 8, 12, 16, 24, 32, 48, 64', stop: { minErrors: 100, maxBits: 1e6, maxSecondsPerPoint: 20 } }); }); } },
    { name: 'Coherent vs differential', note: 'Differential encoding doubles the BER (each symbol error hits two decisions): a small horizontal shift, ≈ 0.3–0.5 dB.',
      curves: function () { return [curve({ name: 'Coherent', values: '0:1:9' }), curve({ name: 'Differential', state: st({ diff: true }), values: '0:1:9' })]; } }
  ];

  var curves = [], selected = null, overlays = [];

  // ---------- tabs ----------
  var tabBar = el('div', 'tabs'); tabBar.setAttribute('role', 'tablist');
  var tabs = [['ber', 'Digital BER'], ['analog', 'Analog SNR']].map(function (t) {
    var b = el('button', 'tab', t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = t[0];
    b.addEventListener('click', function () { setTab(t[0]); });
    tabBar.appendChild(b); return b;
  });
  document.querySelector('main h1').after(tabBar);
  var berPanel = el('div'), anaPanel = el('div');
  panel.appendChild(berPanel); panel.appendChild(anaPanel);
  function setTab(name) {
    tabs.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
    berPanel.hidden = name !== 'ber'; anaPanel.hidden = name !== 'analog';
    document.querySelectorAll('[data-tab-card]').forEach(function (c) { c.hidden = c.dataset.tabCard !== name; });
  }

  // ---------- builder: presets, run controls, curve list ----------
  var presetSel = ui.select({ label: 'Preset', value: '0', options: PRESETS.map(function (p, i) { return { value: String(i), label: (i + 1) + '. ' + p.name }; }),
    title: 'Load a ready-made set of curves', onChange: function () { presetNote.textContent = PRESETS[+presetSel.get()].note; } });
  var presetNote = el('p', 'muted preset-note', PRESETS[0].note);
  var loadBtn = ui.button({ label: 'Load preset', title: 'Replace the curves with this preset', onClick: function () { loadPreset(+presetSel.get()); } });
  var runAll = ui.button({ label: '▶ Run all', cls: 'primary', title: 'Run every enabled curve', onClick: function () { start(curves.filter(function (c) { return c.enabled; })); } });
  var runSel = ui.button({ label: '▶ Run selected', title: 'Run only the selected curve', onClick: function () { if (selected) start([selected]); } });
  var pauseBtn = ui.button({ label: '⏸ Pause', title: 'Pause / resume the run', onClick: togglePause });
  var stopBtn = ui.button({ label: '■ Stop', title: 'Stop the run (finished points are kept)', onClick: stopRun });
  var modeTag = el('span', 'muted mode-tag', '');
  var etaLine = el('p', 'eta num', '');
  var runRow = el('div', 'btn-row'); [runAll, runSel, pauseBtn, stopBtn].forEach(function (b) { runRow.appendChild(b.el); }); runRow.appendChild(modeTag);
  var list = el('ul', 'curve-list');
  var addBtn = ui.button({ label: '+ Add curve', title: 'Add a curve with default settings', onClick: function () { var c = curve({ name: 'Curve ' + (curves.length + 1) }); curves.push(c); select(c); renderList(); } });
  berPanel.appendChild(ui.group('Sweep', [presetSel, presetNote, loadBtn.el, runRow, etaLine]));
  berPanel.appendChild(ui.group('Curves', [list, addBtn.el]));
  var editor = el('div');
  berPanel.appendChild(editor);

  function renderList() {
    list.textContent = '';
    curves.forEach(function (c, i) {
      var li = el('li', 'curve-row' + (c === selected ? ' selected' : ''));
      var en = el('input'); en.type = 'checkbox'; en.checked = c.enabled; en.title = 'Include in "Run all" and the plot'; en.setAttribute('aria-label', 'Enable ' + c.name);
      en.addEventListener('change', function () { c.enabled = en.checked; redraw(); });
      var col = el('input'); col.type = 'color'; col.value = c.color; col.title = 'Curve colour'; col.setAttribute('aria-label', 'Colour of ' + c.name);
      col.addEventListener('input', function () { c.color = col.value; redraw(); });
      var nm = el('button', 'curve-name', c.name); nm.type = 'button'; nm.title = 'Edit this curve';
      nm.addEventListener('click', function () { select(c); });
      var pr = el('progress'); pr.max = 1; pr.value = c.progress || 0; c.bar = pr;
      li.appendChild(en); li.appendChild(col); li.appendChild(nm); li.appendChild(pr);
      [['▲', 'Move up', function () { if (i > 0) { curves.splice(i - 1, 0, curves.splice(i, 1)[0]); renderList(); redraw(); } }],
        ['▼', 'Move down', function () { if (i < curves.length - 1) { curves.splice(i + 1, 0, curves.splice(i, 1)[0]); renderList(); redraw(); } }],
        ['⧉', 'Duplicate', function () { var d = curve(B.clone(Object.assign({}, c, { bar: null }))); d.id = nextId++; d.name = c.name + ' (copy)'; d.results = []; curves.splice(i + 1, 0, d); select(d); renderList(); }],
        ['✕', 'Delete', function () { curves.splice(i, 1); if (selected === c) selected = curves[0] || null; renderList(); renderEditor(); redraw(); }]
      ].forEach(function (b) { var x = el('button', 'icon-btn', b[0]); x.type = 'button'; x.title = b[1]; x.setAttribute('aria-label', b[1] + ' ' + c.name); x.addEventListener('click', b[2]); li.appendChild(x); });
      list.appendChild(li);
    });
  }
  function select(c) { selected = c; renderList(); renderEditor(); }

  // ---------- curve editor (reuses the QPSK page's controls) ----------
  function renderEditor() {
    editor.textContent = '';
    var c = selected;
    if (!c) return;
    function changed() { c.results = []; redraw(); writeHash(); }
    var paramOpts = Object.keys(B.PARAMS).map(function (k) { return { value: k, label: B.PARAMS[k].label }; });
    var name = ui.text({ label: 'Name', value: c.name, onChange: function (v) { c.name = v; renderList(); redraw(); } });
    var par = ui.select({ label: 'Swept parameter', value: B.resolveParam(c.param), options: paramOpts, title: 'Which config value changes along the x axis', onChange: function (v) { c.param = v; changed(); } });
    var vals = ui.text({ label: 'Values', value: c.values, title: '"start:step:stop" or a list, e.g. "0:1:10" or "2, 4, 8"', onChange: function (v) { c.values = v; changed(); } });
    var minE = ui.number({ label: 'Min errors', value: c.stop.minErrors, min: 1, step: 1, title: 'Stop a point after this many bit errors (≥ 100 for a trustworthy BER)', onChange: function (v) { c.stop.minErrors = v; } });
    var maxB = ui.number({ label: 'Max bits', value: c.stop.maxBits, min: 1000, step: 1000, title: 'Stop a point after this many bits', onChange: function (v) { c.stop.maxBits = v; } });
    var maxS = ui.number({ label: 'Max s / point', value: c.stop.maxSecondsPerPoint, min: 1, step: 1, title: 'Time limit per point (time-limited points depend on machine speed)', onChange: function (v) { c.stop.maxSecondsPerPoint = v; } });
    var floor = ui.text({ label: 'Floor BER', value: String(c.floorBer), title: 'Eb/N0 sweeps stop once BER drops below this (or a point has 0 errors at max bits)', onChange: function (v) { c.floorBer = +v || 0; } });
    var th = ui.select({ label: 'Theory overlay', value: c.theory, title: 'Closed-form curve drawn with this one', onChange: function (v) { c.theory = v; redraw(); },
      options: [{ value: 'auto', label: 'Auto (from the config)' }, { value: 'awgn', label: 'AWGN' }, { value: 'rayleigh', label: 'Rayleigh' }, { value: 'rician', label: 'Rician K' },
        { value: 'phase', label: 'Static phase error' }, { value: 'diff', label: 'Differential (DE-QPSK)' }, { value: 'none', label: 'None' }] });
    var seed = ui.number({ label: 'Sweep seed', value: c.seed, min: 0, step: 1, title: 'Point i uses a seed derived from this and i', onChange: function (v) { c.seed = v; changed(); } });
    editor.appendChild(ui.group('Selected curve', [name, par, vals, th, minE, maxB, maxS, floor, seed]));
    // Link setup: the QPSK page's own controls, bound to this curve's state.
    var Q = SDR.qpskControls.create({ onInput: function () {}, onChange: function () { read(); } });
    var all = [];
    Object.keys(Q.c).forEach(function (k) { all.push(Q.c[k]); });
    function read() { all.forEach(function (x) { if (x.key) c.state[x.key] = x.get(); }); Q.sync(c.state); changed(); }
    all.forEach(function (x) { if (x.key && x.key in c.state) x.set(c.state[x.key], true); });
    var box = el('div', 'link-setup');
    box.appendChild(el('h3', 'grid-title', 'Link setup (same controls as the QPSK page)'));
    box.appendChild(ui.group('Signal', Q.groups.signal));
    box.appendChild(ui.group('Channel', Q.groups.channel));
    Q.sections.forEach(function (sx) { box.appendChild(ui.section(sx[0], sx[1], sx[2]).el); });
    box.appendChild(ui.group('Receiver', Q.groups.receiver));
    Q.sync(c.state);
    editor.appendChild(box);
  }

  // ---------- plot, tables ----------
  var guides = ui.toggle({ label: 'Guide lines at 1e-3 / 1e-4', checked: true, onChange: function () { redraw(); } });
  var plotCard = page.addCard(null, 'plot'); plotCard.dataset.tabCard = 'ber';
  var canvas = el('canvas'); plotCard.appendChild(canvas);
  var plot = SDR.plot.createPlot(canvas, { title: 'Bit error rate', yScale: 'log', yLabel: 'BER', height: 420 });
  var expRow = el('div', 'btn-row');
  [['Export CSV', exportCsv], ['Export JSON', exportJson], ['Export PNG', function () { plot.downloadPNG('ber.png'); }], ['Copy link', copyLink]].forEach(function (b) { expRow.appendChild(ui.button({ label: b[0], onClick: b[1] }).el); });
  var imp = ui.fileInput({ label: 'Import JSON run', accept: '.json,application/json', onFile: importJson, title: 'Reload a run exported as JSON' });
  plotCard.appendChild(guides.el); plotCard.appendChild(expRow); plotCard.appendChild(imp.el);

  var libCard = page.addCard(null); libCard.dataset.tabCard = 'ber';
  var lib = B.createLibrary();
  var libName = ui.text({ label: 'Save this run as', value: 'My run' });
  var libSave = ui.button({ label: 'Save', title: 'Store the curves and results in this browser', onClick: function () {
    lib.save(libName.get() || 'Run', JSON.parse(B.toJSON(serialCurves(true)))); renderLib();
    status.set(lib.available ? 'Saved' : 'Saved for this session only (browser storage unavailable)', lib.available ? 'ok' : 'err');
  } });
  var libList = el('ul', 'lib-list');
  libCard.appendChild(el('h3', 'grid-title', 'Saved runs'));
  var libRow = el('div', 'btn-row'); libRow.appendChild(libName.el); libRow.appendChild(libSave.el);
  libCard.appendChild(libRow); libCard.appendChild(libList);
  function renderLib() {
    libList.textContent = '';
    var items = lib.list();
    if (!items.length) libList.appendChild(el('li', 'muted', 'Nothing saved yet' + (lib.available ? '' : ' (browser storage unavailable: saves last until reload)')));
    items.forEach(function (it) {
      var li = el('li'), on = overlays.some(function (o) { return o.id === it.id; });
      li.appendChild(el('span', '', it.name + ' · ' + it.curves + ' curve(s) · ' + new Date(it.date).toLocaleString()));
      [['Overlay', function () {
        if (on) overlays = overlays.filter(function (o) { return o.id !== it.id; }); else overlays.push({ id: it.id, name: it.name, run: lib.load(it.id) });
        renderLib(); redraw();
      }, on ? 'Remove overlay' : 'Overlay'], ['Load', function () { loadRun(lib.load(it.id)); }], ['Delete', function () { lib.remove(it.id); overlays = overlays.filter(function (o) { return o.id !== it.id; }); renderLib(); redraw(); }]]
        .forEach(function (b) { li.appendChild(ui.button({ label: b[2] || b[0], onClick: b[1] }).el); });
      libList.appendChild(li);
    });
  }

  var sumCard = page.addCard(null); sumCard.dataset.tabCard = 'ber';
  var sumTable = el('table', 'data'); sumCard.appendChild(el('h3', 'grid-title', 'Summary')); sumCard.appendChild(sumTable);
  var resCard = page.addCard(null); resCard.dataset.tabCard = 'ber';
  var resTable = el('table', 'data'); resCard.appendChild(el('h3', 'grid-title', 'Results (click a column to sort)')); resCard.appendChild(resTable);
  var sortKey = 'curve', sortDir = 1;

  function sweepOf(c) {
    return { name: c.name, cfg: SDR.qpskControls.cfgFrom(c.state), param: B.resolveParam(c.param), values: B.parseValues(c.values),
      stop: Object.assign({}, c.stop), floorBer: c.floorBer, seed: c.seed >>> 0 };
  }
  function theoryOf(c) {
    var sw = sweepOf(c), kind = c.theory === 'auto' ? B.theoryKind(sw.cfg) : c.theory;
    if (kind === 'none' || !sw.values.length) return null;
    return { kind: kind, pts: B.theoryCurve(sw, kind).filter(function (p) { return p.ber > 0 && isFinite(p.ber); }) };
  }
  function info(c, r) {
    return r.skipped ? 'below floor (skipped)' : r.errors + '/' + r.bits.toLocaleString() + ' bits, CI [' + fmtE(r.ciLow) + ', ' + fmtE(r.ciHigh) + '], EVM ' +
      (isFinite(r.evmDb) ? r.evmDb.toFixed(1) + ' dB' : '–') + ', ' + r.seconds.toFixed(1) + ' s, stopped by ' + r.stoppedBy;
  }

  function redraw() {
    var en = curves.filter(function (c) { return c.enabled; }), first = en[0] || curves[0];
    var pi = first ? B.paramInfo(first.param) : { label: 'Eb/N0 (dB)' };
    var series = [], ann = [];
    if (guides.get()) ann.push({ type: 'hline', y: 1e-3, label: '1e-3' }, { type: 'hline', y: 1e-4, label: '1e-4' });
    var seenTheory = {};
    en.forEach(function (c) {
      var th = theoryOf(c);
      if (th && th.pts.length) {
        // Identical theory curves (e.g. a flat AWGN line when sweeping something other than Eb/N0) are drawn once.
        var key = th.kind + '|' + th.pts.map(function (p) { return p.value + ':' + p.ber; }).join(',');
        if (!seenTheory[key]) {
          seenTheory[key] = true;
          var flat = B.resolveParam(c.param) !== 'ebn0Db';
          series.push({ type: 'line', x: th.pts.map(function (p) { return p.value; }), y: th.pts.map(function (p) { return p.ber; }), color: c.color, lineWidth: 1.4,
            label: 'theory (' + th.kind + ')' + (flat ? ' at ' + c.state.ebn0 + ' dB' : ': ' + c.name) });
        }
      }
      var rs = c.results.filter(function (r) { return r && r.ber > 0; }).sort(function (a, b) { return a.value - b.value; });
      if (rs.length) series.push({ type: 'errorbar', x: rs.map(function (r) { return r.value; }), y: rs.map(function (r) { return r.ber; }), yLow: rs.map(function (r) { return Math.max(r.ciLow, 1e-12); }),
        yHigh: rs.map(function (r) { return r.ciHigh; }), color: c.color, radius: 3.5, label: c.name, info: rs.map(function (r) { return info(c, r); }) });
      if (B.resolveParam(c.param) === 'ebn0Db') [1e-3, 1e-4].forEach(function (t) {
        var x = B.requiredEbN0(c.results, t);
        if (isFinite(x)) { series.push({ type: 'scatter', x: [x], y: [t], radius: 5, color: c.color }); ann.push({ type: 'text', x: x, y: t, text: x.toFixed(1) + ' dB', color: c.color }); }
      });
    });
    overlays.forEach(function (o) {
      o.run.curves.forEach(function (c) {
        var rs = (c.results || []).filter(function (r) { return r.ber > 0; }).sort(function (a, b) { return a.value - b.value; });
        if (rs.length) series.push({ type: 'line', x: rs.map(function (r) { return r.value; }), y: rs.map(function (r) { return r.ber; }), color: c.color, dash: [3, 3], lineWidth: 1.2, alpha: 0.7, label: '(saved) ' + o.name + ': ' + c.name });
      });
    });
    plot.setOptions({ xLabel: pi.label, xScale: pi.log ? 'log' : 'linear', annotations: ann, xUnit: pi.unit || '' });
    plot.setData(series);
    renderTables();
  }

  // Redraws from the sweep run in their own animation frame, outside the compute slices.
  var rafPending = 0;
  function scheduleRedraw() { if (!rafPending) rafPending = requestAnimationFrame(function () { rafPending = 0; redraw(); }); }

  function renderTables() {
    // Summary
    sumTable.textContent = '';
    var h = el('tr'); ['Curve', 'Theory', 'Loss @1e-3', 'Loss @1e-4', 'Diversity slope', 'Total bits', 'Total time'].forEach(function (t) { h.appendChild(el('th', '', t)); });
    sumTable.appendChild(h);
    curves.forEach(function (c) {
      var th = theoryOf(c), eb = B.resolveParam(c.param) === 'ebn0Db', tr = el('tr');
      var tb = 0, ts = 0; c.results.forEach(function (r) { tb += r.bits; ts += r.seconds; });
      var loss = function (t) { var v = eb && th ? B.implementationLoss(c.results, th.pts, t) : NaN; return isFinite(v) ? v.toFixed(2) + ' dB' : '–'; };
      var slope = eb ? B.diversitySlope(c.results) : NaN;
      [c.name, th ? th.kind : '–', loss(1e-3), loss(1e-4), isFinite(slope) ? slope.toFixed(2) : '–', tb.toLocaleString(), fmtS(ts)].forEach(function (v, i) {
        var td = el('td', i ? 'num' : '', v); if (!i) td.style.borderLeft = '4px solid ' + c.color; tr.appendChild(td);
      });
      sumTable.appendChild(tr);
    });
    // Results
    var cols = [['curve', 'Curve'], ['value', 'Value'], ['errors', 'Errors'], ['bits', 'Bits'], ['ber', 'BER'], ['ci', '95% CI'], ['evmDb', 'EVM (dB)'], ['seconds', 'Time (s)'], ['stoppedBy', 'Stopped by']];
    var rows = [];
    curves.forEach(function (c) { c.results.forEach(function (r) { if (r) rows.push(Object.assign({ curve: c.name, color: c.color }, r)); }); });
    rows.sort(function (a, b) { var x = a[sortKey], y = b[sortKey]; if (sortKey === 'ci') { x = a.ciLow; y = b.ciLow; } return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
    resTable.textContent = '';
    var hr = el('tr');
    cols.forEach(function (col) {
      var th = el('th'), b = el('button', 'sort', col[1] + (sortKey === col[0] ? (sortDir > 0 ? ' ▲' : ' ▼') : '')); b.type = 'button';
      b.addEventListener('click', function () { if (sortKey === col[0]) sortDir = -sortDir; else { sortKey = col[0]; sortDir = 1; } renderTables(); });
      th.appendChild(b); hr.appendChild(th);
    });
    resTable.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      [r.curve, +r.value.toPrecision(6), r.errors, r.bits.toLocaleString(), fmtE(r.ber), r.skipped ? '–' : '[' + fmtE(r.ciLow) + ', ' + fmtE(r.ciHigh) + ']',
        isFinite(r.evmDb) ? r.evmDb.toFixed(1) : '–', r.seconds.toFixed(1), r.skipped ? 'below floor' : r.stoppedBy].forEach(function (v, i) {
        var td = el('td', i ? 'num' : '', v); if (!i) td.style.borderLeft = '4px solid ' + r.color; tr.appendChild(td);
      });
      resTable.appendChild(tr);
    });
  }

  // ---------- engine driver ----------
  var running = null;   // { list, ac, paused, pool, t0, bits }
  var pool = null, poolTried = false;
  function getPool() {
    if (!poolTried) {
      poolTried = true;
      var n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
      pool = B.createPool('js/ber-worker.js', n);
    }
    return pool;
  }
  function setMode(text) { modeTag.textContent = text; }
  setMode(B.canUseWorkers() ? 'Mode: workers (on run)' : 'Mode: main thread (file://: workers need http)');

  function start(list) {
    if (running || !list.length) return;
    list.forEach(function (c) { c.results = []; c.progress = 0; c.sweep = sweepOf(c); });
    renderList(); redraw();
    var p = getPool();
    running = { list: list, paused: false, t0: performance.now(), bits: 0 };
    pauseBtn.el.textContent = '⏸ Pause';
    if (p) runWorkers(list, p); else runMain(list);
  }

  function updateEta() {
    if (!running) { etaLine.textContent = ''; return; }
    var el2 = (performance.now() - running.t0) / 1000, bps = running.bits / Math.max(el2, 1e-3), rem = 0;
    running.list.forEach(function (c) { var r = B.estimateRemaining(c.sweep, c.results.filter(Boolean), bps); if (isFinite(r)) rem += r / (running.workers || 1); });
    etaLine.textContent = 'Elapsed ' + fmtS(el2) + ' · ETA ≈ ' + fmtS(rem) + ' · ' + (bps / 1000).toFixed(0) + ' kbit/s';
  }
  function finishRun(msg) {
    var el2 = (performance.now() - running.t0) / 1000;
    running = null; updateEta();
    status.set(msg + ' in ' + fmtS(el2), 'ok');
    etaLine.textContent = 'Last run: ' + fmtS(el2);
    redraw();
  }

  function runMain(list) {
    setMode('Mode: main thread');
    running.ac = new AbortController();
    var lastDraw = 0;
    ui.runChunked(function* () {
      for (var k = 0; k < list.length; k++) {
        var c = list[k], n = c.sweep.values.length;
        var it = B.sweepTask(c.sweep, function (i, rec) { c.results[i] = rec; running.bits += rec.bits; scheduleRedraw(); }), r;
        while (!(r = it.next()).done) {
          c.progress = (r.value.point + (r.value.bits ? Math.min(0.95, r.value.errors / c.sweep.stop.minErrors) : 0)) / n;
          if (c.bar) c.bar.value = c.progress;
          if (performance.now() - lastDraw > 500) { lastDraw = performance.now(); updateEta(); }
          yield c.progress;
        }
        c.progress = 1; if (c.bar) c.bar.value = 1;
      }
    }, { signal: running.ac.signal, isPaused: function () { return running && running.paused; } }).then(function (res) {
      finishRun((res.aborted ? 'Stopped' : res.error ? 'Failed: ' + res.error.message : 'Run finished') + ' (main thread, longest slice ' + Math.round(res.maxSliceMs) + ' ms)');
    });
  }

  function runWorkers(list, p) {
    setMode('Mode: ' + p.size + ' workers');
    running.workers = p.size;
    var outstanding = 0, floorAt = {};
    list.forEach(function (c) {
      c.sweep.values.forEach(function (v, i) {
        outstanding++;
        p.run({ cfg: B.pointCfg(c.sweep, v), seed: B.deriveSeed(c.sweep.seed, i), stop: c.sweep.stop, tag: c.id + ':' + i }).then(function (rec) {
          if (!running) return;
          var f = floorAt[c.id];
          c.results[i] = f !== undefined && i > f ? B.floorRecord(v) : Object.assign({ value: v }, rec);
          running.bits += rec.bits;
          if (f === undefined && B.belowFloor(c.sweep, c.results[i])) {   // skip the higher-SNR points still queued
            floorAt[c.id] = i;
            for (var j = i + 1; j < c.sweep.values.length; j++) if (!c.results[j]) c.results[j] = B.floorRecord(c.sweep.values[j]);
            p.cancelQueued(function (job) { var t = String(job.tag).split(':'); if (+t[0] === c.id && +t[1] > i) { outstanding--; return true; } return false; });
          }
          done();
        }, function (e) { status.set('Worker error: ' + e.message, 'err'); done(); });
      });
    });
    function done() {
      outstanding--;
      list.forEach(function (c) { c.progress = c.results.filter(Boolean).length / c.sweep.values.length; if (c.bar) c.bar.value = c.progress; });
      updateEta(); scheduleRedraw();
      if (running && outstanding <= 0) finishRun('Run finished (' + p.size + ' workers)');
    }
  }

  function togglePause() {
    if (!running) return;
    running.paused = !running.paused;
    if (pool && running.workers) { if (running.paused) pool.pause(); else pool.resume(); }
    pauseBtn.el.textContent = running.paused ? '▶ Resume' : '⏸ Pause';
    status.set(running.paused ? 'Paused' : 'Running…');
  }
  function stopRun() {
    if (!running) return;
    if (running.ac) running.ac.abort();
    if (running.workers) { pool.terminate(); pool = null; poolTried = false; finishRun('Stopped'); }
  }

  // ---------- presets, hash, import/export ----------
  function serialCurves(withResults) {
    var base = st();
    return curves.map(function (c) {
      var state = c.state;
      if (!withResults) {   // links carry only what differs from the BER defaults (loadCurves merges them back)
        state = {};
        Object.keys(c.state).forEach(function (k) { if (c.state[k] !== base[k]) state[k] = c.state[k]; });
      }
      var o = { name: c.name, color: c.color, enabled: c.enabled, state: state, param: c.param, values: c.values, stop: c.stop, floorBer: c.floorBer, theory: c.theory, seed: c.seed };
      if (withResults) { o.cfg = sweepOf(c).cfg; o.results = c.results.filter(Boolean); o.pointSeeds = sweepOf(c).values.map(function (v, i) { return B.deriveSeed(c.seed >>> 0, i); }); }
      return o;
    });
  }
  function loadCurves(defs) {
    curves = defs.map(function (d) { var c = curve(d); c.state = Object.assign(st(), d.state || {}); c.results = (d.results || []).slice(); return c; });
    selected = curves[0] || null;
    renderList(); renderEditor(); redraw();
  }
  function loadPreset(i) { loadCurves(PRESETS[i].curves()); presetSel.set(String(i), true); presetNote.textContent = PRESETS[i].note; writeHash(); status.set('Loaded preset: ' + PRESETS[i].name, 'ok'); }
  function loadRun(run) { if (run) { loadCurves(run.curves); status.set('Loaded run', 'ok'); } }
  function writeHash() { try { history.replaceState(null, '', '#sweep=' + encodeURIComponent(JSON.stringify(serialCurves(false)))); } catch (e) { /* ignore */ } }
  function copyLink() { writeHash(); ui.copyText(location.href).then(function () { status.set('Link to this sweep definition copied (results are not included)', 'ok'); }, function () { status.set('Copy failed: the link is in the address bar', 'err'); }); }
  function download(text, name, type) { var url = URL.createObjectURL(new Blob([text], { type: type })); SDR.plot.downloadURL(url, name); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  function exportCsv() { download(B.toCSV(serialCurves(true)), 'ber-results.csv', 'text/csv'); }
  function exportJson() { download(B.toJSON(serialCurves(true)), 'ber-run.json', 'application/json'); }
  function importJson(file) {
    file.text().then(function (t) { loadRun(B.fromJSON(t)); }).catch(function (e) { status.set('Import failed: ' + e.message, 'err'); });
  }
  // Expose for tests / automation (DOM-free helpers stay in SDR.ber).
  SDR.berPage = { curves: function () { return curves; }, loadPreset: loadPreset, loadRun: loadRun, serialCurves: serialCurves, start: start, togglePause: togglePause, stopRun: stopRun,
    isRunning: function () { return !!running; } };

  // ---------- Analog SNR tab ----------
  var anaPlotCard = page.addCard(null, 'plot'); anaPlotCard.dataset.tabCard = 'analog';
  var anaCanvas = el('canvas'); anaPlotCard.appendChild(anaCanvas);
  var anaPlot = SDR.plot.createPlot(anaCanvas, { title: 'Analog output SNR vs baseband SNR γ = C/(N0·W)', xLabel: 'γ (dB)', yLabel: 'output SNR (dB)', xUnit: 'dB', yUnit: 'dB', height: 420 });
  var anaExp = el('div', 'btn-row'); anaPlotCard.appendChild(anaExp);
  var anaRes = [];
  var aEnv = ui.toggle({ label: 'AM envelope (DSB-LC, μ = 0.8)', checked: true }), aCoh = ui.toggle({ label: 'AM coherent (DSB-LC, μ = 0.8)', checked: true });
  var aBetas = ui.text({ label: 'FM β values', value: '1, 2, 5', title: 'Tone FM, W = 3 kHz, discriminator' });
  var aGam = ui.text({ label: 'γ values (dB)', value: '0:2:40' });
  var aRun = ui.button({ label: '▶ Run analog sweep', cls: 'primary', onClick: runAnalog }), aStop = ui.button({ label: '■ Stop', onClick: function () { if (anaAc) anaAc.abort(); } });
  var aRow = el('div', 'btn-row'); aRow.appendChild(aRun.el); aRow.appendChild(aStop.el);
  anaPanel.appendChild(ui.group('Analog output SNR', [el('p', 'muted', 'Reuses the AM and FM DSP. Each point is one simulated burst; theory lines are dashed.'), aEnv, aCoh, aBetas, aGam, aRow]));
  [['Export CSV', function () { download('curve,gamma_db,snr_db,theory_db\n' + anaRes.map(function (r) { return [r.curve, r.x, r.y.toFixed(3), r.th.toFixed(3)].join(','); }).join('\n') + '\n', 'analog-snr.csv', 'text/csv'); }],
    ['Export JSON', function () { download(JSON.stringify({ app: 'sdr-web', kind: 'analog-snr', version: B.VERSION, results: anaRes }, null, 1), 'analog-snr.json', 'application/json'); }],
    ['Export PNG', function () { anaPlot.downloadPNG('analog-snr.png'); }]].forEach(function (b) { anaExp.appendChild(ui.button({ label: b[0], onClick: b[1] }).el); });
  var anaAc = null;
  function runAnalog() {
    if (anaAc) return;
    var gam = B.parseValues(aGam.get()), kinds = [];
    if (aEnv.get()) kinds.push({ kind: 'am-env', name: 'AM envelope' });
    if (aCoh.get()) kinds.push({ kind: 'am-coh', name: 'AM coherent' });
    B.parseValues(aBetas.get()).forEach(function (b) { kinds.push({ kind: 'fm', beta: b, name: 'FM β = ' + b }); });
    anaRes = []; anaAc = new AbortController();
    var t0 = performance.now();
    ui.runChunked(function* () {
      for (var k = 0; k < kinds.length; k++) for (var i = 0; i < gam.length; i++) {
        var q = kinds[k];
        anaRes.push({ curve: q.name, kind: q.kind, beta: q.beta, x: gam[i], y: B.analogPoint(q.kind, gam[i], B.deriveSeed(1, k * 1000 + i), q.beta), th: B.analogTheory(q.kind, gam[i], q.beta) });
        drawAnalog(kinds);
        yield (k * gam.length + i) / (kinds.length * gam.length);
      }
    }, { signal: anaAc.signal, onProgress: function (p) { status.set('Analog sweep ' + Math.round(100 * p) + '%'); } }).then(function (res) {
      anaAc = null; status.set((res.aborted ? 'Analog sweep stopped' : 'Analog sweep done') + ' in ' + fmtS((performance.now() - t0) / 1000) + ' (longest slice ' + Math.round(res.maxSliceMs) + ' ms)', 'ok');
    });
  }
  function drawAnalog(kinds) {
    var series = [], gam = B.parseValues(aGam.get());
    kinds.forEach(function (q, k) {
      var col = PAL[k % PAL.length], rs = anaRes.filter(function (r) { return r.curve === q.name; });
      series.push({ type: 'line', x: gam, y: gam.map(function (g) { return B.analogTheory(q.kind, g, q.beta); }), color: col, dash: [6, 4], lineWidth: 1.1 });
      if (rs.length) series.push({ type: 'line', x: rs.map(function (r) { return r.x; }), y: rs.map(function (r) { return r.y; }), color: col, label: q.name, lineWidth: 1.6 });
    });
    anaPlot.setData(series);
  }

  // ---------- start ----------
  setTab('ber');
  var h = location.hash;
  try {
    if (h.indexOf('#sweep=') === 0) { loadCurves(JSON.parse(decodeURIComponent(h.slice(7)))); status.set('Loaded the shared sweep definition', 'ok'); }
    else if (h.indexOf('#import=') === 0) {
      loadCurves([curve({ name: 'From QPSK page', state: Object.assign(st(), JSON.parse(decodeURIComponent(h.slice(8)))), values: '0:1:12' })]);
      status.set('Imported the QPSK page setup as a new curve: press ▶ Run all', 'ok');
      writeHash();
    } else loadPreset(0);
  } catch (e) { loadPreset(0); status.set('Could not read the link: ' + e.message, 'err'); }
  renderLib();
  if (SDR.shell) {
    SDR.shell.action('space', function () { if (running) togglePause(); else start(curves.filter(function (c) { return c.enabled; })); }, 'Run all curves / pause');
    SDR.shell.action('reset', function () { loadPreset(0); }, 'Reload the first preset');
    SDR.shell.action('link', copyLink, 'Copy a link to this sweep definition');
    SDR.shell.tour([{ sel: '#controls', text: 'Load a preset (each comes with a one-line "what to look for"), or build curves of your own.' },
      { sel: '.curve-list', text: 'Each curve is a full QPSK link setup plus the parameter it sweeps; tick, reorder, duplicate or delete them.' },
      { sel: '#plots .card.plot', text: 'Simulation markers carry 95% error bars; solid lines are theory; the dB labels mark the required Eb/N0.' },
      { sel: '.tabs', text: 'The Analog SNR tab overlays AM and FM output SNR on one axis.' }]);
  }
})();
