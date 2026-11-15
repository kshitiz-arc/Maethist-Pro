# InkLab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/lab/ink`, a cross-origin-isolated page whose dedicated worker drains pen samples from a `SharedArrayBuffer` ring and renders them with WebGPU (Canvas2D fallback), with a polynomial stroke predictor and a WebNN hook.

**Architecture:** The page only captures pointer samples into a lock-free ring and notifies. A worker owns the transferred OffscreenCanvas: it drains the ring each animation frame, assembles committed and provisional samples, predicts, and draws through one renderer interface implemented twice (WebGPU, Canvas2D). Every file is a classic IIFE on `self.InkLab`, loadable by `<script>` or `importScripts`.

**Tech Stack:** Flask + Jinja (existing), vanilla JS classic scripts, WGSL/WebGPU, OffscreenCanvas, `SharedArrayBuffer` + `Atomics`, Node `node:test`, pytest + Playwright.

**Spec:** `docs/superpowers/specs/2026-09-13-inklab-webgpu-design.md`

## Deviations from the default plan shape

- **No worktree.** A worktree would branch from `401f803` and miss the 46 uncommitted files, including `static/js/canvas.js` (read by the width parity test) and `app.py` (modified here). Work happens in place and is purely additive except for `app.py`.
- **No commit steps.** Commits were not requested.
- **Code is written into the files during execution, not duplicated here.** The request was "just implement and test", and the executor is the session that wrote this plan. Every task still fixes exact interfaces, exact test cases, and exact commands.

## Global Constraints

- No build step. Classic IIFE scripts attaching to `self.InkLab`; each loads via `<script>` on the page or `importScripts` in the worker.
- `/lab/ink` loads no third-party resource. Same-origin `/static/css/tokens.css` is allowed.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` only on paths starting `/lab/` or `/static/js/inklab/`. `/write` and every other response are unchanged.
- Ring: capacity 16,384; sample stride 5 × float64 (`x, y, pressure, time, flags`); `Int32Array` header of 8 slots (`HEAD=0, TAIL=1, CAPACITY=2, OVERFLOW=3, WAKE=4`); data `Float64Array` at byte 32. Flags `DOWN=1, MOVE=2, UP=4, PREDICTED=8`.
- Width: a literal port of the brush branch of `__penSegmentWidth`, with `__clamp(value, min, max) = Math.max(min, Math.min(max, value))`. `baseSize` = 4 CSS px.
- Predictor: last 4 committed samples; horizon default 16 ms, capped at 25; stationary below 0.02 px/ms; acceleration damping 0.5; displacement clamp `1.5 × |v| × H`; returns `[]` when reversing within the horizon.
- Predicted samples are never baked and never enter `committed` or `finished`.
- WebGPU init: device, shader compilation and pipeline creation all complete **before** `getContext('webgpu')`.
- Tests: `python -m pytest tests/ -q` runs every layer. `wait_for_function` takes arrow-function strings (the CSP forbids eval).
- Do not change `/write`, storage, PDF export or YouTube behaviour.

## File Structure

| Path | Responsibility |
|---|---|
| `static/js/inklab/ring-buffer.js` | SPSC ring over a `SharedArrayBuffer` |
| `static/js/inklab/stroke-width.js` | Brush width reference |
| `static/js/inklab/predictor.js` | Polynomial predictor, WebNN adapter |
| `static/js/inklab/shaders.js` | WGSL strings |
| `static/js/inklab/canvas2d-renderer.js` | Renderer on OffscreenCanvas 2D |
| `static/js/inklab/gpu-renderer.js` | Renderer on WebGPU, plus `tessellate` seam |
| `static/js/inklab/render-worker.js` | Messages, drain loop, stroke assembly, stats |
| `static/js/inklab/lab-main.js` | Isolation check, allocation, transfer, pointer events, overlay |
| `templates/lab_ink.html` | The page |
| `app.py` (modify) | `url_for` import, scoped isolation headers, `/lab/ink` route |
| `tests/inklab/load.cjs` | Loads IIFE files into a fake `self` in this realm |
| `tests/inklab/*.test.cjs` | Node unit tests |
| `tests/test_inklab_node.py` | Runs the Node tests from pytest |
| `tests/test_inklab_page.py` | Headers (Flask client) and bundled-Chromium page tests |
| `tests/test_inklab_webgpu.py` | System-Chrome WebGPU tests |

---

### Task 1: Ring buffer and the Node test harness

**Files:**
- Create: `static/js/inklab/ring-buffer.js`
- Create: `tests/inklab/load.cjs`
- Test: `tests/inklab/ring_buffer.test.cjs`
- Create: `tests/test_inklab_node.py`

**Interfaces:**
- Produces: `InkLab.RingBuffer = { Flags: {DOWN, MOVE, UP, PREDICTED}, STRIDE: 5, HEADER_SLOTS: 8, DATA_OFFSET: 32, HEAD, TAIL, CAPACITY, OVERFLOW, WAKE, DEFAULT_CAPACITY: 16384, allocate(capacity = 16384) → SharedArrayBuffer, createProducer(sab) → { push(sample) → boolean, notify() → void, overflow() → number }, createConsumer(sab) → { drain(visit(sample)) → number, wake() → number, waitForWork(seenWake) → Promise<string>, overflow() → number } }`. A sample is `{x, y, pressure, time, flags}`.
- Produces: `tests/inklab/load.cjs` exports `loadInkLab(...relativePathsFromRepoRoot) → InkLab`, running each file with `vm.runInThisContext('(function (self) {' + src + '\n})', {filename})` against one shared fake `self`, so values stay in the test's own realm and `deepStrictEqual` works.

- [ ] **Step 1: Write the failing tests** in `ring_buffer.test.cjs`:
  1. `allocate(8)` gives `byteLength === 32 + 8 * 5 * 8` and `CAPACITY` slot `=== 8`.
  2. Pushed samples drain in FIFO order with every field equal.
  3. Wraparound: for capacities 4, 5 and 8, three rounds of push-then-drain, each round `capacity − 1` samples, keep FIFO order.
  4. Full ring: `capacity − 1` pushes return `true`, the next returns `false`, `overflow() === 1`, and draining returns the first `capacity − 1` samples unchanged.
  5. Round-trip of every flag (1, 2, 4, 8) with fractional `time`, `pressure` 0 and 1, negative `x`.
  6. `createProducer(sab)` and `createConsumer(sab)` on the same buffer see each other's writes.
  7. `notify()` increments `wake()` by 1.
  8. `waitForWork(staleSeenWake)` resolves `'not-equal'`.
- [ ] **Step 2: Run to verify failure** — `node --test tests/inklab/ring_buffer.test.cjs`. Expected: FAIL, `ring-buffer.js` not found.
- [ ] **Step 3: Implement** `ring-buffer.js` per spec §8, and `tests/test_inklab_node.py`: skip unless `shutil.which("node")`; glob `tests/inklab/*.test.cjs` sorted; `subprocess.run(["node", "--test", *files], capture_output=True, text=True, timeout=180)`; assert `returncode == 0`, putting stdout and stderr in the failure message.
- [ ] **Step 4: Run to verify pass** — `node --test tests/inklab/ring_buffer.test.cjs`, then `python -m pytest tests/test_inklab_node.py -q`. Expected: PASS.

---

### Task 2: Brush width reference, pinned to `canvas.js`

**Files:**
- Create: `static/js/inklab/stroke-width.js`
- Test: `tests/inklab/stroke_width_parity.test.cjs`

**Interfaces:**
- Consumes: `tests/inklab/load.cjs`.
- Produces: `InkLab.StrokeWidth = { BASE_SIZE: 4, brushWidth(points, index, baseSize) → number }`.

- [ ] **Step 1: Write the failing tests.** Extract `__clamp`, `__pointPressure`, `__segmentSpeed` and `__penSegmentWidth` from the real `static/js/canvas.js` by locating `function <name>(` and matching braces from the first `{`. Build them with `vm.runInThisContext`.
  1. Extraction found all four functions (fails loudly if `canvas.js` is refactored).
  2. For `baseSize` in 2, 4 and 9.5, and for each stroke below, every index satisfies `assert.strictEqual(brushWidth(points, i, baseSize), __penSegmentWidth('brush', baseSize, points, i))`:
     - a 40-point stroke with varying pressure and increasing times;
     - duplicate timestamps (interval 0);
     - decreasing timestamps (negative interval);
     - points with no `time` (undefined → `NaN` intervals);
     - points with no `pressure`;
     - a single point; two points.
- [ ] **Step 2: Run to verify failure** — `node --test tests/inklab/stroke_width_parity.test.cjs`. Expected: FAIL, `stroke-width.js` not found.
- [ ] **Step 3: Implement** `stroke-width.js` as a literal port of spec §11.1, preserving the source's operation order.
- [ ] **Step 4: Run to verify pass** — the same command. Expected: PASS.

---

### Task 3: The isolated page, the worker and the Canvas2D renderer (step 1)

**Files:**
- Modify: `app.py` — add `url_for` to the `flask` import; in `set_security_headers` add both isolation headers when `request.path` starts with `/lab/` or `/static/js/inklab/`; add route `/lab/ink`.
- Create: `templates/lab_ink.html`
- Create: `static/js/inklab/lab-main.js`
- Create: `static/js/inklab/render-worker.js`
- Create: `static/js/inklab/canvas2d-renderer.js`
- Test: `tests/test_inklab_page.py`

**Interfaces:**
- Consumes: `InkLab.RingBuffer`, `InkLab.StrokeWidth`.
- Produces — route: `lab_ink()` renders `lab_ink.html` with `config = {"worker": url_for(render-worker.js), "scripts": [url_for(name) for name in INKLAB_WORKER_SCRIPTS]}`, where `INKLAB_WORKER_SCRIPTS` is a module-level tuple, `("ring-buffer.js", "stroke-width.js", "canvas2d-renderer.js")` in this task. The template emits it with `|tojson` in `<script id="inklabConfig" type="application/json">`.
- Produces — `InkLab.Canvas2DRenderer.create() → renderer`, where `renderer = { name: 'canvas2d', init(canvas, size, ink, baseSize) → Promise<void>, resize(size, finished), drawFrame(committed, provisional), bake(committed), clear(), snapshot() → Promise<{inked, bbox}> }`, `size = {width, height, dpr}`, `ink = [r, g, b, a]` premultiplied in 0–1, `bbox = {left, top, right, bottom} | null` in device px.
- Produces — worker messages per spec §14. `render-worker.js` loads `config.scripts` with `importScripts` on `init`. The frame scheduler is `self.requestAnimationFrame` where it exists; a 250 ms watchdog switches to `setTimeout(tick, 16)` if no animation-frame callback has arrived.
- Produces — page API `window.InkLab.lab = { ready: Promise<{backend, fallbackReason}>, pushSample(sample) → boolean, notify(), snapshot() → Promise<snapshot>, tessellate(samples, baseSize) → Promise<result>, stats }`.

- [ ] **Step 1: Write the failing tests** in `tests/test_inklab_page.py`.
  - `InkLabHeaderTests` (Flask test client):
    1. `/lab/ink` → 200 with COOP `same-origin` and COEP `require-corp`.
    2. `/static/js/inklab/render-worker.js` → 200 with both headers.
    3. `/write` → 200 with neither header.
    4. `/static/js/core.js` → 200 with neither header.
    5. `/lab/ink` HTML has no `src=` or `href=` pointing at `http://` or `https://`.
  - `InkLabPageTests` (bundled Chromium, headless, viewport 1000 × 700):
    1. `crossOriginIsolated === true`; `lab.ready` resolves `backend === 'canvas2d'` with a non-empty `fallbackReason`.
    2. Inject `DOWN` at (100, 300), 40 `MOVE` samples to (400, 320) at 8 ms intervals, `UP`; notify; poll `snapshot()` until `finishedStrokes === 1` (5 s limit). Assert `inked > 500`, `overflow === 0`, `bbox !== null`.
    3. **Predictions never baked:** stroke A as above, with 3 `PREDICTED` samples at y + 200 injected after every tenth `MOVE`; snapshot; `clear`; stroke B identical without them; snapshot. Assert identical `inked` and `bbox`.
    4. After a stroke, `clear` then `snapshot()` gives `inked === 0`.
- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_inklab_page.py -q`. Expected: FAIL, `/lab/ink` 404.
- [ ] **Step 3: Implement** `app.py`, `lab_ink.html`, `lab-main.js` (isolation check, ring allocation, canvas transfer, `init`, `ready`, request/response by id, `ResizeObserver`, Clear, stats overlay, test seams — no pointer events yet), `render-worker.js` (spec §10 without the predictor branch: `provisional` is `pendingPredicted` with source `native`, else `[]` with source `none`) and `canvas2d-renderer.js` (spec §12.2). Backend selection in this task is always Canvas2D, with `fallbackReason = 'WebGPU renderer not loaded'`.
- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_inklab_page.py -q`. Expected: PASS. **Checkpoint:** if test 2 times out with `frames === 0`, the worker is not getting animation frames; confirm the watchdog switched to `setTimeout`.

---

### Task 4: The WGSL compute tessellator (step 2)

**Files:**
- Create: `static/js/inklab/shaders.js` (`TESSELLATE` in this task)
- Create: `static/js/inklab/gpu-renderer.js` (device creation and `tessellate` in this task)
- Modify: `static/js/inklab/render-worker.js` — handle `tessellate`
- Modify: `app.py` — `INKLAB_WORKER_SCRIPTS` += `"shaders.js"`, `"gpu-renderer.js"`
- Test: `tests/test_inklab_webgpu.py`

**Interfaces:**
- Consumes: `InkLab.StrokeWidth.brushWidth`.
- Produces: `InkLab.Shaders = { TESSELLATE: string }`. Bindings: `@group(0) @binding(0) var<uniform> params : Params`, `@binding(1) var<storage, read> samples : array<vec4<f32>>`, `@binding(2) var<storage, read_write> segments : array<Segment>`. `Params` is 48 bytes: `count: u32, baseSize: f32, dpr: f32, _pad0: f32, viewport: vec2<f32>, _pad1: vec2<f32>, ink: vec4<f32>`. `Segment` is 64 bytes: `c0, c1, c2, c3: vec2<f32>, a: vec2<f32>, b: vec2<f32>, ra: f32, rb: f32, _pad: vec2<f32>`.
- Produces: `InkLab.GpuRenderer.create({gpu}) → renderer` with `name: 'webgpu'` and `tessellate(samples, baseSize, dpr) → Promise<{dpr, gpuRadii: Array<[ra, rb]>, jsWidths: number[]}>`. It requests a device lazily and never touches a canvas.

- [ ] **Step 1: Write the failing tests** in `tests/test_inklab_webgpu.py`: launch `chromium.launch(channel='chrome', headless=True)`, and `skipTest` with the exception if that fails. Open `/lab/ink` and await `ready`.
  1. `lab.tessellate(samples, 4)` on 12 samples with numeric pressures from 0.2 to 0.9, increasing times including one duplicate timestamp, and a zero-length segment. If the result's `backend !== 'webgpu'`, `skipTest` naming the reason. Otherwise, for every segment `k`: `gpuRadii[k][0] * 2 / dpr ≈ jsWidths[k]` and `gpuRadii[k][1] * 2 / dpr ≈ jsWidths[k + 1]`, within relative 1e-4.
- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_inklab_webgpu.py -q`. Expected: FAIL, `tessellate` unsupported.
- [ ] **Step 3: Implement** the compute shader per spec §12.1 (including `select(dt, 16.0, dt == 0.0)` and `remaining` from `count`); `gpu-renderer.js` device creation with `getCompilationInfo` checks and `createComputePipelineAsync`, and `tessellate`, which uploads `(x, y, pressure, time − t0)`, dispatches `ceil((count − 1) / 64)`, copies `segments` to a `MAP_READ` buffer and reads `ra` and `rb` at offsets 48 and 52 of each 64-byte record. In the worker, `tessellate` uses the GPU renderer when loaded and replies with `backend` and the result, or with `{backend: 'canvas2d', jsWidths}` if no device.
- [ ] **Step 4: Run to verify pass** — the same command. Expected: PASS, or SKIP stating why. Then re-run `tests/test_inklab_page.py`; expected PASS.

---

### Task 5: The WebGPU render pipeline (step 3)

**Files:**
- Modify: `static/js/inklab/shaders.js` — add `STROKE`, `BLIT`
- Modify: `static/js/inklab/gpu-renderer.js` — `init`, `resize`, `drawFrame`, `bake`, `clear`, `snapshot`, device-loss handling
- Modify: `static/js/inklab/render-worker.js` — backend selection; `needCanvas` / `replaceCanvas`
- Modify: `static/js/inklab/lab-main.js` — answer `needCanvas`
- Test: `tests/test_inklab_webgpu.py`

**Interfaces:**
- Consumes: `InkLab.Shaders.TESSELLATE`, the renderer interface from Task 3.
- Produces: `InkLab.Shaders.STROKE` — vertex stage reads `segments` as `var<storage, read>` and emits corner `vertex_index`; fragment stage computes capsule coverage from `@builtin(position)`. `InkLab.Shaders.BLIT` — fullscreen triangle with `textureLoad` of the baked texture. The full GPU renderer implements the Task 3 interface, plus `onDeviceLost(callback)`.
- Produces: the worker tries `GpuRenderer.init` first and records the rejection text as `fallbackReason` before initialising Canvas2D.

- [ ] **Step 1: Write the failing tests**, added to `tests/test_inklab_webgpu.py` (skip as in Task 4 when `ready.backend !== 'webgpu'`):
  1. `ready.backend === 'webgpu'` and `fallbackReason` is empty.
  2. The Task 3 injected stroke gives `finishedStrokes === 1` and `inked > 500` from the baked texture.
  3. `clear` then `snapshot()` gives `inked === 0`.
- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_inklab_webgpu.py -q`. Expected: FAIL, backend is `canvas2d`.
- [ ] **Step 3: Implement** spec §12.1 and §12.3 in the initialisation order it requires. Two render pipelines draw strokes, one targeting the canvas format and one targeting `rgba8unorm`, both blending with `operation: 'max'`, `srcFactor: 'one'`, `dstFactor: 'one'` for colour and alpha. The blit pipeline targets the canvas format. `snapshot` pads `bytesPerRow` to a multiple of 256.
- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_inklab_webgpu.py tests/test_inklab_page.py -q`. Expected: PASS (or GPU tests SKIP stating why); page tests still see `canvas2d` with the real device-failure reason.

---

### Task 6: Pointer events into the ring (step 4)

**Files:**
- Modify: `static/js/inklab/lab-main.js`
- Test: `tests/test_inklab_page.py`

**Interfaces:**
- Consumes: `producer.push`, `producer.notify`, `Flags`.
- Produces: `pointerdown` / `pointermove` / `pointerup` / `pointercancel` handlers on the canvas, per spec §9.

- [ ] **Step 1: Write the failing test** in `InkLabPageTests`:
  1. A real synthetic stroke — `page.mouse.move(150, 300)`, `down()`, `move(450, 340, steps=30)`, `up()` — then polling `snapshot()` until `finishedStrokes === 1` gives `inked > 500`, `overflow === 0`, and a `bbox` whose left and right edges are within 20 device px of 150 × dpr and 450 × dpr.
- [ ] **Step 2: Run to verify failure** — `python -m pytest tests/test_inklab_page.py -q -k synthetic`. Expected: FAIL, the poll times out with `finishedStrokes === 0`.
- [ ] **Step 3: Implement** the handlers: primary pointer only; `setPointerCapture`; coalesced events as `MOVE`, predicted events as `PREDICTED`; one `notify` per event.
- [ ] **Step 4: Run to verify pass** — `python -m pytest tests/test_inklab_page.py -q`. Expected: PASS.

---

### Task 7: Polynomial predictor and the WebNN hook (step 5)

**Files:**
- Create: `static/js/inklab/predictor.js`
- Test: `tests/inklab/predictor.test.cjs`
- Test: `tests/inklab/neural_hook.test.cjs`
- Modify: `static/js/inklab/render-worker.js` — provisional selection `native → webnn → polynomial → none`
- Modify: `app.py` — `INKLAB_WORKER_SCRIPTS` += `"predictor.js"`
- Test: `tests/test_inklab_page.py`

**Interfaces:**
- Produces: `InkLab.Predictor = { MAX_HORIZON_MS: 25, predict(committed, horizonMs = 16) → sample[], createNeural({ml, model}) → null | { predict(history, horizonMs = 16) → Promise<sample[] | null> } }`. `model(context, history) → Promise<Array<{x, y}>>`.

- [ ] **Step 1: Write the failing tests.**
  - `predictor.test.cjs`:
    1. Constant velocity (x = 0.5 t, y = 0.25 t; times 0, 7, 16, 24): prediction points lie exactly on the line at `t3 + 8` and `t3 + 16`.
    2. Constant acceleration with irregular intervals: output equals the damped formula computed independently in the test.
    3. Stationary (four identical points) → `[]`.
    4. Reversal within the horizon (moving right, decelerating hard enough that `dot(v, v + a'H) ≤ 0`) → `[]`.
    5. A fast tight curve never exceeds `1.5 × |v| × H` in displacement.
    6. A zero or negative interval → `[]`.
    7. Three samples → `[]`.
    8. `horizonMs = 100` behaves as 25.
    9. Outputs carry `flags === PREDICTED`, the last sample's `pressure`, and `time = s3.time + tau`.
  - `neural_hook.test.cjs`:
    1. `createNeural({model})` with no `ml` → `null`.
    2. `createNeural({ml})` with no model → `null`.
    3. A mock model returning `[{x, y}, {x, y}]` → two samples with `flags === PREDICTED`, times spaced evenly across the horizon, and pressure from the last history sample.
    4. A throwing model → `null`; a rejecting model → `null`.
    5. A model returning a non-finite coordinate → `null`.
    6. `ml.createContext` is called once across three predictions.
  - `InkLabPageTests`:
    1. Inject `DOWN` plus 8 `MOVE` samples at constant velocity and no `UP`; poll `snapshot()` until `predictionSource !== 'none'` (2 s limit); assert it is `'polynomial'`.
- [ ] **Step 2: Run to verify failure** — `node --test tests/inklab/predictor.test.cjs tests/inklab/neural_hook.test.cjs`. Expected: FAIL, `predictor.js` not found.
- [ ] **Step 3: Implement** spec §11.2, and the worker's selection with at most one neural inference in flight, a result used only while its tagged sample is still the newest committed one, and the hook built from `self.navigator.ml` with no model.
- [ ] **Step 4: Run to verify pass** — the Node command, then `python -m pytest tests/test_inklab_node.py tests/test_inklab_page.py -q`. Expected: PASS.

---

### Task 8: Verification and records

**Files:**
- Modify: `TODOS.md` — one item: measure InkLab on the target tablet, and what a port into `/write` would need (spec §16).
- Modify: `CLAUDE.md` — the test baseline figure.

- [ ] **Step 1:** `python -m pytest tests/test_inklab_node.py tests/test_inklab_page.py tests/test_inklab_webgpu.py -v`. Expected: all pass; GPU tests pass here (system Chrome has a device).
- [ ] **Step 2:** `python -m pytest tests/ -q`. Expected: 0 failed, and the passed count equals 178 plus every InkLab test.
- [ ] **Step 3:** Record the measured baseline in `CLAUDE.md` and the open item in `TODOS.md`.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §6 isolation and routing | 3 |
| §7 components and renderer interface | 1, 2, 3, 4, 5, 7 |
| §8 ring protocol | 1 |
| §9 pointer capture | 6 (seams in 3) |
| §10 drain loop, waking, invariant | 3, 7 |
| §11.1 width | 2 |
| §11.2 predictor, WebNN hook | 7 |
| §12.1 WebGPU (compute) | 4 |
| §12.1 WebGPU (render, bake, snapshot) | 5 |
| §12.2 Canvas2D | 3 |
| §12.3 backend choice, device loss | 5 |
| §13 stats and latency | 3 |
| §14 errors and messages | 3, 4, 5 |
| §15.1 Node tests | 1, 2, 7 |
| §15.2 bundled Chromium tests | 3, 6, 7 |
| §15.3 system Chrome tests | 4, 5 |

Not covered by an automated test, by design of the spec: device loss (§12.3) — implemented, and reported as untested. Latency figures (§15.4) — reported, not claimed.


---

## Execution notes (2026-09-13)

All eight tasks were done in order, test-first: every test was run and seen to
fail for the stated reason before its implementation was written.

**Departures from the tasks as written**

- Browser-test helpers moved to `tests/inklab_helpers.py`, following the repo's
  `pdf_quality.py` pattern, once two test files needed them.
- The page API gained `lab.clear()` and `lab.errors`.
- A header test first passed against a 404 page; it now asserts the 200.
- The GPU render tests (Task 5) would have passed on Canvas2D before any GPU
  rendering existed. They now probe for a device with `tessellate` and fail - not
  skip - if a device exists but drawing fell back.
- The Task 7 page test was added only after Task 6 was green, so it could not
  turn Task 6's run red.
- Two gaps found by the completion checklist and closed: WebGPU validation errors
  are now surfaced (spec section 17), and a screenshot test per backend checks
  what actually reaches the screen.

**Mutation verification.** Passing tests prove nothing until they are seen to
fail. Each check below breaks the behaviour a test guards, runs that test, and
restores the source byte for byte.

| Behaviour broken | Test | Result |
|---|---|---|
| Canvas2D live stroke not drawn | screen test, Canvas2D | caught: "a stroke still being drawn did not reach the screen" |
| Canvas2D baked layer not drawn | screen test, Canvas2D | caught: "a finished stroke did not reach the screen" |
| WebGPU live stroke not drawn | screen test, WebGPU | caught: "a stroke still being drawn did not reach the screen" |
| WebGPU baked layer not drawn | screen test, WebGPU | caught: "a finished stroke did not reach the screen" |
| Predicted samples committed | predictions never baked | caught: inked 7402 != 1442 |
| JS brush formula 1.95 -> 1.96 | JS width parity | caught at `regular, baseSize 2, index 1`; only the parity test failed |
| WGSL brush formula 1.95 -> 1.96 | WGSL width parity | caught: GPU 0.87696 vs JS 0.8748 |
| Invalid WebGPU bind group, every frame | baked stroke on WebGPU | before the fix: passed (swallowed); after: caught, `WebGPU: Number of entries (0) did not match` |

**Still untested:** recovery from a lost GPU device (rebuild once, then a fresh
canvas in 2D). A device cannot be lost on demand in a test.
