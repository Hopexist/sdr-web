// SDR.plot — interactive Canvas 2D plotting.
// NOTE: the one file in js/core/ that touches the DOM (drawing and interaction are its whole job).
//
//   const p = SDR.plot.createPlot(canvas, { title, xLabel, yLabel, xUnit, yUnit, xLim, yLim,
//                                           yScale: 'linear' | 'log', equalAspect, annotations });
//   p.setData([{ type: 'line', x, y, label }, { type: 'scatter', ... }, { type: 'errorbar', x, y, yLow, yHigh }]);
//
// Interaction: hover = crosshair + tooltip; wheel = zoom (Shift: x only, Alt: y only);
// left-drag = pan; right-drag or Ctrl+drag = box zoom; double-click or ⟲ = reset;
// click a legend entry = show/hide; touch: one-finger pan, pinch zoom.
// setData() keeps the user's zoom; until they zoom, the view follows the data (or xLim/yLim).
//
// Annotations (drawn in data coordinates):
//   { type: 'band', x0, x1, label, color }   shaded x-interval
//   { type: 'text', x, y, text, color }      label (y omitted → top of plot)
//   { type: 'vline', x, label, color }
//   { type: 'hline', y, label, color, dash }
// Series options: color, label, lineWidth, dash (lines), radius (points), alpha (lines and points).
(function () {
  'use strict';
  var SDR = (window.SDR = window.SDR || {});

  // Mid-luminance hues: readable on both white and near-black backgrounds.
  var PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
  var MAX_POINTS = 4000;
  var MONO = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  var SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  var SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

  // ---------- formatting ----------
  function niceStep(span, target) {
    var raw = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  function linearTicks(lo, hi, target) {
    var step = niceStep(hi - lo, target), ticks = [], eps = step * 1e-9;
    for (var v = Math.ceil((lo - eps) / step) * step; v <= hi + eps; v += step) ticks.push(Math.abs(v) < eps ? 0 : v);
    return { ticks: ticks, step: step };
  }

  function fmtLinear(v, step) {
    var a = Math.abs(v);
    if (v !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(Math.max(0, Math.min(3, Math.round(-Math.log10(step / a)))));
    return v.toFixed(Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  }

  function fmtPow10(e) { return '10' + String(e).split('').map(function (c) { return SUP[c]; }).join(''); }

  // Tooltip value: ~3–4 significant digits relative to the visible span.
  function fmtValue(v, span, log, unit) {
    var s;
    if (!isFinite(v)) s = String(v);
    else if (log) s = v.toExponential(1);
    else {
      var a = Math.abs(v);
      if (v !== 0 && (a >= 1e6 || a < 1e-4)) s = v.toExponential(3);
      else s = v.toFixed(Math.max(0, Math.min(8, -Math.floor(Math.log10(span / 1000 || 1)))));
    }
    return unit ? s + ' ' + unit : s;
  }

  // ---------- data helpers ----------
  function getX(s, i) { return s.x ? s.x[i] : i; }

  var sortedCache = new WeakMap();
  function isSorted(s) {
    if (!s.x) return true;
    var c = sortedCache.get(s.x);
    if (c !== undefined) return c;
    var ok = true;
    for (var i = 1; i < s.x.length; i++) if (s.x[i] < s.x[i - 1]) { ok = false; break; }
    sortedCache.set(s.x, ok);
    return ok;
  }

  // First index with x >= v (sorted series only).
  function lowerBound(s, v) {
    var lo = 0, hi = s.y.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (getX(s, mid) < v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function dataRange(series, axis, positiveOnly) {
    var lo = Infinity, hi = -Infinity;
    function take(v) {
      if (!isFinite(v) || (positiveOnly && v <= 0)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    series.forEach(function (s) {
      for (var i = 0, n = s.y.length; i < n; i++) {
        if (axis === 'x') take(getX(s, i));
        else { take(s.y[i]); if (s.yLow) take(s.yLow[i]); if (s.yHigh) take(s.yHigh[i]); }
      }
    });
    return lo <= hi ? [lo, hi] : null;
  }

  // Indices to draw within [x0, x1]: all, a stride (scatter), or per-bucket min+max (line, keeps spikes).
  function drawIndices(s, x0, x1) {
    var n = s.y.length, i0 = 0, i1 = n, idx = [], i, sorted = isSorted(s);
    if (sorted) { i0 = Math.max(0, lowerBound(s, x0) - 1); i1 = Math.min(n, lowerBound(s, x1) + 1); }
    var count = i1 - i0;
    if (count <= MAX_POINTS) { for (i = i0; i < i1; i++) idx.push(i); return idx; }
    if (s.type !== 'line' || !sorted) {
      var stride = Math.ceil(count / MAX_POINTS);
      for (i = i0; i < i1; i += stride) idx.push(i);
      return idx;
    }
    var bucket = Math.ceil(count / (MAX_POINTS / 2));
    for (var b = i0; b < i1; b += bucket) {
      var iMin = b, iMax = b, end = Math.min(i1, b + bucket);
      for (i = b; i < end; i++) {
        if (s.y[i] < s.y[iMin]) iMin = i;
        if (s.y[i] > s.y[iMax]) iMax = i;
      }
      idx.push(Math.min(iMin, iMax));
      if (iMin !== iMax) idx.push(Math.max(iMin, iMax));
    }
    return idx;
  }

  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) { return cs.getPropertyValue(name).trim() || fb; }
    return {
      bg: v('--plot-bg', '#ffffff'), fg: v('--plot-fg', '#222222'), axis: v('--plot-axis', '#888888'),
      grid: v('--plot-grid', '#e2e2e2'), gridMinor: v('--plot-grid-minor', '#f0f0f0'),
      band: v('--plot-band', 'rgba(59,130,246,0.10)')
    };
  }

  function sizeCanvas(c, W, H, dpr) {
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function downloadURL(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- plot ----------
  function createPlot(canvas, options) {
    var ctx = canvas.getContext('2d');
    var opts = Object.assign({ grid: true, legend: true, yScale: 'linear' }, options || {});
    var series = [];
    var hidden = new Set();   // keys of hidden series (label or index)
    var view = null;          // user view in data units {x0,x1,y0,y1}; null = follow data/home
    var L = null;             // last layout, used by interaction
    var drawn = [];           // per visible series: drawn indices (for scatter hover)
    var legendBoxes = [];

    if (!canvas.style.width) canvas.style.width = '100%';
    if (!canvas.style.height) canvas.style.height = (opts.height || 300) + 'px';

    // DOM: wrapper, overlay canvas (crosshair/box), tooltip, toolbar.
    var wrap = el('div', 'sdr-plot');
    if (canvas.parentNode) canvas.parentNode.insertBefore(wrap, canvas);
    wrap.appendChild(canvas);
    canvas.classList.add('sdr-plot-canvas');
    var overlay = el('canvas', 'sdr-plot-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    var octx = overlay.getContext('2d');
    var tip = el('div', 'sdr-plot-tip');
    tip.hidden = true;
    var tb = el('div', 'sdr-plot-tb');
    function tbButton(label, title, fn) {
      var b = el('button', '', label);
      b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      tb.appendChild(b);
    }
    tbButton('⟲', 'Reset view (double-click)', function () { api.resetView(); });
    tbButton('PNG', 'Save as PNG', function () { api.downloadPNG(); });
    tbButton('CSV', 'Export visible series as CSV', function () { api.downloadCSV(); });
    // Touch: by default vertical swipes scroll the page (touch-action: pan-y); the lock captures all gestures.
    var locked = false;
    if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) {
      tbButton('🔓', 'Lock: capture all touch gestures on this plot (pan in both directions)', function () {
        locked = !locked;
        canvas.classList.toggle('touch-locked', locked);
        this.textContent = locked ? '🔒' : '🔓';
        this.setAttribute('aria-pressed', String(locked));
      });
    }
    wrap.appendChild(overlay); wrap.appendChild(tip); wrap.appendChild(tb);
    if (opts.title) canvas.setAttribute('aria-label', opts.title);
    canvas.setAttribute('role', 'img');

    function keyOf(s, i) { return s.label || '#' + i; }
    function visibleSeries() { return series.filter(function (s, i) { return !hidden.has(keyOf(s, i)); }); }
    function colorOf(s) { return s.color || PALETTE[series.indexOf(s) % PALETTE.length]; }

    function homeView(vis) {
      var logY = opts.yScale === 'log';
      var xr = opts.xLim || dataRange(vis, 'x', false) || [0, 1];
      var x0 = xr[0], x1 = xr[1];
      if (x0 === x1) { x0 -= 1; x1 += 1; }
      var y0, y1, yr;
      if (logY) {
        yr = opts.yLim || dataRange(vis, 'y', true) || [1e-6, 1];
        y0 = yr[0]; y1 = yr[1];
        if (!opts.yLim) {
          var e0 = Math.floor(Math.log10(y0)), e1 = Math.ceil(Math.log10(y1));
          if (e0 === e1) e1++;
          y0 = Math.pow(10, e0); y1 = Math.pow(10, e1);
        }
      } else {
        yr = opts.yLim || dataRange(vis, 'y', false) || [0, 1];
        y0 = yr[0]; y1 = yr[1];
        if (y0 === y1) { var d = Math.abs(y0) * 0.1 || 1; y0 -= d; y1 += d; }
        if (!opts.yLim) {
          var st = niceStep(y1 - y0, 6);
          y0 = Math.floor(y0 / st + 1e-9) * st; y1 = Math.ceil(y1 / st - 1e-9) * st;
        }
      }
      return { x0: x0, x1: x1, y0: y0, y1: y1 };
    }

    function draw() {
      raf = 0;
      var dpr = window.devicePixelRatio || 1;
      var rect = canvas.getBoundingClientRect();
      var W = rect.width || opts.width || 600, H = rect.height || opts.height || 300;
      sizeCanvas(canvas, W, H, dpr);
      sizeCanvas(overlay, W, H, dpr);
      overlay.style.width = W + 'px';
      overlay.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var th = readTheme();
      ctx.fillStyle = th.bg;
      ctx.fillRect(0, 0, W, H);

      var logY = opts.yScale === 'log';
      var T = logY ? Math.log10 : function (v) { return v; };
      var mL = opts.yLabel ? 72 : 58, mR = 16, mT = opts.title ? 32 : 12, mB = opts.xLabel ? 46 : 28;
      var pl = mL, pt = mT, pW = W - mL - mR, pH = H - mT - mB;
      if (pW < 20 || pH < 20) return;

      var vis = visibleSeries();
      var v = view || homeView(vis);
      var x0 = v.x0, x1 = v.x1, ty0 = T(v.y0), ty1 = T(v.y1);
      if (opts.equalAspect && !logY) {
        var u = Math.max((x1 - x0) / pW, (ty1 - ty0) / pH), cx = (x0 + x1) / 2, cy = (ty0 + ty1) / 2;
        x0 = cx - (u * pW) / 2; x1 = cx + (u * pW) / 2;
        ty0 = cy - (u * pH) / 2; ty1 = cy + (u * pH) / 2;
      }
      var y0 = logY ? Math.pow(10, ty0) : ty0, y1 = logY ? Math.pow(10, ty1) : ty1;
      L = { pl: pl, pt: pt, pW: pW, pH: pH, x0: x0, x1: x1, ty0: ty0, ty1: ty1, logY: logY, W: W, H: H };

      function sx(val) { return pl + ((val - x0) / (x1 - x0)) * pW; }
      function sy(val) { return pt + (1 - (T(val) - ty0) / (ty1 - ty0)) * pH; }
      L.sx = sx; L.sy = sy;

      // ticks
      var xt = linearTicks(x0, x1, Math.max(2, Math.floor(pW / 80)));
      var yMajor = [], yMinor = [], yLabels = [];
      if (logY) {
        var ea = Math.ceil(ty0 - 1e-9), eb = Math.floor(ty1 + 1e-9), nd = eb - ea + 1;
        if (nd >= 2) {
          var every = Math.max(1, Math.ceil(nd / Math.max(2, Math.floor(pH / 28))));
          for (var e = ea; e <= eb; e++) if ((e - ea) % every === 0) { yMajor.push(Math.pow(10, e)); yLabels.push(fmtPow10(e)); }
        } else { // zoomed inside a decade: linear ticks, exponent labels
          var lt = linearTicks(y0, y1, Math.max(2, Math.floor(pH / 45)));
          yMajor = lt.ticks.filter(function (t) { return t > 0; });
          yLabels = yMajor.map(function (t) { return t.toExponential(1); });
        }
        if (nd <= 12) {
          for (e = Math.floor(ty0); e <= eb; e++) {
            for (var m = 2; m <= 9; m++) { var mv = m * Math.pow(10, e); if (mv > y0 && mv < y1) yMinor.push(mv); }
          }
        }
      } else {
        var yt = linearTicks(y0, y1, Math.max(2, Math.floor(pH / 45)));
        yMajor = yt.ticks;
        yLabels = yt.ticks.map(function (t) { return fmtLinear(t, yt.step); });
      }

      // grid
      ctx.lineWidth = 1;
      function hline(val, color) { var py = Math.round(sy(val)) + 0.5; ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(pl, py); ctx.lineTo(pl + pW, py); ctx.stroke(); }
      function vline(val, color) { var px = Math.round(sx(val)) + 0.5; ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(px, pt); ctx.lineTo(px, pt + pH); ctx.stroke(); }
      if (opts.grid) {
        yMinor.forEach(function (t) { hline(t, th.gridMinor); });
        yMajor.forEach(function (t) { hline(t, th.grid); });
        xt.ticks.forEach(function (t) { vline(t, th.grid); });
      }

      var ann = opts.annotations || [];
      ctx.save();
      ctx.beginPath(); ctx.rect(pl, pt, pW, pH); ctx.clip();
      ann.forEach(function (a) {
        if (a.type !== 'band') return;
        ctx.fillStyle = a.color || th.band;
        var bx0 = sx(a.x0), bx1 = sx(a.x1);
        ctx.fillRect(bx0, pt, bx1 - bx0, pH);
      });
      ctx.restore();

      ctx.strokeStyle = th.axis;
      ctx.strokeRect(pl + 0.5, pt + 0.5, pW - 1, pH - 1);

      // tick labels
      ctx.fillStyle = th.fg;
      ctx.font = MONO;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      xt.ticks.forEach(function (t) { ctx.fillText(fmtLinear(t, xt.step), sx(t), pt + pH + 5); });
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      yMajor.forEach(function (t, i) { ctx.fillText(yLabels[i], pl - 6, sy(t)); });

      // titles
      ctx.textAlign = 'center';
      if (opts.title) {
        ctx.font = '600 13px ' + SANS; ctx.textBaseline = 'top';
        // Title must clear the toolbar (top-right): centered if it fits, else left-aligned and ellipsized.
        var tbw = (tb.offsetWidth || 0) + 10, title = opts.title, tx = W / 2;
        if (ctx.measureText(title).width > W - 2 * tbw) {
          ctx.textAlign = 'left'; tx = 8;
          while (title.length > 4 && ctx.measureText(title).width > W - tbw - 16) title = title.slice(0, -2) + '…';
        }
        ctx.fillText(title, tx, 9);
        ctx.textAlign = 'center';
      }
      ctx.font = '12px ' + SANS;
      if (opts.xLabel) { ctx.textBaseline = 'bottom'; ctx.fillText(opts.xLabel, pl + pW / 2, H - 4); }
      if (opts.yLabel) {
        ctx.save(); ctx.translate(14, pt + pH / 2); ctx.rotate(-Math.PI / 2);
        ctx.textBaseline = 'middle'; ctx.fillText(opts.yLabel, 0, 0); ctx.restore();
      }

      // series
      ctx.save();
      ctx.beginPath(); ctx.rect(pl, pt, pW, pH); ctx.clip();
      drawn = [];
      function ok(yv) { return isFinite(yv) && (!logY || yv > 0); }
      vis.forEach(function (s) {
        var color = colorOf(s), idx = drawIndices(s, x0, x1);
        drawn.push({ s: s, idx: idx });
        ctx.strokeStyle = color; ctx.fillStyle = color;
        if (s.type === 'line' || !s.type) {
          ctx.lineWidth = s.lineWidth || 1.5; ctx.lineJoin = 'round';
          if (s.dash) ctx.setLineDash(s.dash);
          if (s.alpha) ctx.globalAlpha = s.alpha;
          ctx.beginPath();
          var pen = false;
          for (var k = 0; k < idx.length; k++) {
            var i = idx[k], xv = getX(s, i), yv = s.y[i];
            if (!isFinite(xv) || !ok(yv)) { pen = false; continue; }
            if (pen) ctx.lineTo(sx(xv), sy(yv)); else ctx.moveTo(sx(xv), sy(yv));
            pen = true;
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          return;
        }
        var r = s.radius || 2.5;
        if (s.type === 'errorbar') {
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          idx.forEach(function (i) {
            var lo = s.yLow[i], hi = s.yHigh[i];
            if (!ok(lo) || !ok(hi)) return;
            var px = sx(getX(s, i)), a = sy(lo), b = sy(hi);
            ctx.moveTo(px, a); ctx.lineTo(px, b);
            ctx.moveTo(px - 4, a); ctx.lineTo(px + 4, a);
            ctx.moveTo(px - 4, b); ctx.lineTo(px + 4, b);
          });
          ctx.stroke();
          r = s.radius || 3;
        }
        if (s.alpha) ctx.globalAlpha = s.alpha;
        ctx.beginPath();
        idx.forEach(function (i) {
          var xv = getX(s, i), yv = s.y[i];
          if (!isFinite(xv) || !ok(yv)) return;
          var px = sx(xv), py = sy(yv);
          ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 2 * Math.PI);
        });
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      // text / vline annotations
      ctx.font = '12px ' + SANS;
      ann.forEach(function (a) {
        if (a.type === 'band' && a.label) {
          ctx.fillStyle = th.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(a.label, (sx(a.x0) + sx(a.x1)) / 2, pt + pH - 4);
        } else if (a.type === 'vline') {
          var px = Math.round(sx(a.x)) + 0.5;
          ctx.strokeStyle = a.color || th.axis; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px, pt); ctx.lineTo(px, pt + pH); ctx.stroke(); ctx.setLineDash([]);
          if (a.label) { ctx.fillStyle = th.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(a.label, px + 4, pt + 4); }
        } else if (a.type === 'hline') {
          if (!ok(a.y)) return;
          var py = Math.round(sy(a.y)) + 0.5;
          ctx.strokeStyle = a.color || th.axis; ctx.setLineDash(a.dash || [4, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(pl, py); ctx.lineTo(pl + pW, py); ctx.stroke(); ctx.setLineDash([]);
          if (a.label) { ctx.fillStyle = th.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(a.label, pl + 4, py - 2); }
        } else if (a.type === 'text') {
          var ty = a.y === undefined || !ok(a.y) ? pt + 6 : sy(a.y) - 4;
          ctx.fillStyle = a.color || th.fg; ctx.textAlign = 'center'; ctx.textBaseline = a.y === undefined ? 'top' : 'bottom';
          ctx.fillText(a.text, sx(a.x), Math.max(pt + 12, ty));
        }
      });
      ctx.restore();

      // legend (all labelled series; hidden ones greyed)
      legendBoxes = [];
      var labeled = series.map(function (s, i) { return { s: s, k: keyOf(s, i) }; }).filter(function (e) { return e.s.label; });
      if (opts.legend && labeled.length) {
        ctx.font = '12px ' + SANS;
        var lw = 0;
        labeled.forEach(function (e) { lw = Math.max(lw, ctx.measureText(e.s.label).width); });
        var bw = lw + 38, bh = labeled.length * 18 + 8, bx = pl + pW - bw - 8, by = pt + 8;
        ctx.globalAlpha = 0.88; ctx.fillStyle = th.bg; ctx.fillRect(bx, by, bw, bh); ctx.globalAlpha = 1;
        ctx.strokeStyle = th.grid; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        labeled.forEach(function (e, i) {
          var yy = by + 13 + i * 18, c = colorOf(e.s), off = hidden.has(e.k);
          ctx.globalAlpha = off ? 0.35 : 1;
          ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 2;
          if (e.s.type === 'line' || !e.s.type) { ctx.beginPath(); ctx.moveTo(bx + 8, yy); ctx.lineTo(bx + 26, yy); ctx.stroke(); }
          else { ctx.beginPath(); ctx.arc(bx + 17, yy, 3.5, 0, 2 * Math.PI); ctx.fill(); }
          ctx.fillStyle = th.fg; ctx.fillText(e.s.label, bx + 32, yy);
          ctx.globalAlpha = 1;
          legendBoxes.push({ k: e.k, x: bx, y: yy - 9, w: bw, h: 18 });
        });
      }
      if (hoverPos) drawHover(hoverPos.x, hoverPos.y);
    }

    // ---------- interaction ----------
    var raf = 0;
    function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

    function toData(px, py) {
      return { x: L.x0 + ((px - L.pl) / L.pW) * (L.x1 - L.x0), ty: L.ty0 + (1 - (py - L.pt) / L.pH) * (L.ty1 - L.ty0) };
    }
    function setViewT(x0, x1, ty0, ty1) {
      if (!(x1 > x0) || !(ty1 > ty0) || !isFinite(x0 + x1 + ty0 + ty1)) return;
      var inv = L.logY ? function (t) { return Math.pow(10, t); } : function (t) { return t; };
      view = { x0: x0, x1: x1, y0: inv(ty0), y1: inv(ty1) };
      schedule();
    }
    function zoomAt(px, py, fx, fy) {
      var c = toData(px, py);
      setViewT(c.x + (L.x0 - c.x) * fx, c.x + (L.x1 - c.x) * fx, c.ty + (L.ty0 - c.ty) * fy, c.ty + (L.ty1 - c.ty) * fy);
    }
    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function inPlot(p) { return L && p.x >= L.pl && p.x <= L.pl + L.pW && p.y >= L.pt && p.y <= L.pt + L.pH; }

    var hoverPos = null;
    function clearOverlay() { if (L) octx.clearRect(0, 0, L.W, L.H); }

    function drawHover(px, py) {
      clearOverlay();
      if (!L || !inPlot({ x: px, y: py })) { tip.hidden = true; return; }
      var th = readTheme();
      octx.strokeStyle = th.axis; octx.lineWidth = 1; octx.setLineDash([3, 3]);
      octx.beginPath();
      octx.moveTo(Math.round(px) + 0.5, L.pt); octx.lineTo(Math.round(px) + 0.5, L.pt + L.pH);
      octx.moveTo(L.pl, Math.round(py) + 0.5); octx.lineTo(L.pl + L.pW, Math.round(py) + 0.5);
      octx.stroke(); octx.setLineDash([]);

      var c = toData(px, py), rows = [];
      drawn.forEach(function (d) {
        var s = d.s, best = -1;
        if (isSorted(s) && (s.type === 'line' || !s.type || s.type === 'errorbar')) {
          var i = lowerBound(s, c.x);
          [i - 1, i].forEach(function (j) {
            if (j >= 0 && j < s.y.length && (best < 0 || Math.abs(getX(s, j) - c.x) < Math.abs(getX(s, best) - c.x))) best = j;
          });
        } else {
          var bd = Infinity;
          d.idx.forEach(function (j) {
            var dx = L.sx(getX(s, j)) - px, dy = L.sy(s.y[j]) - py, dd = dx * dx + dy * dy;
            if (dd < bd) { bd = dd; best = j; }
          });
        }
        if (best < 0 || !isFinite(s.y[best]) || (L.logY && s.y[best] <= 0)) return;
        var bx = getX(s, best), by = s.y[best];
        octx.fillStyle = colorOf(s);
        octx.beginPath(); octx.arc(L.sx(bx), L.sy(by), 3.5, 0, 2 * Math.PI); octx.fill();
        rows.push({ c: colorOf(s), label: s.label || 'series', x: bx, y: by });
      });

      tip.textContent = '';
      var xs = L.x1 - L.x0, ys = L.logY ? 0 : L.ty1 - L.ty0;
      rows.forEach(function (r) {
        var line = el('div');
        var sw = el('span', 'sw'); sw.style.background = r.c;
        line.appendChild(sw);
        line.appendChild(document.createTextNode(r.label + ': ' + fmtValue(r.x, xs, false, opts.xUnit) + ', ' + fmtValue(r.y, ys, L.logY, opts.yUnit)));
        tip.appendChild(line);
      });
      tip.hidden = !rows.length;
      if (rows.length) {
        var tw = tip.offsetWidth, thh = tip.offsetHeight;
        tip.style.left = (px + 14 + tw > L.W ? px - 14 - tw : px + 14) + 'px';
        tip.style.top = Math.min(Math.max(py + 14, 0), L.H - thh) + 'px';
      }
    }

    var drag = null;            // mouse/pen: {mode:'pan'|'box', start, L snapshot}
    var touches = new Map();    // pointerId → pos
    var gesture = null;

    function snapshot() { return { x0: L.x0, x1: L.x1, ty0: L.ty0, ty1: L.ty1 }; }

    function startGesture() {
      var pts = Array.from(touches.values());
      if (!pts.length) { gesture = null; return; }
      var mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
      var dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
      gesture = { v: snapshot(), mid: mid, dist: dist, c: toData(mid.x, mid.y) };
    }

    function moveGesture() {
      var pts = Array.from(touches.values()), g = gesture;
      if (!g || !L) return;
      var mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
      var scale = pts.length > 1 && g.dist > 0 ? g.dist / Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) : 1;
      var spx = (g.v.x1 - g.v.x0) * scale, spy = (g.v.ty1 - g.v.ty0) * scale;
      var nx0 = g.c.x - ((mid.x - L.pl) / L.pW) * spx;
      var nty0 = g.c.ty - (1 - (mid.y - L.pt) / L.pH) * spy;
      if (pts.length === 1 && !locked) nty0 = g.v.ty0; // unlocked one-finger drag pans x only; vertical belongs to page scroll
      setViewT(nx0, nx0 + spx, nty0, nty0 + spy);
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (!L) return;
      var p = pos(e);
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, p);
        canvas.setPointerCapture(e.pointerId);
        startGesture();
        return;
      }
      var mode = e.button === 2 || (e.button === 0 && e.ctrlKey) ? 'box' : e.button === 0 ? 'pan' : null;
      if (!mode) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drag = { mode: mode, start: p, v: snapshot(), moved: false };
    });

    canvas.addEventListener('pointermove', function (e) {
      var p = pos(e);
      if (e.pointerType === 'touch') {
        if (touches.has(e.pointerId)) { touches.set(e.pointerId, p); moveGesture(); }
        return;
      }
      if (!drag) { hoverPos = p; drawHover(p.x, p.y); return; }
      var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.mode === 'pan') {
        var v = drag.v, sxp = (dx / L.pW) * (v.x1 - v.x0), syp = (dy / L.pH) * (v.ty1 - v.ty0);
        setViewT(v.x0 - sxp, v.x1 - sxp, v.ty0 + syp, v.ty1 + syp);
      } else {
        clearOverlay();
        tip.hidden = true;
        var th = readTheme();
        octx.strokeStyle = th.fg; octx.fillStyle = th.band; octx.lineWidth = 1; octx.setLineDash([4, 3]);
        octx.fillRect(drag.start.x, drag.start.y, dx, dy);
        octx.strokeRect(drag.start.x + 0.5, drag.start.y + 0.5, dx, dy);
        octx.setLineDash([]);
      }
    });

    function endPointer(e) {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        startGesture();
        return;
      }
      if (!drag) return;
      var d = drag, p = pos(e);
      drag = null;
      if (d.mode === 'box' && d.moved) {
        var a = toData(Math.min(d.start.x, p.x), Math.max(d.start.y, p.y));
        var b = toData(Math.max(d.start.x, p.x), Math.min(d.start.y, p.y));
        if (Math.abs(p.x - d.start.x) > 4 && Math.abs(p.y - d.start.y) > 4) setViewT(a.x, b.x, a.ty, b.ty);
        clearOverlay();
      } else if (d.mode === 'pan' && !d.moved) {
        legendBoxes.forEach(function (lb) {
          if (p.x >= lb.x && p.x <= lb.x + lb.w && p.y >= lb.y && p.y <= lb.y + lb.h) {
            if (hidden.has(lb.k)) hidden.delete(lb.k); else hidden.add(lb.k);
            schedule();
          }
        });
      }
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'touch' || drag) return;
      hoverPos = null; tip.hidden = true; clearOverlay();
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('dblclick', function () { api.resetView(); });
    canvas.addEventListener('wheel', function (e) {
      if (!L) return;
      var p = pos(e);
      if (!inPlot(p)) return;
      e.preventDefault();
      var d = e.deltaY || e.deltaX; // Shift+wheel arrives as deltaX in some browsers
      var f = Math.exp(Math.max(-200, Math.min(200, d)) * 0.0015);
      zoomAt(p.x, p.y, e.altKey ? 1 : f, e.shiftKey ? 1 : f);
    }, { passive: false });

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro) ro.observe(canvas); else window.addEventListener('resize', schedule);
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', schedule);

    function slug() { return (opts.title || 'plot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plot'; }
    function csvField(v) { var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

    var api = {
      setData: function (arr) { series = arr.slice(); schedule(); return api; },
      setSeries: function (arr) { return api.setData(arr); },
      addSeries: function (s) { series.push(s); schedule(); return api; },
      setOptions: function (o) { Object.assign(opts, o); schedule(); return api; },
      resetView: function () { view = null; schedule(); return api; },
      getView: function () { return view && Object.assign({}, view); },
      setView: function (v) { view = v ? Object.assign({}, v) : null; schedule(); return api; },
      isZoomed: function () { return view !== null; },
      draw: draw,
      toPNG: function () { draw(); return canvas.toDataURL('image/png'); },
      downloadPNG: function (filename) { downloadURL(api.toPNG(), filename || slug() + '.png'); },
      // Visible series, points inside the current x-range.
      toCSV: function () {
        if (!L) draw();
        var vis = visibleSeries(), err = vis.some(function (s) { return s.yLow; });
        var lines = ['series,x,y' + (err ? ',yLow,yHigh' : '')];
        vis.forEach(function (s, si) {
          for (var i = 0; i < s.y.length; i++) {
            var xv = getX(s, i);
            if (L && (xv < L.x0 || xv > L.x1)) continue;
            var row = [csvField(s.label || 'series ' + (si + 1)), xv, s.y[i]];
            if (err) row.push(s.yLow ? s.yLow[i] : '', s.yHigh ? s.yHigh[i] : '');
            lines.push(row.join(','));
          }
        });
        return lines.join('\n') + '\n';
      },
      downloadCSV: function (filename) {
        var url = URL.createObjectURL(new Blob([api.toCSV()], { type: 'text/csv' }));
        downloadURL(url, filename || slug() + '.csv');
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      },
      element: wrap,
      destroy: function () {
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', schedule);
        if (mq && mq.removeEventListener) mq.removeEventListener('change', schedule);
      }
    };
    draw();
    return api;
  }

  SDR.plot = { createPlot: createPlot, downloadURL: downloadURL, downloadDataURL: downloadURL, PALETTE: PALETTE };
})();
