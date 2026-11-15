# Editor feedback — implementation report

Spec: `docs/superpowers/specs/2026-09-14-editor-feedback-design.md`
Status as of 2026-09-15: **all eight items built and tested.** One unrelated
bug found along the way (tool preferences were never saved) is fixed too.
The design decisions are recorded in `DESIGN.md` → Decisions Log (2026-09-15).

| # | Request | Status |
|---|---------|--------|
| 1 | YouTube frame capture always saved the thumbnail | Done |
| 2 | Pomodoro: complicated UI, rain not rain, deep sea inaudible, settings icon | Done |
| 3 | Canvas theme presets | Done |
| 4 | Shape assist toggle next to undo/redo, divider before delete | Done |
| 5 | File menu duplicated Insert / Export / Tools | Done |
| 6 | Close button on every tool panel | Done |
| 7 | Write assist not smooth | Done |
| 8 | More shapes, easier to tell apart | Done |
| — | Found: tool preferences never reached storage | Fixed |

---

## 1. YouTube frame capture

**Cause.** A cross-origin player cannot be read from the page, so the old
capture drew YouTube's still thumbnail. The storyboard fallback fetched sprites
the browser was not allowed to read. On this machine every server-side YouTube
fetch also failed: Python 3.14 with OpenSSL 3.5 turns on strict X.509 checks,
which reject the certificate Avast uses to intercept HTTPS.

**Fix (approved option: sharp + fallback).**
- *Sharp:* while the video plays, Save frame asks the browser to share the tab
  (`getDisplayMedia`), crops the stream to the player (Region/CropTarget where
  available), grabs one frame, checks it is not blank, then pauses.
- *Fallback:* if sharing is refused or unavailable, `GET /api/youtube/frame`
  reads the video's storyboard spec, picks the frame nearest the current time,
  crops it from the sprite with Pillow on the server, and returns a JPEG data
  URL. Errors come back as clear 400 / 404 / 502 responses.
- TLS: only the `VERIFY_X509_STRICT` flag is cleared; certificate verification
  stays on.

**Files.** `app.py`, `static/js/youtube.js`. **Tests.** `tests/test_youtube_capture.py`.

## 2. Pomodoro

- The UI is rebuilt as two simple views, timer and settings, on design tokens
  with 44 px targets (`static/js/pomodoro.js`, new `static/css/pomodoro.css`).
  The ~1,000-line old block was removed from `write.css`.
- Ambient sound is synthesised offline and looped without a seam. Rain is
  layered drops and wash; deep sea is shaped low swell, levelled through a
  small-speaker filter so it stays audible on a tablet. A soft limiter prevents
  clipping.
- The settings icon is a toothed gear. Rain and water icons were added (`static/js/icons.js`).

**Tests.** `tests/test_pomodoro.py`.

## 3. Canvas theme presets

- The theme button opens a canvas preset picker. Each preset sets the canvas
  ground, the grid/ruling colour and the chrome theme it pairs with. It is
  applied before first paint, so a reload never flashes.
- Presets are saved with preferences and read by notebook pages, library
  thumbnails and the background cache (`static/js/canvas-theme.js`,
  `static/css/canvas-theme.css`, `canvas.js`, `notebook.js`, `core.js`,
  `storage.js`, `library.js`).

**Tests.** `tests/test_canvas_theme.py`.

## 4. Shape assist toggle

- `#shapeAssistBtn` sits right after Redo in the top bar, then a divider, then
  Clear. It is kept in sync with the pen panel's switch, now labelled
  "Shape assist".
- **On:** a drawn shape snaps to a real shape object, the pen stays selected, and
  a chip offers **Edit** (opens the shape's settings) or **Keep as ink**.
- **Off:** strokes stay handwriting, with no snapping and no tidying.
- Setting smoothing to Off also skips the tidy pass.

**Files.** `templates/write.html`, `static/js/handwriting.js`, `static/js/events.js`, `static/css/write-assist.css`.
**Tests.** `tests/test_write_assist.py`.

## 5. File menu duplicates

The File backstage rail now shows only **File** and **Recent**. Insert, Export
and Tools open from their ribbon tabs only. When one of those tabs opens the
backstage, the rail is hidden (`static/js/file-ribbon.js`, `static/css/file-ribbon.css`).

**Tests.** `tests/test_file_ribbon.py`, `tests/test_planner.py`.

## 6. Close buttons

Every tool panel has a 44 px close button: in its sticky head when floating, in
the dock head when docked (`static/js/tool-dock.js`, `static/css/editor-chrome.css`).

**Tests.** `tests/test_tool_panel_close.py`.

## 7. Smooth handwriting

- New `static/js/ink-smooth.js`: when the pen lifts, the stroke's raw samples are
  smoothed along their length with no phase lag, so ink does not drift behind
  the pen. Corners are detected on a de-jittered copy, so real corners stay
  sharp and tremor is not mistaken for one. Each point's movement is bounded, so
  letters keep their shape, and both ends stay where they were.
- Live ink gets stronger stabilisation, and the nib is drawn at the pen tip, so
  ink stays under the nib (`events.js`, `canvas.js`).

**Tests.** `tests/test_ink_smoothing.py`, plus the render-latency tests.

## 8. Shapes

**The picker.** It used to be seven 32 px icon-only buttons, plus a triangle-type
row that appeared only after picking a triangle. It is now fifteen labelled
buttons in four groups:

| Round | Triangles | Quadrilaterals | Polygons |
|---|---|---|---|
| Circle, Ellipse | Isosceles, Equilateral, Right, Custom | Square, Rectangle, Parallelogram, Rhombus, Kite, Trapezium | Pentagon, Hexagon, Octagon |

Below them are **Fill** (none / tint / solid) and **Outline** (solid / dashed /
dotted). Each icon is drawn once, in a Jinja macro shared by the rail button and
the picker, so the two always match. Each icon draws what sets its shape apart:
ticks on equal sides, a box in the right angle, dots on the corners you place.
Every control is at least 44 px, floating and docked. The rail button shows the
chosen shape, including the triangle type.

**New shape kinds.** Square, trapezium, pentagon, hexagon and octagon are real
geometry objects, with vertices, labels, measurements, handles, the inspector,
and save/load. Squares and regular polygons stay regular when a corner is
dragged; a trapezium keeps its parallel pair.

**The ellipse** is stored as the ends of its two axes. Centre, radii and tilt are
read back from those points, so moving, rotating and stretching it uses the
selection tool's existing code. Dragging an axis end changes only that radius.
The inspector shows semi-axes a and b, perimeter (Ramanujan's approximation)
and area, with typed dimensions.

**Fill and outline** apply on the canvas and in saved documents. On an existing
shape they can be changed from the inspector's new Fill and Outline menus, and
each change is one undo step.

**PDF.** Every smart polygon exports its real corners (before, a smart rectangle
exported with zero height and other polygons fell back to raster). The ellipse
exports as four curves. Fill and dash carry into the PDF: a tint is exported
with real transparency, and if none can be registered the shape falls back to
a picture rather than printing opaque.

**Files.** `templates/write.html`, `static/js/tools/shape.js` (rewritten),
new `static/css/shape-picker.css`, `static/js/geometry.js`, `static/js/tools/select.js`,
`static/js/storage.js`, `static/js/pdf-vector.js`, `static/js/core.js`. The old
`.shapes` / `.shape-btn` / `.triangle-type-btn` rules were removed from
`write.css` and `editor-chrome.css`.

**Tests.** `tests/test_shape_picker.py` (structure, distinct icons, 44 px floating
and docked, taps, reload), `tests/test_shape_style.py` (fill and dash pixels,
save/load, PDF operators, ellipse geometry, axis drags, inspector + undo),
`tests/test_shape_kinds.py`, `tests/test_smart_geometry.py`.

## Found along the way: preferences were never saved

While testing that fill and outline choices survive a reload, nothing did, not
even the chosen shape. `storage.js` declared `function savePreferences()` and
then exported a debounced scheduler under the same name as
`window.savePreferences`. In a plain script those are the same global name, so
the scheduler's timer called the scheduler, which rescheduled itself every 220 ms
and never wrote. The writer is renamed `writePreferences`; every tool's settings
(pen, eraser, highlighter, line, shape, tiles) now persist across reloads.

**Tests.** `tests/test_preferences_save.py`.

## Verification

- Screenshots checked: the picker floating (960 px) and docked (1440 px), the
  rail button, and shapes on the canvas with each fill and outline beside the
  ellipse inspector.
- Full suite (`python -m pytest tests/ -q`), 2026-09-15: **282 passed, 0 failed,
  230 subtests, 8 min 15 s.** The last green run, on 2026-09-14, had 218 tests.

## Known limits

- Shape assist still recognises the shapes it did before; it does not yet snap a
  drawn oval to an ellipse or a drawn hexagon to a hexagon.
- The trapezium has no typed dimensions yet; it is edited by dragging corners.
- The first pan on a slow machine can still spill one frame while the cache warms.
- The smoothing constants were tuned on synthetic pen, mouse and touch strokes,
  not measured on the target tablet.
- The page's CSP blocks the GA4 doubleclick collect request (pre-existing).
