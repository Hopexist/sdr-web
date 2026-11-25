# Changelog

## 1.0.0 — Phase 6: polish, docs, CI, deploy

- Global error banner, keyboard shortcuts with a `?` overlay, a first-visit tour on each page, footer, favicon, 404 page.
- Theme toggle (T) on top of the system setting; `prefers-reduced-motion` support; WCAG AA text contrast and a plot
  palette with ≥ 3:1 contrast in both themes; focus rings, aria-labels, plots described for screen readers.
- "Computing…" overlay while a full run is in progress.
- BER engine: adaptive frame sizes so a point stops close to the min-error target (seed-reproducible).
- Honest AWGN test: Bonferroni-corrected per-point intervals plus a pooled χ² test.
- GitHub Actions CI in headless Chrome; JSDoc headers on every JS file; docs/ARCHITECTURE.md; README screenshots.
- GitHub Pages readiness (`.nojekyll`, `404.html`).

## Phase 5: BER page, sweep engine, workers, landing page

- `SDR.ber`: sweeps over any config path, stop rules (min errors, max bits, max time), BER floor, per-point seeds,
  Wilson intervals, required Eb/N0, implementation loss, diversity slope, CSV/JSON export, saved runs.
- Web Worker pool over http(s), main-thread fallback on file://; nine presets; Analog SNR tab; landing page.

## Phase 4: streaming QPSK link and full channel model

- Every filter, loop and equalizer became a streaming block; `createLink` → `step` / `finish`, bit-exact with the
  Phase 3 receiver.
- Channel: multipath (with per-tap fading), Rayleigh/Rician block and Jakes fading, clock drift, phase noise,
  IQ imbalance, DC offset, ADC quantization and clipping.
- Receiver: NLMS (T and T/2), CMA, zero-forcing equalizers; preamble LS, pilot-aided and ideal CSI; IQ correction.

## Phase 3: QPSK link page

- Gray QPSK, RRC shaping, 4th-power CFO estimate, Gardner + Farrow timing loop, decision-directed PLL,
  preamble frame sync with ambiguity resolution; per-stage constellations, eye diagram, loop traces, quick BER check.

## Phase 2: FM page

- FM modulator, discriminator and PLL demodulators, pre/de-emphasis, Carson's rule and Bessel lines on the spectrum,
  click counting, output SNR vs CNR showing the threshold; shared page scaffold.

## Phase 1: AM page

- DSB-LC / DSB-SC, envelope and coherent detection, audio upload and playback, output SNR vs CNR.

## Phase 0: foundations

- Seeded RNG, complex arrays, erfc / Q, radix-2 FFT, Welch PSD, filters, the Canvas plot library, tests.html.
