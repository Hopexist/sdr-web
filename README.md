# sdr-web

A software-defined radio simulator that runs entirely in the browser: AM, FM and QPSK
modulators/demodulators, a channel model with noise and impairments, and Monte Carlo BER curves.

**Status:** Phases 0–3 are done: foundations, AM, FM and the QPSK link. The BER page (Phase 5) and more channel impairments (Phase 4) are next.

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
fm.html               FM simulator (interactive)
qpsk.html             QPSK link simulator (interactive)
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
  filters.js  SDR.filters  RRC taps, windowed-sinc fractional delay / resample, Kaiser lowpass (memoized), causal FIR (FFT overlap-add), complex FIR, polyphase
                           interpolate / decimateFiltered, first-order bilinear sections, DC blocker
  plot.js     SDR.plot     interactive Canvas 2D plots (the one DOM exception, see below)
js/channel.js SDR.channel  AWGN at a given CNR, carrier phase offset (to be expanded)
js/analog/am.js SDR.am     AM modulate, envelope/coherent demod (no DOM)
js/analog/fm.js SDR.fm     FM transmit/receive chain, discriminator, PLL demod, emphasis, clicks, theory (no DOM)
js/digital/sync.js SDR.sync  PLL (pluggable detector), loop gains from BnT/ζ, Gardner + Farrow timing loop,
                           4th-power CFO estimator, lock detection
js/digital/mapping.js SDR.mapping  Gray QPSK map, hard/LLR demap, differential encode/decode
js/digital/sequences.js SDR.seq    LFSR m-sequences (degree 5–10), 64-symbol preamble
js/digital/qpsk.js SDR.qpsk  transmitter, receiver and runLink(cfg, rng): the whole link as one pure function
js/theory.js SDR.theory      QPSK BER (AWGN, static phase error, DE-QPSK), Wilson interval
js/audio.js   SDR.audio    Web Audio: load/decode/resample files, play/stop, volume
js/ui/controls.js SDR.ui   sliders, selects, toggles, text, buttons, file input, URL-hash state, status bar,
                           runChunked (time-budgeted generator runner for sweeps)
js/ui/page.js SDR.page     shared simulator-page scaffold (panel, readouts, plot cards, sources, sweeps, audio)
js/ui/am-page.js, fm-page.js, qpsk-page.js  wiring for each page
```

Script order: `rng, complex, mathx, fft, dsp, filters, plot`, then `channel`, `theory`, `digital/mapping, sequences, sync, qpsk`, `analog/*`, `audio`,
`ui/controls`, `ui/page`, and finally the page script.

### plot.js is the one DOM exception in js/core/

Everything else in `js/core/` is pure computation. `plot.js` lives there because every page needs it,
but drawing and mouse/touch interaction are its whole job, so it creates canvases, a tooltip and a toolbar.

Plot controls: hover for a crosshair and values · wheel to zoom (Shift = x only, Alt = y only) · left-drag to pan ·
right-drag or Ctrl+drag to box-zoom · double-click or ⟲ to reset · click a legend entry to show/hide it ·
toolbar (top right) for reset, PNG and CSV of the visible range · touch: vertical swipes scroll the page,
horizontal one-finger drag pans, pinch zooms; the 🔓 toolbar button captures all gestures for free panning.
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

## Using the FM page

Pick a preset (Narrowband, Broadcast, β = 1, β = 5) or set Δf and W yourself. The spectrum shows the
Carson band, the ±Δf lines and the IF filter edges; for a tone, "Show Bessel line heights" overlays the
theoretical J_n(β)². Lower the CNR toward 10 dB to watch the threshold: the click counter rises and spikes
appear on the instantaneous-frequency plot. "Compute SNR curve" sweeps CNR for the β values you list and
plots output SNR against the baseband SNR γ = C/(N0·W), with dashed theory lines, per-β threshold markers
and the AM (DSB-SC) reference.

Sample rates: audio fsA = 48 kHz; RF baseband fsR = 384 kHz (8×). **CNR on the FM page** is carrier power (1)
over the noise power inside the IF bandwidth B_T. Above threshold the output SNR is
3·Pm·(Δf/W)²·(B_T/W)·CNR, which for a tone with Carson B_T is the textbook 3β²(β+1)·CNR.

## Using the QPSK page

Start with a preset ("Ideal link", "Phase offset only", "CFO + timing", "Everything on", "Loop too wide", "Loop too narrow"),
then change one thing at a time. Each receiver stage (coarse CFO, timing, carrier, frame sync) can be **Real** (it
estimates) or **Ideal** (a genie uses the true channel value), so you can isolate one block. The six constellations show
the signal after each stage, coloured early → late. The loop traces compare every estimate with the true value (dashed).
"▶ Live" sends new frames continuously; "Quick BER check" runs until 100 errors or 10⁶ bits and shows a 95% Wilson
interval next to theory. Switch the payload to Text to send a message and see which characters arrive wrong.

**Digital-link conventions** (tested): symbols (±1 ± j)/√2 so Es = 1; RRC taps with Σg² = 1; complex AWGN per sample with
variance N0 = 1/(Es/N0), Es/N0 = Eb/N0 + 3.01 dB. Per-sample SNR = Es/N0 − 10·log10(sps)
(`SDR.channel.snrPerSampleDb`). Frames are [512 random lead-in symbols | 64-symbol preamble | payload | tail]; the lead-in
lets the loops lock before the preamble. Loop gains: θ = BnT/(ζ + 1/(4ζ)), K1 = 4ζθ/((1 + 2ζθ + θ²)·Kp),
K2 = 4θ²/((1 + 2ζθ + θ²)·Kp). Gardner's Kp is **measured** from its S-curve (cached per roll-off/sps/span); the
decision-directed carrier detector uses the analytic Kp = 1.

`SDR.qpsk.runLink(cfg, rng)` is the whole link as one pure function (the BER page will call it). With 10,000 payload bits
it takes ≈ 30 ms at sps 8 with ideal sync and ≈ 105 ms with all stages real and all impairments on (≈ 17 / 45 ms at sps 4).

