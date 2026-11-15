# InkLab — an isolated WebGPU ink pipeline

**Status:** design approved and built 2026-09-13. Section 17 records what changed during implementation.
**Route:** `/lab/ink`. **Code:** `static/js/inklab/`. **Template:** `templates/lab_ink.html`.

## 1. Purpose

A standalone, measurable prototype of a low-latency ink pipeline for Inkyscib:
input samples cross threads through shared memory, a dedicated worker renders
with WebGPU into an OffscreenCanvas, and a predictor extrapolates the stroke ahead
of the pen. It exists to answer one question with numbers — *does this beat the
current editor on the target tablet?* — before anything is ported into `/write`.

It implements, in this order, five requested steps:

1. A COOP/COEP-isolated page, a `SharedArrayBuffer` ring buffer, and a dedicated
   render worker using OffscreenCanvas.
2. A WGSL compute shader that turns raw pen samples into tessellated quad
   vertices, with width driven by pressure.
3. A WebGPU render pipeline: a baked-strokes texture plus an instanced quad draw
   for the active stroke, presented through the OffscreenCanvas.
4. Pointer events with `getCoalescedEvents()` and `getPredictedEvents()`, every
   sample written into the ring buffer.
5. A polynomial stroke predictor (velocity + acceleration) as the fallback, with
   a WebNN hook for a neural predictor when one is available.

Step 1 includes the Canvas2D renderer (section 12.2), so the pipeline draws, and
can be tested, before any GPU code exists.

## 2. Why a standalone page, not the editor

Decided 2026-09-13. Each reason below was checked against the code or probed in
a browser, not assumed.

- **COEP would break YouTube on `/write`.** `static/js/youtube.js:418` creates
  `new YT.Player(...)`, a cross-origin `youtube.com` iframe. YouTube does not opt
  into COEP, and lecture playback is a headline feature.
- **Rasterisation is not where the editor's latency is.** The editor's live
  stroke already costs 0.100 ms per frame, flat with stroke length (measured
  2026-09-11): about 0.6% of a 16.7 ms frame. A GPU cannot meaningfully speed that
  up. Prediction is the part of this work that can reduce perceived lag.
- **The width formula already has three copies** — `canvas.js:310`,
  `pdf-vector.js:217`, `app.py:1765` — and drift between them breaks the
  lossless-export invariant (`TODOS.md` item 5). This design adds a JS copy and a
  WGSL copy, so both are pinned by parity tests (section 15), and neither is used
  by export.

## 3. Platform facts this design rests on

Probed 2026-09-13 with throwaway pages, not taken from documentation.

| Capability | Bundled Playwright Chromium 151 | System Chrome 152 |
|---|---|---|
| `crossOriginIsolated`, `SharedArrayBuffer`, `Atomics.waitAsync` | yes | yes |
| `transferControlToOffscreen`, OffscreenCanvas 2D in a worker | yes | yes |
| `getCoalescedEvents`, `getPredictedEvents` | yes | yes |
| `requestAnimationFrame` and `Atomics.waitAsync` inside a worker | yes | yes |
| WebGPU adapter, headless | yes (AMD) | yes |
| WebGPU **device**, headless | **no** — `requestDevice` fails loading `dxil.dll` | **yes**, page and worker |
| WebGPU device, headed | yes | not tested |
| WebNN (`navigator.ml`) | no | no |

Two further probe results constrain the design:

- **A worker script served without COOP/COEP is blocked outright** (`onerror`)
  when its page is isolated, in both browsers. With the headers it loads isolated,
  and a write made through the `SharedArrayBuffer` is visible to the page.
- **An OffscreenCanvas locks to the first context type it hands out.** After
  `getContext('webgpu')`, `getContext('2d')` returns `null`, and vice versa. This
  shapes initialisation order and fallback (section 12).

The target device is a budget Android tablet with a capacitive stylus
(`DESIGN.md:8`). Pointer Events specifies that hardware without pressure reports
`pressure = 0.5` while pressed, so on the target device width will vary with speed
and taper but not with pressure. That is inherent to the hardware, not a defect.

## 4. Scope

**In:** the route and isolation headers; ring buffer; render worker; WebGPU
backend; Canvas2D fallback backend; pointer capture; polynomial predictor; WebNN
hook; a stats overlay; a Clear button; tests.

**Out:** `/write` and everything it owns (committed canvas pipeline, storage, PDF
export, YouTube); saving or loading strokes; pan and zoom; nibs other than brush;
multi-pointer drawing; a trained neural model.

## 5. Architecture

```
 page (main thread)                          render worker
 ------------------                          -------------
 pointer events --> ring.push(sample) --+
   coalesced -> MOVE                    |    SharedArrayBuffer ring
   predicted -> PREDICTED               +---------------------------->  drain on rAF
 ring.notify() --- Atomics.notify ------+                                  |
                                                                           v
 transferControlToOffscreen ------------- canvas ---------------->  assemble committed + provisional
                                                                           |
                                                             predictor <---+  (only if no native predictions)
                                                                           v
                                                       renderer: WebGPU  -or-  Canvas2D
                                                                           |
 stats overlay <-------------------- postMessage (stats, ~4 Hz) -----------+
```

The page never renders ink. The worker never touches the DOM.

## 6. Isolation and routing

- `GET /lab/ink` renders `templates/lab_ink.html`. The template loads **no
  third-party resource** of any kind — no Google Fonts, no analytics, no YouTube —
  so `require-corp` costs it nothing. Same-origin CSS (`/static/css/tokens.css`)
  is allowed and used for the page chrome; fonts fall back to the token stacks.
- `set_security_headers` in `app.py` adds `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp` to responses whose path starts
  with `/lab/` or `/static/js/inklab/`, and to no other response.
- The existing CSP is unchanged. It already permits same-origin workers
  (`worker-src` falls back to `script-src 'self'`), confirmed by probe.
- If `self.crossOriginIsolated` is false the page shows a plain message naming the
  missing headers and does not start the worker.

## 7. Components

Every file is a classic script — an IIFE that attaches to `self.InkLab` — matching
the codebase's `window.Inkyscib` pattern. The same file loads with `<script>` on the
page or `importScripts` in the worker. No modules, no build step.

| File | Responsibility | Runs in | Depends on |
|---|---|---|---|
| `ring-buffer.js` | SPSC lock-free sample queue over a `SharedArrayBuffer` | page, worker | — |
| `stroke-width.js` | Brush width formula; the JS reference | worker | — |
| `predictor.js` | Polynomial extrapolator; WebNN adapter | worker | — |
| `shaders.js` | WGSL source strings | worker | — |
| `gpu-renderer.js` | WebGPU device, pipelines, baked texture, instanced draw | worker | `shaders.js`, `stroke-width.js` |
| `canvas2d-renderer.js` | The same renderer interface on OffscreenCanvas 2D | worker | `stroke-width.js` |
| `render-worker.js` | Message handling, drain loop, stroke assembly, stats | worker | all of the above |
| `lab-main.js` | Isolation check, allocation, canvas transfer, pointer events, overlay | page | `ring-buffer.js` |

**Renderer interface** — both backends implement it identically:

| Method | Contract |
|---|---|
| `init(canvas, size, ink, baseSize)` | Resolves when ready to draw. Rejects with a reason string on failure. |
| `resize(size, finishedStrokes)` | Reallocates to the new size and re-bakes every finished stroke. |
| `drawFrame(committed, provisional)` | Presents the baked layer with the active stroke drawn over it. |
| `bake(committed)` | Adds a finished stroke to the baked layer. Never receives predictions. |
| `clear()` | Empties the baked layer. |
| `snapshot()` | Resolves `{inked, bbox}` measured on the baked layer. Test seam. |

`size` is `{width, height, dpr}`: CSS pixels plus device pixel ratio. `ink` is the
page's `--ink` token as premultiplied `[r, g, b, a]` in 0–1, read once at startup.

## 8. Sample format and ring buffer protocol

**A sample** is five `float64` fields, in order: `x`, `y` (CSS px relative to the
canvas), `pressure` (0–1), `time` (the event's `timeStamp`, ms on the page clock),
and `flags`. Float64 keeps timestamps exact for the life of the page.

| Flag | Value | Meaning |
|---|---|---|
| `DOWN` | 1 | First sample of a stroke |
| `MOVE` | 2 | A real, committed sample |
| `UP` | 4 | Stroke ended; this sample is committed and ends it |
| `PREDICTED` | 8 | A provisional sample; never committed |

**Memory layout.** One `SharedArrayBuffer` of `32 + capacity × 5 × 8` bytes:

- an `Int32Array` header of 8 slots at byte 0 — `HEAD = 0`, `TAIL = 1`,
  `CAPACITY = 2`, `OVERFLOW = 3`, `WAKE = 4`, slots 5–7 reserved;
- a `Float64Array` of `capacity × 5` at byte 32, which is aligned for float64.

Capacity is **16,384**. One slot stays empty to distinguish full from empty, so
16,383 samples fit.

**Producer (page) — owns `HEAD`:**

```
push(sample):
  h = load(HEAD); t = load(TAIL); next = (h + 1) % cap
  if next == t: add(OVERFLOW, 1); return false      # dropped, and counted
  write the five fields at slot h
  store(HEAD, next); return true                     # publish only after writing
notify():
  add(WAKE, 1); Atomics.notify(header, WAKE)
```

**Consumer (worker) — owns `TAIL`:**

```
drain(visit):
  t = load(TAIL); h = load(HEAD)
  while t != h: visit(read slot t); t = (t + 1) % cap
  store(TAIL, t)
waitForWork(seenWake):
  r = Atomics.waitAsync(header, WAKE, seenWake)
  return r.async ? r.value : Promise.resolve(r.value)   # 'not-equal' resolves at once
```

Each side writes only its own index, and the producer publishes a slot only after
filling it, so no lock is needed. A stale read of the other side's index is always
safe. Overflow is never silent: it is counted, shown in the overlay, and asserted
zero in tests.

## 9. Page: pointer capture

- The canvas fills the viewport and carries `touch-action: none`. Listeners are
  `passive: false`.
- Only `isPrimary` pointers draw. `pointerdown` calls `setPointerCapture`.
- **`pointerdown`** pushes one `DOWN` sample and calls `notify()`.
- **`pointermove`** (only while down) pushes every event from
  `getCoalescedEvents()` — or `[event]` where that is unavailable — as `MOVE`; then
  every event from `getPredictedEvents()` — or none where unavailable — as
  `PREDICTED`; then calls `notify()` once.
- **`pointerup` / `pointercancel`** pushes one `UP` sample and calls `notify()`.
- A `ResizeObserver` posts `{type: 'resize', width, height, dpr}`.
- A **Clear** button posts `{type: 'clear'}`.
- Test seam: `window.InkLab.lab.pushSample(sample)` and `window.InkLab.lab.notify()`
  write to the same ring, so tests can inject samples — including predictions —
  without synthetic pointer events.

## 10. Worker: the drain loop

**State:** `committed` (samples of the active stroke), `pendingPredicted`,
`provisional`, `finished` (committed samples of every completed stroke, kept for
re-baking), `drawing` (bool), `seenWake`.

**Waking without losing a notification.** While idle the worker awaits
`waitForWork(seenWake)`. Once woken it runs `requestAnimationFrame` frames. Each
frame sets `seenWake = load(WAKE)` **before** it drains. When a frame drains nothing
and no stroke is active, the worker goes back to waiting on that `seenWake`. A
`notify` that lands between that drain and the wait has already changed `WAKE`, so
the wait resolves at once instead of sleeping through it. No frames run while
nothing is happening.

**Each frame:**

1. `seenWake = load(WAKE)`; then `drain`, visiting samples in order:
   - `DOWN` → start a stroke: `committed = [s]`, clear `pendingPredicted`,
     `drawing = true`.
   - `MOVE` → append to `committed`; clear `pendingPredicted`. A newer real sample
     makes every earlier prediction stale.
   - `PREDICTED` → append to `pendingPredicted`.
   - `UP` → append to `committed`; then `renderer.bake(committed)`, push to
     `finished`, clear `committed`, `pendingPredicted` and `provisional`,
     `drawing = false`.
2. If `drawing`, choose `provisional`, in priority order:
   - `pendingPredicted` if non-empty — source `native`;
   - else a fresh WebNN result (section 11.2) — source `webnn`;
   - else `predictor.predict(committed)` — source `polynomial`, or `none` if it
     returns `[]`.
3. `renderer.drawFrame(committed, provisional)`.
4. Record stats (section 13).

**Invariant:** predicted samples are never baked, and never enter `committed` or
`finished`.

## 11. Stroke width and prediction

### 11.1 Width — the JS reference (`stroke-width.js`)

A literal port of the **brush** branch of `__penSegmentWidth`
(`static/js/canvas.js`), so a stroke here has the same weight as the same stroke in
the editor. For a stroke `P` of `n` samples at index `i`:

```
clamp(v, lo, hi)  = min(hi, max(lo, v))
pressure(i)       = P[i].pressure is a number ? clamp(P[i].pressure, 0.05, 1) : 0.55
dt(i)             = (P[i].time || 0) - (P[i-1].time || 0)
speed(i)          = i == 0 ? 0 : hypot(P[i] - P[i-1]) / max(8, dt(i) || 16)
remaining(i)      = max(0, n - 1 - i)
speedWeight(i)    = clamp(1.58 - speed(i) * 0.88, 0.42, 1.5)
pressureWeight(i) = 0.42 + pressure(i) * 1.95
taper(i)          = min(1, 0.18 + i / 3.5, 0.16 + remaining(i) / 5)
width(i)          = max(0.55, baseSize * pressureWeight(i) * speedWeight(i) * taper(i))
```

`dt(i) || 16` turns a zero or `NaN` interval into 16 ms before the `max(8, …)`; a
negative non-zero interval therefore becomes 8. Taper depends on `remaining`, so a
point's width changes as samples are appended after it: the renderer needs the
live sample count, not only a point's neighbours. `baseSize` is fixed at **4** CSS
px. Units are CSS px and CSS px per ms.

### 11.2 Prediction (`predictor.js`)

**Polynomial — `predict(committed, horizonMs = 16)`.** Uses the last four
committed samples `s0…s3` (`s3` newest), with `t` their times and `dtAB = tB − tA`.

```
if fewer than 4 samples, or dt01, dt12 or dt23 <= 0:        return []
va = (s1 - s0) / dt01;  vb = (s2 - s1) / dt12;  vc = (s3 - s2) / dt23   # velocities at interval midpoints
a1 = (vb - va) / ((t2 - t0) / 2)
a2 = (vc - vb) / ((t3 - t1) / 2)
a  = (a1 + a2) / 2                                         # acceleration, averaged to damp jitter
v  = vc + a * dt23 / 2                                     # velocity at t3
if |v| < 0.02 px/ms:                                       return []    # stationary
H  = min(horizonMs, 25)
a' = 0.5 * a                                               # damped
if dot(v, v + a' * H) <= 0:                                return []    # reversing within the horizon
for tau in [H/2, H]:
  d = v * tau + 0.5 * a' * tau^2
  if |d| > 1.5 * |v| * H:  d = d * (1.5 * |v| * H / |d|)  # clamp displacement
  emit { x: s3.x + d.x, y: s3.y + d.y, pressure: s3.pressure,
         time: s3.time + tau, flags: PREDICTED }
```

Average velocity over an interval equals the instantaneous velocity at its midpoint
when acceleration is constant, so before damping `v` and `a` are exact for
constant-velocity and constant-acceleration input, whatever the sampling intervals.
The damping, the reversal test and the clamp guard against overshoot, the
characteristic failure of stroke prediction.

**WebNN hook — `createNeural({ml, model})`.**

- Returns `null` unless `ml` is truthy, `typeof ml.createContext === 'function'`,
  and `typeof model === 'function'`.
- Otherwise returns `{ predict(history) }`. On first use it awaits
  `ml.createContext()` once, then resolves `model(context, history)`. The model
  must resolve an array of `{x, y}` with finite coordinates. The adapter fills
  `pressure`, `time` and `flags` exactly as the polynomial predictor does, spacing
  the points evenly across the horizon. An invalid result, a rejection or a throw
  resolves to `null`.
- **The worker runs at most one inference at a time.** Each result is tagged with
  the `time` of the newest committed sample it was given, and is used only while
  that sample is still the newest. Otherwise the polynomial predictor runs.
- **No model ships.** There is no trained model; this is the integration point for
  one. The worker builds the hook from `self.navigator.ml` and an optional model
  supplied at `init`, and none is supplied, so in practice the hook returns `null`.

## 12. Rendering

### 12.1 WebGPU backend (`gpu-renderer.js`, `shaders.js`)

**Initialisation — order matters.** Because an OffscreenCanvas locks to its first
context type, everything that can fail runs **before** `getContext('webgpu')`:

1. `navigator.gpu`, `requestAdapter()`, `requestDevice()`;
2. create every shader module and check `getCompilationInfo()` for errors;
3. create every pipeline with `createComputePipelineAsync` /
   `createRenderPipelineAsync`;
4. only then `getContext('webgpu')` and `configure({device, format:
   navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied'})`.

A failure at steps 1–3 rejects `init` with a reason and leaves the canvas free for
Canvas2D.

**Buffers.**

- `samples` — storage, `array<vec4<f32>>` of `(x, y, pressure, time − t0)`, where
  `t0` is the stroke's first sample time, so f32 stays precise. It starts at 4,096
  samples and doubles, recreating its bind group, whenever a stroke outgrows it.
- `params` — uniform: `count: u32`, `baseSize: f32`, `dpr: f32`,
  `viewport: vec2<f32>`, ink colour `vec4<f32>` (premultiplied).
- `segments` — storage, one record per segment, sized to `samples` capacity:

```
struct Segment {                  // 64 bytes
  corners : array<vec2<f32>, 4>,  // device px: the tessellated quad, triangle-strip order
  a       : vec2<f32>,            // segment start, device px
  b       : vec2<f32>,            // segment end, device px
  ra      : f32,                  // radius at a = width(i-1) / 2, device px
  rb      : f32,                  // radius at b = width(i)   / 2, device px
  _pad    : vec2<f32>,
}
```

**Compute — the tessellator (step 2).** Workgroup size 64, dispatched for
`count − 1` segments. Segment `k` joins samples `i − 1 = k` and `i = k + 1`. It
computes `width(i − 1)` and `width(i)` with the formula of section 11.1, using
`count` for `remaining`; converts the endpoints to device px (× `dpr`); and writes a
quad that extends past each end by `max(ra, rb) + 1` px along the segment and
`max(ra, rb) + 1` px either side of it, so antialiasing is never clipped. A
zero-length segment writes a square quad centred on its point.

Two parts of the formula need a WGSL form. JavaScript's `dt || 16` becomes
`select(dt, 16.0, dt == 0.0)` — the shader's times are finite, so `NaN` cannot
arise. And WGSL has no "is a number" test, so the shader takes pressure as recorded:
every page sample carries a numeric `PointerEvent.pressure`, so the `0.55` branch
never applies on the GPU.

**Render (step 3).** Every frame, one pass onto the canvas texture with
`loadOp: 'clear'` to transparent:

1. **Baked layer** — a fullscreen triangle sampling the baked texture.
2. **Active stroke** — `draw(4, count − 1)` instanced, triangle-strip topology. The
   vertex shader emits `corners[vertex_index]`; the fragment shader computes
   `h = clamp(dot(p − a, b − a) / dot(b − a, b − a), 0, 1)` and
   `d = |p − (a + h(b − a))| − mix(ra, rb, h)`, and outputs ink coverage
   `clamp(0.5 − d, 0, 1)`. A zero-length segment uses `h = 0`. That is a capsule
   whose radius varies along its length: close to a true round cone for the small
   radius changes between neighbouring samples, and with round caps, so joints need
   no extra geometry.

**Blending.** Ink is one opaque colour, so strokes are drawn with the `max` blend
operation for both colour and alpha. The union of overlapping capsules is then
exact: joints within a stroke do not darken where caps overlap.

**Bake.** The same compute pass and instanced draw, targeting the baked
`rgba8unorm` texture (usage `RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC`) with
`loadOp: 'load'`.

**Resize** recreates the baked texture and re-bakes `finished`. **Clear** clears it.

**`snapshot()`** copies the baked texture to a `MAP_READ` buffer, maps it, and counts
pixels with alpha ≥ 8.

**`tessellate(samples, baseSize)`** — test seam. Runs the compute pass on the given
samples, maps `segments` back, and resolves `{dpr, gpuRadii: [[ra, rb], …],
jsWidths: […]}`, with `jsWidths` from `stroke-width.js` for the same samples.
`gpuRadii` are device px; `jsWidths` are CSS px.

### 12.2 Canvas2D backend (`canvas2d-renderer.js`)

- The transferred canvas gets a `2d` context; the baked layer is a second
  `OffscreenCanvas` of the same device size.
- Everything is drawn in device px: coordinates and widths are multiplied by `dpr`.
- `drawFrame` clears the canvas, draws the baked layer, then draws each segment as a
  line from `P[i−1]` to `P[i]` with round caps, width `(width(i−1) + width(i)) / 2`,
  in the ink colour.
- `bake` draws the committed segments onto the baked layer in the same way.
- `snapshot()` reads the baked layer with `getImageData`.
- It averages width per segment where the GPU tapers within the segment. The
  difference is not visible at these sizes, and each backend is only ever compared
  with itself.

### 12.3 Choosing a backend

`init` tries WebGPU. On rejection the worker records the reason and initialises
Canvas2D on the same, still-unlocked canvas.

**Device loss.** On `device.lost`, the worker rebuilds the device and pipelines
once, reconfigures the existing context, and re-bakes. If that fails, the canvas
cannot fall back — it is locked to `webgpu` — so the worker posts
`{type: 'needCanvas'}`. The page replaces the `<canvas>` element and transfers the
new one with `{type: 'replaceCanvas'}`, and the worker continues on Canvas2D,
re-baking `finished`.

## 13. Stats overlay and latency

The worker posts `{type: 'stats', …}` about four times a second. The page shows, in
a small overlay styled with the design tokens:

| Field | Meaning |
|---|---|
| `backend` | `webgpu` or `canvas2d`, and the fallback reason if any |
| `latencyMedianMs` | Median over the last 120 frames whose drain consumed a committed sample |
| `predictionSource` | `native`, `webnn`, `polynomial` or `none`, for the latest frame |
| `overflow` | Ring overflow count |
| `frames` | Frames drawn |

**Latency** for a frame is `presentOnPageClock − newestCommittedSampleTime`, where
`presentOnPageClock = worker performance.timeOrigin + rafTimestamp −
pageTimeOrigin`, and `pageTimeOrigin` is sent at `init`. It runs from the input
event's timestamp to frame submission, and **excludes compositing and display
scan-out**, so it is a lower bound on what the user sees. Headless numbers are not
reported as results; a real figure needs the tablet.

## 14. Error handling and messages

| Condition | Behaviour |
|---|---|
| Not cross-origin isolated | Message naming the missing headers; worker not started |
| No `navigator.gpu`, adapter or device; shader or pipeline creation fails | Canvas2D; the reason is shown in the overlay |
| `device.lost` | Rebuild once; then `needCanvas` and Canvas2D (section 12.3) |
| Worker `error` | Shown on the page; not swallowed |
| Ring overflow | Counted, shown, asserted zero in tests |
| WebNN model throws or returns invalid output | That frame uses the polynomial predictor |

**Page → worker:** `init {canvas, sab, width, height, dpr, pageTimeOrigin, ink,
baseSize}`, `resize {width, height, dpr}`, `clear`, `replaceCanvas {canvas}`,
`snapshot {id}`, `tessellate {id, samples, baseSize}`.

**Worker → page:** `ready {backend, fallbackReason}`, `stats {…}`, `needCanvas`,
`error {message}`, `snapshot {id, backend, fallbackReason, frames, overflow,
predictionSource, activeSamples, finishedStrokes, inked, bbox}`,
`tessellate {id, backend, dpr, gpuRadii, jsWidths}`.

## 15. Testing

The repository's single command, `python -m pytest tests/ -q`, runs every layer.

### 15.1 Node — pure units, test-driven (`tests/inklab/*.test.cjs`)

Loaded with `node:test` and `vm.runInNewContext` against a fake `self`, as
`tests/planner_sw_notification_click.test.cjs` already does. The wrapper
`tests/test_inklab_node.py` skips if `node` is not on `PATH`, collects the files with
a sorted glob, runs `node --test` on that explicit list, and fails with Node's output
on a non-zero exit.

- **`ring_buffer.test.cjs`** — FIFO order; wraparound over several capacities; a
  push onto a full ring returns `false` and increments `OVERFLOW`; all five fields
  and every flag round-trip; producer and consumer built on separate views of one
  `SharedArrayBuffer`; `notify` increments `WAKE`; `waitForWork` with a stale
  `seenWake` resolves at once.
- **`predictor.test.cjs`** — constant velocity lands exactly on the line; constant
  acceleration matches the damped formula, with irregular intervals; stationary
  input returns `[]`; reversal within the horizon returns `[]`; a fast curve never
  exceeds the clamp; zero or negative intervals return `[]`; fewer than four samples
  return `[]`; the horizon is capped at 25 ms.
- **`neural_hook.test.cjs`** — no `ml` → `null`; no model → `null`; a mock model's
  points are used and filled in; a throwing or rejecting model → `null`; an invalid
  result → `null`; `createContext` runs once across several predictions.
- **`stroke_width_parity.test.cjs`** — extracts `__clamp`, `__pointPressure`,
  `__segmentSpeed` and `__penSegmentWidth` by source text from the real
  `static/js/canvas.js`, and asserts `strictEqual` against `stroke-width.js` for the
  brush style, over generated strokes that include zero, negative and `NaN`
  intervals and missing pressure. This copy cannot drift silently.

### 15.2 Playwright, bundled Chromium — always runs (`tests/test_inklab_page.py`)

- **Headers** (Flask test client): `/lab/ink` and
  `/static/js/inklab/render-worker.js` carry both headers; `/write` carries neither.
  This is the guard for YouTube.
- The page is `crossOriginIsolated` and the worker posts `ready`.
- `backend` is `canvas2d`, with a non-empty `fallbackReason` (no device here).
- A synthetic pointer stroke at least 200 CSS px long, followed by a snapshot, gives
  `inked > 500`, `finishedStrokes = 1` and `overflow = 0`.
- **Predictions are never baked:** the same stroke is drawn twice, with a `clear`
  between, once with injected `PREDICTED` samples far off its path. The two
  snapshots have identical `inked` and `bbox`.
- A steady straight-line stroke of at least four samples, snapshotted before
  `pointerup`, reports a `predictionSource` other than `none`.

### 15.3 Playwright, system Chrome — GPU (`tests/test_inklab_webgpu.py`)

Skips, stating why, if `chromium.launch(channel='chrome')` fails or `backend` is not
`webgpu`.

- A synthetic stroke at least 200 CSS px long gives `inked > 500` in the baked
  texture.
- **Width parity for the WGSL copy:** for fixed samples, each with a numeric
  `pressure`, `gpuRadii[k][0] × 2 / dpr` matches `jsWidths[k]` and
  `gpuRadii[k][1] × 2 / dpr` matches `jsWidths[k + 1]`, within 1e-4 relative. The
  WGSL copy cannot drift silently either.

### 15.4 Not claimed

No latency figure from any headless run. The overlay reports latency, but a result
worth quoting needs the target tablet.

## 16. Risks and open questions for any future port into `/write`

- COEP breaks the YouTube iframe on `/write`. A port would need `credentialless`
  with a per-iframe opt-in, or a change to how YouTube is embedded.
- WebGPU availability on the actual target tablet is unknown, and so is whether its
  Chrome returns predicted events.
- The width formula would then exist in five places. The parity tests here guard
  only the two new copies.
- Rasterisation in the editor is already cheap (section 2). Any latency win has to
  be demonstrated on the device before a port is justified.


## 17. Amendments made during implementation (2026-09-13)

These were found while building and verifying the design above. Each is either
something the spec did not anticipate or a gap its tests could not see.

- **WebGPU validation errors are now surfaced.** They never throw, so section 14
  had no row for them and nothing reported them: a render pass that failed
  validation would have passed every test with an empty error list. This was
  demonstrated, not assumed - a deliberate invalid bind group passed the suite
  before the change. The renderer now listens for `uncapturederror` once `init`
  has succeeded, and the worker reports each distinct message to the page once.

  | Condition | Behaviour |
  |---|---|
  | WebGPU validation error after init | Reported on the page as `WebGPU: <message>`, once per distinct message |

- **What reaches the screen is now tested.** Every test in section 15 read the
  worker's baked layer; none observed the canvas. A screenshot test per backend
  now checks both present paths - the live stroke over the baked layer, and the
  baked layer alone - comparing against the clip's own background so it holds in
  either theme.
- **Page API additions:** `lab.clear()` and `lab.errors` (a list of every error
  message shown), both needed by the tests.
- **A neural model cannot be passed in `init`.** Functions do not survive
  structured cloning, so a model cannot be posted to a worker. The hook reads
  `self.InkLab.NeuralModel`, which a script the worker loads would define. None
  exists.
- **In bundled Chromium the worker finds no adapter at all** (`No WebGPU adapter
  is available`), where the page-side probe in section 3 found one but no device.
  The fallback reason differs; the behaviour does not.
- **The GPU render tests first prove a device exists** through `tessellate`, and
  only skip when it does not. Otherwise they would pass on the Canvas2D fallback
  and prove nothing about the GPU.
