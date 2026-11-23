// Landing-page thumbnails, drawn with the plot library from a few lines of synthetic data.
(function () {
  'use strict';
  var P = SDR.plot.createPlot, PAL = SDR.plot.PALETTE, base = { legend: false, grid: false, height: 150 }, i;
  function thumb(id, opts) { return P(document.getElementById(id), Object.assign({}, base, opts)); }

  // AM: a carrier under a 1 + 0.8·cos envelope
  var t = [], am = [], env = [], nenv = [];
  for (i = 0; i <= 400; i++) {
    var x = i / 400, e = 1 + 0.8 * Math.cos(2 * Math.PI * 2 * x);
    t.push(x); env.push(e); nenv.push(-e); am.push(e * Math.cos(2 * Math.PI * 30 * x));
  }
  thumb('th-am', { yLim: [-2, 2] }).setData([{ type: 'line', x: t, y: am, lineWidth: 1, color: PAL[0] },
    { type: 'line', x: t, y: env, lineWidth: 1.6, color: PAL[1] }, { type: 'line', x: t, y: nenv, lineWidth: 1.6, color: PAL[1] }]);

  // FM: Bessel line spectrum for β = 2.4 (carrier near its null)
  var fx = [], fy = [], st = { x: [], y: [] };
  for (var k = -8; k <= 8; k++) {
    var p = 10 * Math.log10(Math.pow(SDR.mathx.besselJ(k, 2.4), 2) + 1e-6);
    fx.push(k); fy.push(p); st.x.push(k, k, NaN); st.y.push(-60, p, NaN);
  }
  thumb('th-fm', { yLim: [-60, 0] }).setData([{ type: 'line', x: st.x, y: st.y, color: PAL[2], lineWidth: 1.5 }, { type: 'scatter', x: fx, y: fy, radius: 3, color: PAL[2] }]);

  // QPSK: a noisy constellation
  var rng = SDR.rng.createRng(7), qx = [], qy = [], A = Math.SQRT1_2;
  for (i = 0; i < 800; i++) { qx.push((rng.uniform() < 0.5 ? -A : A) + 0.12 * rng.randn()); qy.push((rng.uniform() < 0.5 ? -A : A) + 0.12 * rng.randn()); }
  thumb('th-qpsk', { equalAspect: true, xLim: [-1.4, 1.4], yLim: [-1.4, 1.4] }).setData([{ type: 'scatter', x: qx, y: qy, radius: 1.5, alpha: 0.7, color: PAL[4] }]);

  // BER: AWGN vs Rayleigh theory
  var eb = [], aw = [], ry = [];
  for (var d = 0; d <= 30; d += 0.5) { eb.push(d); aw.push(SDR.theory.qpskAwgn(d)); ry.push(SDR.theory.qpskRayleigh(d)); }
  thumb('th-ber', { yScale: 'log', yLim: [1e-6, 0.5] }).setData([{ type: 'line', x: eb, y: aw, color: PAL[0], lineWidth: 2 }, { type: 'line', x: eb, y: ry, color: PAL[3], lineWidth: 2 }]);
})();
