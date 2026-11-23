# Software-Defined Radio in the Browser — Project Plan

A website that simulates an SDR: AM, FM and QPSK modulators/demodulators, a configurable channel (noise + impairments), and Monte Carlo BER curves checked against theory. Everything runs client-side in plain HTML, CSS and JavaScript.

**No installs:** no Node, no npm, no bundler, no CDN libraries. Open `index.html` in a browser and it works. Host it free on GitHub Pages when you want a link.

---

## 1. Goals

| Goal | "Done" means |
|---|---|
| AM page | Pick tone or uploaded audio, set modulation index, hear the demodulated output, see envelope + spectrum |
| FM page | Set deviation, see Carson bandwidth on the spectrum, hear the threshold "clicks" at low CNR |
| QPSK page | Live constellation, eye diagram, and sync-loop plots as you turn impairments on |
| Channel panel | Sliders/toggles for AWGN, CFO, phase, timing, fading, multipath, IQ imbalance… shared by all pages |
| BER page | Run a sweep, watch points appear on a log-scale plot over the theory curve, export CSV/PNG |
| Analog metrics | Output SNR vs input CNR curves for AM and FM (BER doesn't apply to analog) |
| Portfolio quality | Self-tests page, README with screenshots, reproducible (seeded) runs |

**Stretch:** 16-QAM / 8-PSK, convolutional coding + Viterbi, OFDM, fixed-point receiver, loading real IQ recordings.

---

## 2. What you write yourself (since there are no libraries)

All of this is short and a good learning exercise:

| Need | Replace NumPy/SciPy with |
|---|---|
| Arrays | `Float64Array` — store complex signals as two arrays `{re, im}` |
| Random numbers | Seeded PRNG (`mulberry32` or `xoshiro128**`) + Box–Muller for Gaussians |
| FFT | Iterative radix-2 Cooley–Tukey (~40 lines); zero-pad to a power of 2 |
| PSD | Welch: windowed segments → FFT → average \|X\|² |
| Filters | FIR convolution; RRC taps from the closed-form formula; windowed-sinc lowpass |
| `erfc` / Q-function | Numerical Recipes Chebyshev `erfcc` (≈1e-7 relative accuracy — fine down to BER 1e-9) |
| Plots | Your own Canvas 2D plotting: line, scatter, log-y axis, grid, legend |
| Audio | Web Audio API: `decodeAudioData` for uploads, `AudioBuffer` to play results |

---

## 3. Site layout

```
sdr-web/
├── index.html            # landing page + nav
├── am.html
├── fm.html
├── qpsk.html
├── ber.html
├── tests.html            # runs self-tests in the browser, shows pass/fail
├── css/
│   └── style.css
├── js/
│   ├── core/
│   │   ├── rng.js        # seeded PRNG, randn, random bits
│   │   ├── complex.js    # {re,im} helpers: mul, conj, abs, angle, power
│   │   ├── fft.js        # radix-2 FFT/IFFT
│   │   ├── dsp.js        # convolve, upsample, decimate, windows, Welch PSD
│   │   ├── filters.js    # RRC, lowpass, DC blocker, de-emphasis
│   │   ├── mathx.js      # erfc, Q(x), dB conversions
│   │   └── plot.js       # canvas plotting library
│   ├── analog/
│   │   ├── am.js
│   │   └── fm.js
│   ├── digital/
│   │   ├── mapping.js    # Gray QPSK map/demap
│   │   ├── qpsk.js       # tx/rx chains
│   │   └── sync.js       # CFO est., Costas/DD-PLL, Gardner + interpolator, preamble correlate
│   ├── channel.js        # composable impairments
│   ├── theory.js         # closed-form BER curves
│   ├── ber.js            # Monte Carlo harness, confidence intervals
│   ├── audio.js          # Web Audio load/play helpers
│   └── ui/               # one small script per page wiring sliders → sim → plots
│       ├── am-page.js
│       ├── fm-page.js
│       ├── qpsk-page.js
│       └── ber-page.js
└── README.md
```

**Important — file:// gotcha:** Chrome blocks ES modules (`<script type="module">`) and Web Workers when you open a page straight from disk. To keep "double-click `index.html`" working:

- Use **classic `<script src="...">` tags** in dependency order, with everything attached to one global namespace: `window.SDR = window.SDR || {}; SDR.fft = ...`.
- Do long BER sweeps in **chunks** (run a block, then `setTimeout(next, 0)`) so the page stays responsive. Workers become an optional speed-up once it's hosted on GitHub Pages.

---

## 4. Conventions (decide these on day 1 — most bugs come from here)

1. **Complex baseband everywhere.** A signal is `{re: Float64Array, im: Float64Array}` at sample rate `fs`.
2. **Unit-energy pulses.** RRC taps normalized so `Σg² = 1`. Symbols normalized so average `Es = 1`.
3. **Noise scaling.** With the two rules above, add complex AWGN per sample with total variance `σ² = N0 = 1/(Es/N0)` (σ²/2 on each of I and Q), where `Es/N0 = 2·Eb/N0` for QPSK.
4. **Seeded RNG.** Every sim function takes an `rng` object. Show the seed in the UI so a figure can be reproduced exactly.
5. **Track filter delay explicitly.** Each filter returns its group delay; the receiver trims it.
6. **Sim code never touches the DOM.** `js/core`, `analog`, `digital`, `channel` are pure functions. Only `js/ui/*` reads sliders and draws. This keeps the DSP testable and reusable.

---

## 5. Phases

### Phase 0 — Foundations (2 sessions)
- `rng.js`, `complex.js`, `mathx.js`, `fft.js`, `dsp.js`.
- `plot.js`: axes with auto ticks, linear and log-y scale, line + scatter series, legend, "save PNG" via `canvas.toDataURL()`. Handle `devicePixelRatio` so plots are sharp.
- `tests.html` with a tiny assert helper (`check(name, condition)` → green/red row).
- **Tests:** FFT of a tone peaks at the right bin; FFT→IFFT round-trip error < 1e-12; `randn` mean ≈ 0, variance ≈ 1 over 1e6 samples; `Q(0) = 0.5`.

### Phase 1 — AM page (1–2 sessions)
- **Mod:** DSB-LC `s = 1 + μ·m(t)` (|m| ≤ 1); DSB-SC `s = m(t)`.
- **Demod:** envelope (`abs` → DC block → lowpass) and coherent (rotate by `−φ̂` → real part → lowpass). Slider for phase error shows the cos Δφ loss.
- **UI:** source (tone / two-tone / uploaded audio), μ slider, play original vs demodulated, time plot, PSD plot showing carrier + sidebands, over-modulation warning when μ > 1.
- **Metric:** output SNR vs input CNR curve, envelope vs coherent.

### Phase 2 — FM page (2 sessions)
- **Mod:** `φ[n] = 2π·kf·Σm/fs`, `s = e^{jφ}`; parameterize by peak deviation Δf, show `β = Δf/W`.
- **Demod:** discriminator `angle(x[n]·conj(x[n−1]))` → scale → lowpass. Optional PLL demod.
- **Extras:** 75 µs pre/de-emphasis toggle, Carson's rule line `2(Δf+W)` drawn on the PSD.
- **Metric:** output SNR vs CNR for several β; the audio player makes the threshold effect audible.

### Phase 3 — QPSK page (3–4 sessions, the core)
Get each step to zero errors noiseless before moving on.

1. **Symbol-level link:** bits → Gray map → AWGN → hard decision. BER vs theory. *Validates noise scaling first.*
2. **Pulse shaping:** RRC (roll-off 0.35, span 8–10 symbols, 4–8 samples/symbol), matched filter, correct sampling offset. Eye diagram + constellation.
3. **Carrier recovery:** coarse CFO by 4th-power method (FFT of x⁴ → peak at 4Δf), then decision-directed/Costas loop with gains derived from loop bandwidth `BnT` and damping ζ ≈ 0.707. Resolve 4-fold ambiguity with a known preamble.
4. **Timing recovery:** Gardner detector + interpolator (linear first, then cubic Farrow). Plot timing error converging.
5. **Framing:** PN preamble + payload; correlate to find frame start.

**UI:** constellation after each stage (raw / matched filter / after CFO / after PLL / after timing) as small multiples, eye diagram, loop-error traces, live bit error count. Animate by processing in frames with `requestAnimationFrame`.

### Phase 4 — Channel module (2 sessions, alongside Phase 3)
One small function per impairment; `channel.js` applies an enabled list. Same panel component reused on every page.

| Impairment | Model | Receiver block that handles it |
|---|---|---|
| AWGN | complex Gaussian, σ² from Eb/N0 | matched filter |
| Phase offset | `x·e^{jθ}` | Costas / DD-PLL |
| Carrier freq. offset | `x·e^{j2πΔf n/fs}` | 4th-power estimate + PLL |
| Timing offset / clock drift | fractional delay, resample by (1+ε) | Gardner + interpolator |
| Flat Rayleigh / Rician fading | `h ~ CN(0,1)`, block or Jakes; K-factor | channel estimate from preamble |
| Multipath | short FIR (e.g. 3 taps) | LMS / CMA equalizer (stretch) |
| Phase noise | Wiener phase process | PLL bandwidth trade-off |
| IQ imbalance | gain and phase mismatch | blind correction (stretch) |
| DC offset | constant added | DC blocker |
| ADC quantization | clip + round to N bits | study BER vs bits |

**Tests:** every impairment off → identity; measured SNR within 0.1 dB of requested over long runs.

### Phase 5 — BER page (2 sessions)
- **Harness:** per Eb/N0 point, run blocks until ≥100 errors or a max bit count; show a 95% Wilson confidence interval as error bars. Progress bar + Stop button. Runs in chunks (Section 3).
- **Theory (`theory.js`):**
  - QPSK, AWGN: `Pb = Q(√(2·Eb/N0))`
  - QPSK, Rayleigh: `Pb = ½·(1 − √(γ̄/(1+γ̄)))`
  - Static phase error φ: `Pb = ½·[Q(√(2Eb/N0)(cosφ − sinφ)) + Q(√(2Eb/N0)(cosφ + sinφ))]`
- **Presets** (one click each):
  1. QPSK AWGN sim vs theory
  2. Rayleigh vs AWGN
  3. Several static phase errors
  4. Full sync chain vs ideal sync (implementation loss in dB)
  5. BER vs ADC bits
- **Export:** CSV of results and PNG of the plot.

### Phase 6 — Polish & deploy (1–2 sessions)
- Consistent layout, dark/light theme, mobile-friendly controls.
- Block diagram on each page (inline SVG) showing which stage the plots tap.
- Short explanation text beside each plot — this is what makes it a portfolio piece.
- Deploy: push to GitHub → Settings → Pages. README with screenshots and the live link.

---

## 6. Verification

- `tests.html` covers: noiseless loopback = 0 errors for every chain, energy checks (`Es ≈ 1`, unit-energy RRC), measured SNR ≈ requested, AWGN BER inside its CI of theory, sync loops converge on injected offsets, spectral widths (AM 2W, FM Carson, QPSK `(1+β)Rs`).
- Run it after every change. Keep it green.

---

## 7. Pitfalls

- **Eb/N0 vs Es/N0 vs per-sample SNR:** `SNR = Es/N0 − 10·log10(sps)` for unit-energy pulses. Write the conversion once and test it.
- **Filter delay** forgotten → BER ≈ 0.5.
- **QPSK phase ambiguity** → BER ≈ 0.5 in rotated blocks. Use the preamble.
- **FM unwrap errors** → use the `angle(x[n]·conj(x[n−1]))` discriminator.
- **Freezing the tab** during sweeps → chunk the work.
- **Blurry canvas** on laptops → scale by `devicePixelRatio`.
- **Audio** won't play until the user clicks something (browser autoplay rule) → create the `AudioContext` on the first button press.
- **Performance:** reuse typed arrays instead of allocating per block; plot at most a few thousand points (decimate for display).

---

## 8. Timeline (~6–7 weeks at 2–3 sessions/week)

| Week | Work |
|---|---|
| 1 | Phase 0 (FFT, RNG, plot library, tests page) |
| 2 | AM page + channel AWGN/phase/CFO |
| 3 | FM page |
| 4 | QPSK steps 1–2 + first BER curve vs theory |
| 5 | QPSK carrier + timing recovery, framing |
| 6 | Remaining impairments, BER page and presets |
| 7 | Polish, deploy, stretch goal |

---

## 9. Stretch goals

- 8-PSK / 16-QAM with theory curves
- Rate-1/2 convolutional code + Viterbi (hard vs soft), coding gain plot
- LMS / CMA equalizer for multipath
- OFDM with cyclic prefix
- Fixed-point receiver: quantize the matched filter and PLL, BER vs word length (bridge to FPGA/ASIC work)
- Load real IQ recordings (`.wav` IQ or raw `.cu8` via `<input type="file">` + `FileReader`)
- Web Worker pool for faster sweeps when hosted

---

## 10. Milestone checklist

- [ ] `tests.html` running with FFT, RNG, erfc tests passing
- [ ] Canvas plot library: linear + log axes, legend, PNG export
- [ ] AM page with audio playback and output-SNR curve
- [ ] FM page with Carson line and threshold-effect curve
- [ ] QPSK symbol-level BER matches theory
- [ ] QPSK with RRC still matches theory
- [ ] Carrier recovery locks with CFO + phase offset
- [ ] Timing recovery locks with fractional delay
- [ ] Rayleigh BER matches theory
- [ ] BER page presets + CSV/PNG export
- [ ] Deployed on GitHub Pages