# sdr-web

A software-defined radio simulator that runs entirely in the browser: AM, FM and QPSK
modulators/demodulators, a channel model with noise and impairments, and Monte Carlo BER curves.

**Status:** Phase 0 (foundations) and Phase 1 (interactive AM page) are done. FM, QPSK and BER are next.

## No install

Plain HTML, CSS and vanilla JavaScript. No Node, npm, bundler, framework, CDN or external library.

**To open it, double-click `index.html`.** It runs from `file://`. To check the core code, open
`tests.html`: the banner at the top should read `PASS n / n`, and the demo plots below it are for
checking by eye.

Because it has to run from `file://`:
- scripts are classic `<script src>` tags in dependency order (no `type="module"`)
- no Web Workers and no `fetch()` of local files
- every file attaches to one global: `window.SDR = window.SDR || {}; SDR.fft = {...}`

## Layout

```
index.html            landing page
am.html               AM simulator (interactive)
fm.html qpsk.html     placeholders (coming soon)
ber.html              placeholder (coming soon)
tests.html            test runner + plot demos
css/style.css         layout, light/dark theme via CSS variables
js/tests.js           tests and demos
js/core/                          pure DSP, no DOM (except plot.js)
  rng.js      SDR.rng      seeded PRNG: xoshiro128** (default) or 'mulberry32'; randn, randnComplex, randomBits
  complex.js  SDR.cx       complex-array arithmetic, power, rotate, mixFreq
  mathx.js    SDR.mathx    erfc, Q, dB conversions, nextPow2, linspace
  fft.js      SDR.fft      radix-2 fft/ifft (in place), fftshift
  dsp.js      SDR.dsp      convolve, upsample, decimate, windows, welchPSD
  filters.js  SDR.filters  Kaiser lowpass design, causal FIR (FFT overlap-add for long filters), DC blocker
  plot.js     SDR.plot     interactive Canvas 2D plots (the one DOM exception, see below)
js/channel.js SDR.channel  AWGN at a given CNR, carrier phase offset (to be expanded)
js/analog/am.js SDR.am     AM modulate, envelope/coherent demod, output-SNR measurement (no DOM)
js/audio.js   SDR.audio    Web Audio: load/decode/resample files, play/stop, volume
js/ui/controls.js SDR.ui   sliders, selects, toggles, buttons, file input, URL-hash state, status bar
js/ui/am-page.js           wiring for am.html
```

Script order: `rng, complex, mathx, fft, dsp, filters, plot`, then `channel`, `analog/*`, `audio`, `ui/controls`,
and finally the page script.

### plot.js is the one DOM exception in js/core/

Everything else in `js/core/` is pure computation. `plot.js` lives there because every page needs it,
but drawing and mouse/touch interaction are its whole job, so it creates canvases, a tooltip and a toolbar.

Plot controls: hover for a crosshair and values · wheel to zoom (Shift = x only, Alt = y only) · left-drag to pan ·
right-drag or Ctrl+drag to box-zoom · double-click or ⟲ to reset · click a legend entry to show/hide it ·
toolbar (top right) for reset, PNG and CSV of the visible range · touch: one-finger pan, pinch zoom.
`setData()` keeps the user's zoom, so live updates don't snap the view back.

## Using the AM page

Pick a message (tone, two-tone, chirp, or your own audio file), set the AM type and μ, the channel
(noise, CNR, phase offset, seed) and the detector. The plots and readouts update while you drag. During
a drag they show a short 0.25 s preview, and the full 2 s run happens when you release. The URL hash
always holds the current setup, so "Copy link" gives a link that restores it. "Compute SNR curve" sweeps
CNR from −5 to 40 dB with both detectors.

**CNR definition:** carrier power (DSB-LC, which is 1) or total signal power (DSB-SC), divided by the
noise power inside 2W, where W is the audio bandwidth slider. Under this definition, ideal coherent
detection gives an output SNR of CNR + 10·log10(2·Pc / Pref), where Pc is the message power
(μ²·Pm for DSB-LC, Pm for DSB-SC). The "ideal" readout and the dashed line both come from that formula.

## Conventions

- **Complex signals** are `{ re: Float64Array, im: Float64Array }` of equal length.
- **Randomness** always comes from an `rng` object (`SDR.rng.createRng(seed)`) passed in by the caller,
  so every run can be reproduced from its seed. Never call `Math.random()` in sim code.
- **Sim code in `js/core/` never touches the DOM.** It is made of pure functions. `plot.js` is the one
  exception, since drawing is its job.
- Use typed arrays and avoid allocating inside hot loops.
- dB helpers: `db2lin`/`lin2db` work on **amplitude** (20·log10) and `db2pow`/`pow2db` on **power** (10·log10).
- `welchPSD` returns a centred spectrum (−fs/2 … fs/2), scaled so that a complex tone of power P peaks
  at 10·log10(P) dB. Noise therefore reads as power per bin, not per Hz.
- `convolve(x, h, 'same')` uses the numpy alignment (offset `floor((len(h)−1)/2)`).
