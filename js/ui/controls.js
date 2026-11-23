// SDR.ui — small reusable form controls, live-update helpers, URL-hash state, status bar.
// Every control: { el, key, get(), set(value, silent), setDisabled(bool) }.
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});
  var uid = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function nextId(prefix) { return 'sdr-' + prefix + '-' + ++uid; }

  // ---------- timing ----------
  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // Leading + trailing throttle: at most one call per `ms`, last call always delivered.
  function throttle(fn, ms) {
    var last = 0, t = 0, pending = null;
    return function () {
      pending = arguments;
      var wait = ms - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); clearTimeout(t); t = 0; var a = pending; pending = null; fn.apply(null, a); }
      else if (!t) t = setTimeout(function () { t = 0; last = Date.now(); var a = pending; pending = null; fn.apply(null, a); }, wait);
    };
  }

  // Live-update pattern: input() → cheap preview at ≤ fps; commit() → full recompute (once, after input settles).
  function live(o) {
    var preview = throttle(o.preview, 1000 / (o.fps || 30));
    var commit = debounce(o.commit, o.commitDelay === undefined ? 120 : o.commitDelay);
    return { input: preview, commit: commit };
  }

  // Runs a generator in time-budgeted slices so the page stays responsive.
  // Each slice calls next() until ~budgetMs (default 12) has passed, then yields to the browser with
  // setTimeout(0). Each yield should be a small unit of work (a few ms). The last yielded value goes
  // to onProgress. Cancel with an AbortController signal; the generator's finally blocks run.
  // Resolves { done, value } | { aborted } | { error }, plus { slices, maxSliceMs } for diagnostics.
  function runChunked(task, opts) {
    opts = opts || {};
    var it = typeof task === 'function' ? task() : task, budget = opts.budgetMs || 12;
    var slices = 0, maxSlice = 0, lastValue;
    return new Promise(function (resolve) {
      function finish(res) {
        res.slices = slices; res.maxSliceMs = maxSlice;
        if (opts.onDone) opts.onDone(res);
        resolve(res);
      }
      function slice() {
        if (opts.signal && opts.signal.aborted) {
          try { it.return(); } catch (e) { /* generator already closed */ }
          return finish({ aborted: true });
        }
        var t0 = performance.now(), r;
        try {
          do { r = it.next(); if (!r.done) lastValue = r.value; } while (!r.done && performance.now() - t0 < budget);
        } catch (e) {
          return finish({ error: e });
        }
        slices++;
        maxSlice = Math.max(maxSlice, performance.now() - t0);
        if (r.done) return finish({ done: true, value: r.value });
        if (opts.onProgress) opts.onProgress(lastValue);
        setTimeout(slice, 0);
      }
      setTimeout(slice, 0);
    });
  }

  // ---------- controls ----------
  function decimalsOf(step) {
    if (!step || step >= 1) return 0;
    return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
  }

  // slider({ key, label, min, max, step, value, unit, log, title, onInput, onChange })
  // onInput fires while dragging; onChange on release / number-box commit.
  function slider(o) {
    var id = nextId('sl'), log = !!o.log, min = o.min, max = o.max, step = o.step || (log ? 0 : 1);
    var RES = 1000; // log sliders map 0..RES onto [min, max] geometrically
    var wrap = el('div', 'ctl ctl-slider');
    var lab = el('label', '', o.label);
    lab.htmlFor = id;
    var row = el('div', 'ctl-row');
    var range = el('input');
    range.type = 'range'; range.id = id;
    if (log) { range.min = 0; range.max = RES; range.step = 1; } else { range.min = min; range.max = max; range.step = step || 'any'; }
    var num = el('input', 'num');
    num.type = 'number'; num.min = min; num.max = max; num.step = step || 'any';
    range.name = (o.key || id) + '-range'; num.name = o.key || id;
    num.setAttribute('aria-label', o.label + (o.unit ? ' (' + o.unit + ')' : ''));
    var unit = el('span', 'unit', o.unit || '');
    if (o.title) { wrap.title = o.title; }
    row.appendChild(range); row.appendChild(num); row.appendChild(unit);
    wrap.appendChild(lab); wrap.appendChild(row);

    var value = o.value;
    function clamp(v) { return Math.min(max, Math.max(min, v)); }
    function quant(v) { return step ? Math.round(v / step) * step : log ? +v.toPrecision(3) : v; }
    function toPos(v) { return log ? Math.round((Math.log(v / min) / Math.log(max / min)) * RES) : v; }
    function fromPos(p) { return log ? min * Math.pow(max / min, p / RES) : +p; }
    function fmt(v) {
      if (step) return v.toFixed(decimalsOf(step));
      return String(+v.toPrecision(log ? 3 : 4));
    }
    function show() { range.value = toPos(value); num.value = fmt(value); }

    range.addEventListener('input', function () {
      value = clamp(quant(fromPos(range.value)));
      num.value = fmt(value);
      if (o.onInput) o.onInput(value);
    });
    range.addEventListener('change', function () { if (o.onChange) o.onChange(value); });
    num.addEventListener('change', function () {
      var v = parseFloat(num.value);
      if (!isFinite(v)) { show(); return; }
      value = clamp(quant(v));
      show();
      if (o.onInput) o.onInput(value);
      if (o.onChange) o.onChange(value);
    });
    show();

    return {
      el: wrap, key: o.key, range: range, number: num,
      get: function () { return value; },
      set: function (v, silent) {
        value = clamp(quant(+v));
        show();
        if (!silent) { if (o.onInput) o.onInput(value); if (o.onChange) o.onChange(value); }
      },
      setDisabled: function (d) { range.disabled = num.disabled = d; wrap.classList.toggle('disabled', d); }
    };
  }

  // number({ key, label, value, min, max, step, title, onChange })
  function number(o) {
    var id = nextId('nb');
    var wrap = el('div', 'ctl ctl-number');
    var lab = el('label', '', o.label);
    lab.htmlFor = id;
    var inp = el('input', 'num');
    inp.type = 'number'; inp.id = id; inp.name = o.key || id;
    if (o.min !== undefined) inp.min = o.min;
    if (o.max !== undefined) inp.max = o.max;
    inp.step = o.step || 1;
    inp.value = o.value;
    if (o.title) wrap.title = o.title;
    wrap.appendChild(lab); wrap.appendChild(inp);
    var value = o.value;
    inp.addEventListener('change', function () {
      var v = parseFloat(inp.value);
      if (!isFinite(v)) { inp.value = value; return; }
      value = v;
      if (o.onChange) o.onChange(value);
    });
    return {
      el: wrap, key: o.key, input: inp,
      get: function () { return value; },
      set: function (v, silent) { value = +v; inp.value = value; if (!silent && o.onChange) o.onChange(value); },
      setDisabled: function (d) { inp.disabled = d; wrap.classList.toggle('disabled', d); }
    };
  }

  // text({ key, label, value, title, onChange }) — single-line text box, committed on change.
  function text(o) {
    var id = nextId('tx');
    var wrap = el('div', 'ctl ctl-number');
    var lab = el('label', '', o.label);
    lab.htmlFor = id;
    var inp = el('input', 'num');
    inp.type = 'text'; inp.id = id; inp.name = o.key || id; inp.value = o.value;
    if (o.title) wrap.title = o.title;
    wrap.appendChild(lab); wrap.appendChild(inp);
    inp.addEventListener('change', function () { if (o.onChange) o.onChange(inp.value); });
    return {
      el: wrap, key: o.key, input: inp,
      get: function () { return inp.value; },
      set: function (v, silent) { inp.value = v; if (!silent && o.onChange) o.onChange(inp.value); },
      setDisabled: function (d) { inp.disabled = d; wrap.classList.toggle('disabled', d); }
    };
  }

  // select({ key, label, options: [{value, label}] | ['a','b'], value, title, onChange })
  function select(o) {
    var id = nextId('se');
    var wrap = el('div', 'ctl ctl-select');
    var lab = el('label', '', o.label);
    lab.htmlFor = id;
    var sel = el('select');
    sel.id = id; sel.name = o.key || id;
    o.options.forEach(function (op) {
      var opt = el('option', '', typeof op === 'string' ? op : op.label);
      opt.value = typeof op === 'string' ? op : op.value;
      sel.appendChild(opt);
    });
    sel.value = o.value;
    if (o.title) wrap.title = o.title;
    wrap.appendChild(lab); wrap.appendChild(sel);
    sel.addEventListener('change', function () { if (o.onChange) o.onChange(sel.value); });
    return {
      el: wrap, key: o.key, select: sel,
      get: function () { return sel.value; },
      set: function (v, silent) { sel.value = v; if (!silent && o.onChange) o.onChange(sel.value); },
      setDisabled: function (d) { sel.disabled = d; wrap.classList.toggle('disabled', d); }
    };
  }

  // toggle({ key, label, checked, title, onChange }) — checkbox styled as a switch.
  function toggle(o) {
    var wrap = el('label', 'ctl ctl-toggle');
    var inp = el('input');
    inp.type = 'checkbox'; inp.checked = !!o.checked; inp.name = o.key || nextId('tg');
    inp.setAttribute('role', 'switch');
    var sw = el('span', 'switch');
    sw.setAttribute('aria-hidden', 'true');
    if (o.title) wrap.title = o.title;
    wrap.appendChild(inp); wrap.appendChild(sw); wrap.appendChild(el('span', 'ctl-toggle-label', o.label));
    inp.addEventListener('change', function () { if (o.onChange) o.onChange(inp.checked); });
    return {
      el: wrap, key: o.key, input: inp,
      get: function () { return inp.checked; },
      set: function (v, silent) { inp.checked = !!v; if (!silent && o.onChange) o.onChange(inp.checked); },
      setDisabled: function (d) { inp.disabled = d; wrap.classList.toggle('disabled', d); }
    };
  }

  // button({ label, title, onClick, cls })
  function button(o) {
    var b = el('button', 'btn' + (o.cls ? ' ' + o.cls : ''), o.label);
    b.type = 'button';
    if (o.title) b.title = o.title;
    if (o.ariaLabel) b.setAttribute('aria-label', o.ariaLabel);
    b.addEventListener('click', o.onClick);
    return { el: b, setDisabled: function (d) { b.disabled = d; } };
  }

  // fileInput({ label, accept, title, onFile })
  function fileInput(o) {
    var id = nextId('fi');
    var wrap = el('div', 'ctl ctl-file');
    var lab = el('label', '', o.label);
    lab.htmlFor = id;
    var inp = el('input');
    inp.type = 'file'; inp.id = id; inp.name = id;
    if (o.accept) inp.accept = o.accept;
    if (o.title) wrap.title = o.title;
    wrap.appendChild(lab); wrap.appendChild(inp);
    inp.addEventListener('change', function () { if (inp.files && inp.files[0] && o.onFile) o.onFile(inp.files[0]); });
    return { el: wrap, input: inp, setDisabled: function (d) { inp.disabled = d; } };
  }

  // section(title, toggle, [controls]) → collapsible section: a disclosure button (aria-expanded) and an
  // on/off switch side by side in the header (not nested, so both stay separately operable).
  // The body is greyed out while the switch is off, and expands when it is switched on (until folded by hand).
  function section(title, tog, children) {
    var d = el('div', 'ctl-section'), head = el('div', 'ctl-section-head'), id = nextId('sec');
    var btn = el('button', 'ctl-section-title', title);
    btn.type = 'button'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id);
    head.appendChild(btn);
    if (tog) { tog.el.classList.add('ctl-section-switch'); tog.input.setAttribute('aria-label', title + ' on/off'); head.appendChild(tog.el); }
    d.appendChild(head);
    var body = el('div', 'ctl-section-body');
    body.id = id; body.hidden = true;
    (children || []).forEach(function (c) { if (c) body.appendChild(c.el || c); });
    d.appendChild(body);
    var touched = false;
    function setOpen(o) { body.hidden = !o; btn.setAttribute('aria-expanded', String(o)); d.classList.toggle('open', o); }
    btn.addEventListener('click', function () { touched = true; setOpen(body.hidden); });
    function sync() { var on = !tog || tog.get(); body.classList.toggle('off', !on); if (on && tog && !touched) setOpen(true); }
    if (tog) tog.input.addEventListener('change', sync);
    sync();
    return { el: d, sync: sync };
  }

  // group(legend, [controls or elements]) → <fieldset>
  function group(legend, children) {
    var fs = el('fieldset', 'ctl-group');
    fs.appendChild(el('legend', '', legend));
    (children || []).forEach(function (c) { if (c) fs.appendChild(c.el || c); });
    return fs;
  }

  // ---------- URL hash state ----------
  // Values are coerced to the type of the matching default (number, boolean, string).
  function encodeHash(state) {
    return Object.keys(state).map(function (k) {
      var v = state[k];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (typeof v === 'number') v = +v.toPrecision(6);
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
  }

  function decodeHash(hash, defaults) {
    var out = Object.assign({}, defaults);
    String(hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('='), k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      var raw = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1));
      if (!(k in defaults)) return;
      var d = defaults[k];
      if (typeof d === 'number') { var n = parseFloat(raw); if (isFinite(n)) out[k] = n; }
      else if (typeof d === 'boolean') out[k] = raw === '1' || raw === 'true';
      else out[k] = raw;
    });
    return out;
  }

  function writeHash(state) {
    var h = '#' + encodeHash(state);
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
  }

  function readHash(defaults) { return decodeHash(location.hash, defaults); }

  function stateOf(controls) {
    var s = {};
    controls.forEach(function (c) { if (c.key) s[c.key] = c.get(); });
    return s;
  }

  function applyState(controls, state) {
    controls.forEach(function (c) { if (c.key && c.key in state) c.set(state[c.key], true); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    var ta = el('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }

  // ---------- status bar ----------
  function statusBar(container) {
    var bar = el('div', 'status');
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    if (container) container.appendChild(bar);
    return {
      el: bar,
      set: function (msg, kind) { bar.textContent = msg; bar.className = 'status' + (kind ? ' ' + kind : ''); }
    };
  }

  SDR.ui = {
    debounce: debounce, throttle: throttle, live: live, runChunked: runChunked, text: text,
    slider: slider, number: number, select: select, toggle: toggle, button: button, fileInput: fileInput, group: group, section: section,
    encodeHash: encodeHash, decodeHash: decodeHash, readHash: readHash, writeHash: writeHash,
    stateOf: stateOf, applyState: applyState, copyText: copyText, statusBar: statusBar
  };
})();
