# Editor feedback round — design (2026-09-14)

Eight changes requested by the user in one message, designed and approved the
same day. Each section is self-contained so it can be built independently.
Section numbers match the user's list.

Approved decisions:

- YouTube: **sharp tab capture on desktop Chrome/Edge, storyboard fallback
  everywhere else.**
- Shapes: **full set** — square, ellipse, trapezium, pentagon, hexagon, octagon,
  triangle types as first-class picker buttons, plus fill and dash options.
- After shape assist snaps a drawing: **keep the pen in hand** and offer
  "Edit" on the chip; never switch tools on the writer.
- Everything else as written below.

---

## 0. Rules every change follows

- **The tree is not really under version control.** There is one old commit
  and a very large amount of uncommitted work. Never run a git command that
  changes the working tree (`checkout`, `restore`, `reset`, `stash`, `clean`),
  and do not commit.
- **DESIGN.md governs every visual decision.** Tokens from `tokens.css` only,
  no new `--feature-*` vocabulary; 44px minimum targets via `var(--tap)`;
  Archivo for UI and JetBrains Mono for numbers, with `tabular-nums`; motion
  120–180ms and respect `prefers-reduced-motion`; one accent (ochre), no
  warning colour; the verb is "Tap"; copy spells "Colour". A class that sets
  `display` beats `[hidden]` — add an explicit `.x[hidden]{display:none}`.
- **The target device is a ~960px budget Android tablet.** Nothing may exist
  only above 1180px. Verify at 960x720 as well as 1440x900.
- **Browser tests** start their server with `make_browser_server(app)` from
  `tests/browser_server.py`, dismiss the tour with
  `localStorage['inkyscib-feature-tour-v1']` in an `add_init_script`, pass
  `wait_for_function` an arrow function, never wait for `#chromeTriggers`
  children to be visible, and pin `locale="en-US"` when asserting dates.
- **Measure, then assert.** Every "better" below has a number, and every test
  should fail on the old code.

## File ownership

Parallel work shares some files. Each change edits only its own regions; if an
edit fails because the file changed underneath, re-read and retry. DESIGN.md is
updated once at the end from each change's report.

| Change | Owns |
|---|---|
| 1 YouTube | `app.py` YouTube section and a new outbound-TLS helper; `static/js/youtube.js`; `.yt-*` rules in `write.css`; `tests/test_youtube_search.py`; new `tests/test_youtube_capture.py` |
| 2 Pomodoro | `static/js/pomodoro.js`; new `static/css/pomodoro.css` (the `.pomo-*` block moves out of `write.css`); the `fa-cog` entry in `icons.js`; new `tests/test_pomodoro.py` |
| 3 Canvas themes | new `static/js/canvas-theme.js` and `static/css/canvas-theme.css`; `write.html` pre-paint script, pattern control + theme button, bottom pattern script; `canvas.js` grid/background functions and background cache key; `notebook.js themeColors`; `core.js setTheme`; `ui.js` theme toggle; `storage.js` theme preference lines; ground rules in `write.css`/`editor-chrome.css`; `construction-render.js` light check; new `tests/test_canvas_theme.py` |
| 4 Shape assist toggle | `write.html` `.bar-work` and the pen panel's snap switch; `static/js/handwriting.js`; `events.js endDrawing`; `static/css/write-assist.css`; `.bar-work` rules in `editor-chrome.css`; `tests/test_write_assist.py` |
| 5+6 File rail, panel close | `static/js/file-ribbon.js`, `file-ribbon.css`; `static/js/tool-dock.js`; dock header rules in `editor-chrome.css`; `.tool-options` rules in `write.css`; `onboarding.js` only if it targets rail tabs; `tests/test_file_ribbon.py`; rail navigation in `tests/test_planner.py`; new `tests/test_tool_panel_close.py` |
| 7 Write assist | new `static/js/ink-smooth.js`; `events.js` lines ~96-195 (`INK_SMOOTHING`, `appendInkPoint`, `finishInkInput`); the live-stroke region of `canvas.js`; `tools/pen.js initInkSmoothing`; pen panel smoothing copy in `write.html`; `tests/test_pen_smoothing.py`; new `tests/test_ink_smoothing.py` |
| 8a Shape geometry | `geometry.js`; `tools/select.js`; `storage.js` shape serialisation; `pdf-vector.js`; `core.js createPath` + shape defaults; `events.js` draft helpers (~199-235); `ar.js` draft helpers; `construction.js` intersections; `canvas.js` eraser + shape dispatch; `tests/test_smart_geometry.py`; new `tests/test_shape_kinds.py` |
| 8b Shape picker | `write.html` `#shapeTool` and `#shapeOptions`; `tools/shape.js`; new `static/css/shape-picker.css` and shape-tool rules in `write.css`; new `tests/test_shape_picker.py` |

The `<link>`/`<script>` tags for the new files are already in `write.html`.

---

## 1. YouTube frame capture

**Symptom:** "Save frame" always places the video's thumbnail.

**Measured causes (both fall through to a silent `maxresdefault.jpg`):**

1. `GET /api/youtube/storyboard` returns 502 on the user's PC. Avast's HTTPS
   scanning re-signs `*.google.com` with "Avast Web/Mail Shield Root", whose
   Basic Constraints extension is not marked critical. Python 3.14 / OpenSSL
   3.5 sets `VERIFY_X509_STRICT` by default and rejects it. Clearing only that
   flag fetched the watch page (1.3 MB) and its storyboard spec. In-app search
   fails the same way.
2. Even with the spec, the sprite sheets on `i.ytimg.com/sb/...` are served
   **without `Access-Control-Allow-Origin`** (checked: 200, `image/webp`,
   `Cross-Origin-Resource-Policy: cross-origin`, no ACAO). The client loads them
   with `crossOrigin="anonymous"`, which fails.

**Design:**

- One outbound TLS context for every server-side fetch:
  `ssl.create_default_context()` with `verify_flags &= ~ssl.VERIFY_X509_STRICT`.
  Chain verification and hostname checking stay on (`CERT_REQUIRED`,
  `check_hostname=True`). Used by search and storyboard.
- New endpoint `GET /api/youtube/frame?v=<11-char id>&t=<seconds>` returns
  `{videoId, image: "data:image/jpeg;base64,...", width, height, frameTime,
  source: "storyboard"}`. It picks the highest-resolution storyboard level with
  a positive interval, maps `t` to the nearest cell, fetches the sheet
  server-side (cached, bounded), crops with Pillow and encodes JPEG. 400 on a
  bad id or time, 404 when the video has no storyboard, 502 on upstream
  failure, each with `{error}`. Only URLs derived from the parsed spec on
  `i.ytimg.com` are ever fetched — never a URL from the request.
- **Sharp capture** where the browser supports it (`getDisplayMedia` plus
  Region Capture, i.e. desktop Chrome/Edge): capture this tab with
  `preferCurrentTab`, crop the track to the player iframe, grab one frame at
  full resolution *before* pausing (paused YouTube draws its own overlay), and
  keep the stream only while the player is open so the browser asks once per
  session; stop it on close and handle the user ending the share. If the API
  is missing, the prompt is refused, or cropping fails, fall back to the
  storyboard endpoint without a second prompt.
- **No thumbnail fallback.** If neither path yields a frame, show an error
  toast that says why; never insert the thumbnail as if it were the frame.
- The toast after a storyboard capture says it is YouTube's preview frame, so a
  soft 320x180 image is not mistaken for a bug.

**Acceptance:** endpoint unit tests with a synthetic sprite sheet (correct cell
for a given time and interval, bounds clamped, bad input rejected, no
request-controlled URL); TLS context test (strict flag off, chain and hostname
checks on); a browser test proving `saveCurrentFrame` inserts the image served by
`/api/youtube/frame` and never requests `i.ytimg.com/vi/*default.jpg`; a browser
test with a stubbed `getDisplayMedia`/`CropTarget` proving the sharp path is used
when available and the storyboard path when it is refused.

## 2. Pomodoro

**Settings icon:** `icons.js` draws `fa-cog` as a circle with eight rays — a
sun. Redraw as a toothed gear. Check every other `fa-cog` use.

**Layout:** today's panel is seven rows (header with three icon buttons, tabs,
ring, controls, presets, task field, sounds, stats). The main view keeps:
header (title, gear, close), mode tabs, timer ring, Start/Pause with reset and
skip, the "What are you working on?" field, and **one** sound row
(Off / Rain / Deep sea / Clock + volume). Presets, the three durations, cycle
length, both auto-starts and the chime on/off move behind the gear. Stats become
one quiet line. Per-mode green/amber accents go (one accent). Every control is
44px. Keep the store format (`inkyscib-pomodoro-v2`), the pill, notifications,
keyboard shortcuts and `#pomodoroBtn`/`#pomodoroModal`/`#floatingTimer`.
`tests/test_planner.py` asserts the focus prompt stays.

**Rain:** today is white noise band-passed 320–1150 Hz with a 0.11 Hz filter
drift. Its 50 ms loudness envelope varies by 0.08 (coefficient of variation) —
flat, which is why it reads as static. Rebuild as a pre-rendered, seamlessly
looping stereo buffer: a band-limited noise bed with slow gusts, dense light
drops, and sparse heavier drops (short filtered noise bursts at random pitch,
level and stereo position). Render off the main thread (OfflineAudioContext) and
lazily on first use; no main-thread task over 50 ms.

**Deep sea:** today is brown noise low-passed at 420 Hz. Almost all of its
energy sits below what tablet and laptop speakers reproduce, so it is
effectively silent there. Rebuild as ocean swell: low-mid noise (roughly
150–1800 Hz) under an 8–12 s wave envelope with a soft rumble.

**Loudness:** measure each sound through a small-speaker proxy (two 300 Hz
high-pass biquads and an 8 kHz low-pass) and normalise so Rain and Deep sea
match. **Acceptance** (tests render through an exported builder in an
OfflineAudioContext): Rain and Deep sea within 2 dB of each other at the same
volume; Rain's 10 ms envelope variation and Deep sea's 500 ms envelope variation
each clearly above the old sounds' values in the same metric (measure the old
values first and record them); Clock clearly audible; the gear icon is a gear
(it has teeth); main view has no preset or duration controls; all controls
≥44px at 960x720.

## 3. Canvas theme presets

The theme button becomes a **Canvas** popover holding eight presets and the
existing pattern choice (dot / lines / graph), replacing `#patternBtn`.

| id | label | chrome | ground | default ink |
|---|---|---|---|---|
| graphite | Graphite | dark | today's dark stage | `#ffffff` |
| paper | Paper | light | today's light stage | `#1b1b18` |
| chalkboard | Chalkboard | dark | deep green-black | `#ffffff` |
| blueprint | Blueprint | dark | deep blue, pale-cyan grid | `#ffffff` |
| midnight | Midnight | dark | navy-black | `#ffffff` |
| cream | Cream | light | warm ivory, brown-grey grid | `#1b1b18` |
| whiteboard | Whiteboard | light | pure white, light grey grid | `#1b1b18` |
| contrast | High contrast | dark | black, bright grid | `#ffffff` |

- A preset sets `html[data-canvas]` and `html[data-theme]` (chrome stays light or
  dark per DESIGN.md), the stage ground, the grid colours, notebook page colours
  and the ground-dependent colours canvas code picks by lightness today (labels,
  placeholders, construction marks). Route those through one
  `Inkyscib.CanvasTheme` API rather than scattered `dataset.theme` checks.
- Stamp `data-canvas` before first paint alongside `data-theme`.
- Default pen swap: only the two defaults swap, now on **every** preset change
  (today the toggle never calls the swap).
- Persist as `inkyscib-canvas-theme` and in preferences. With nothing stored,
  derive from the stored `theme` (dark → graphite, light → paper) or the OS.
- Background cache key includes the preset.
- Exports stay as they are (PNG white paper, slides white).
- **Acceptance:** eight presets; choosing one changes the stage's computed
  background, the pixels of the grid on `#patternCanvas`, notebook page colour,
  `data-theme`, and the default pen; it survives reload; the pattern choice still
  works from the popover; default ink contrast against every ground ≥ 7:1; every
  option ≥44px at 960x720; Escape and outside tap close it.

## 4. Shape assist toggle in the top bar

- Top bar work zone becomes **Undo · Redo · Shape assist · divider · Clear**.
  Icon-only `tool` button with `aria-pressed`, accent when on, title
  "Shape assist". The pen panel switch shows the same setting (renamed "Shape
  assist"); one source of truth, the existing localStorage key.
- **On:** a closed outline becomes a real geometry shape. **Off:** every stroke
  stays ink (handwriting tidy still follows the pen's smoothing setting).
- **Keep the pen.** `endDrawing` must not call `SmartGeometry.afterPathCreated`
  for a shape produced by assist (reproduced: drawing a circle with the pen
  switched `currentTool` from `pen` to `select`).
- The chip reads "Circle · Edit · Keep as ink". Edit selects the shape and opens
  its settings (that is what `afterPathCreated` does — call it there). Keep as
  ink reverts. 44px buttons.
- `promote()` is written generically (circle-like: centre + radii; polygon-like:
  kind + vertices) so the new kinds from section 8 can be recognised later
  without restructuring.
- **Acceptance:** button sits between `#redoBtn` and the divider in DOM order;
  ≥44px at 960x720; toggling it flips the pen panel switch and vice versa; off →
  a drawn circle stays `pen`; on → it becomes `shape` and `currentTool` stays
  `pen`; Edit switches to select with that shape selected; Keep as ink restores
  the original points exactly.

## 5. File menu duplicates

The File backstage rail lists File, Insert, Export, Tools, Recent; Insert, Export
and Tools are also the ribbon's own tabs. The rail keeps **File** and **Recent**
only, and is hidden when the panel was opened from Insert, Export or Tools.
Tests that navigated through `[data-rail-tab="insert|export|tools"]` switch to
the ribbon tabs.

## 6. A close button on every tool panel

One 44px × button in the panel header, for all eight panels (pen, eraser,
highlighter, shape, algebra tiles, compass, angle, line), in both the docked
layout (≥1180px, `#toolDock` header) and the floating layout (<1180px, injected
once per `.tool-options` panel by `tool-dock.js`). Closing hides the panel and
leaves the tool selected; focus returns to the tool button;
`aria-label="Close <Tool> options"`. Works for the sticky compass and angle
panels. **Acceptance:** for each panel at 960x720 and 1440x900 — open, tap ×,
panel not displayed (computed), tool unchanged, button ≥44px.

## 7. Write assist

**Measured baseline** — synthetic stroke, 220 samples at 250 Hz, 420px wide,
two superposed sine waves, 1.6px jitter plus a 10 Hz tremor (touch: 3.2px),
driven through `Inkyscib.Events.startDrawing/continueDrawing/endDrawing`. The
setting is `toolSettings.pen.smoothing`.

| pointer:mode | live lag (mean px) | end gap px | RMS from intended curve | wobble (turn jitter) |
|---|---|---|---|---|
| pen:off | 0 | 0 | 0.82 | 0.43 |
| pen:natural | 9.7 | 10.7 | 1.63 | 0.079 |
| pen:strong | 15.7 | 17.9 | 3.13 | 0.070 |
| touch:off | 0 | 0 | 1.16 | 0.90 |
| touch:natural | 9.3 | 10.2 | 1.55 | 0.089 |
| touch:strong | 14.9 | 17.2 | 3.01 | 0.091 |

The intended curve's own turn jitter is 0.055. So "natural" trades wobble for
lag, cut curves and a stroke that stops ~11px short of the lift point (the
catch-up in `finishInkInput` runs for the mouse only) — it ends further from the
intended line than no assist.

**Design:**

- **Live:** ink stays under the nib. A properly lag-compensated adaptive filter
  and/or drawing the live span through to the latest raw sample (display only,
  never stored), with no overshoot beyond where the pen went.
- **On lift:** zero-phase smoothing of the whole stroke in arc-length space
  (e.g. forward-backward or a Gaussian kernel on a resampled copy mapped back to
  the original samples so time and pressure survive), strength by setting, both
  endpoints pinned to the true pen-down and pen-up positions for every pointer
  type, bounded deviation from the raw stroke. Pressure smoothed the same way so
  width does not flicker. Runs before handwriting.js's recognition and tidy.
- Off stays exactly raw.
- **Acceptance** (pen and touch, same harness): off unchanged; natural and strong
  — mean live lag ≤ 1.5px, end gap ≤ 0.5px, RMS from intended curve below the
  raw input's, wobble ≤ 0.08 (natural) and ≤ 0.07 (strong); the existing mouse,
  write-assist, render-latency and tidy-bound tests still pass; lift smoothing ≤
  2ms for a 500-point stroke at 1x CPU.

## 8. Shape tool

**Kinds** (`toolSettings.shape.shapeType`): `circle`, `ellipse`, `triangle`,
`square`, `rectangle`, `parallelogram`, `rhombus`, `kite`, `trapezium`,
`pentagon`, `hexagon`, `octagon`. `triangleType`: `equilateral`, `isosceles`,
`right`, `custom` (scalene, three taps). Each new kind is a real SmartGeometry
object: draft by drag, finalise, vertex/handle editing that keeps its constraint
(square: equal sides and right angles; trapezium: one parallel pair; regular
polygons: equal sides and angles; ellipse: centre, two radii, rotation),
measurements, vertex labels, inspector dimensions, rotation, selection and
hit-testing, eraser, serialisation, and **vector** PDF export. Legacy two-point
`square` paths still load and render.

**Options:** `toolSettings.shape.fill` = `none` | `tint` | `solid`, and
`toolSettings.shape.dash` = `solid` | `dashed` | `dotted`. Stored on each created
path as `fill` and `dash`, editable in the inspector, rendered on canvas and in
vector PDF, serialised.

**Picker (8b):** a labelled grid grouped Round / Triangles / Quadrilaterals /
Polygons. Triangle types are their own buttons. Every icon is drawn to show what
separates it from its neighbours (square vs rhombus vs rectangle, kite vs
rhombus, trapezium vs parallelogram), same stroke weight, name under the icon,
44px targets, active state in the accent. The rail button shows the current
shape. Fill and dash controls sit under the grid.

**Known bug to fix on the way:** `pdf-vector.js shapeOps` exports a smart
rectangle from `points[0]`/`points[1]` as box corners, which is a zero-height
rectangle for `[TL, TR, BR, BL]`; triangle, parallelogram, rhombus and kite fall
back to raster.

**Acceptance:** creating every kind and triangle type through the picker yields
the right kind, vertex count, positive area and inspector title; constraints hold
after dragging each vertex; typed dimensions are exact; fill and dash change
pixels and survive save/load; vector PDF ops exist (no raster fallback) for every
kind; the picker exposes 12 kinds + 4 triangle types with labels, ≥44px, and
distinct icons.

---

## Follow-up after 4 and 8 land

Extend shape assist recognition to `square`, `ellipse` and the regular polygons
only where synthetic false positives on scribbles, arcs, zigzags, letters and
lobed blobs stay at 0.0%.
