# Six fixes: write lag, shape assist icon, YouTube capture, recents CRUD, lasso eraser, tool panels

Date: 2026-09-17
Status: approved to implement (user dismissed the clarifying questions and said "continue";
recommended option taken on each open decision, recorded in section 0)

Reported, verbatim:

1. The lag in writing is again observable.
2. The shape assist icon should look like a shape assist icon.
3. The youtube capture works in a way that it requests full screen capture then snaps out
   a very low resolution youtube screenshot out of it.
4. The file menu has recents option but there is no option to rename or delete those notebooks.
5. Hold to draw a magnetic lasso is also like an object clearing tool. There should be
   option for object or selection eraser in that.
6. Every tool's sub tool i.e., their dialogue box UI is not interesting. Fix that.

---

## 0. Decisions taken without the user

Four questions were put and dismissed. The recommended option was taken on each:

| Decision | Taken | Why |
|---|---|---|
| Write-lag priority | Shared amplifier first, then per-mode costs | Fixes both Notebook and plain canvas without needing to know which is used |
| YouTube capture | Brief visible player grow | The only fix that raises the actual ceiling; hiding it is more fragile |
| Panel scope | Unify, 960-first | The tablet gap and the duplication are the same bug; fixing one alone leaves the other |
| Recents dialogs | Proper in-app dialogs | Native prompt/confirm cannot be tested and do not match DESIGN.md |

If any of these is wrong, the item is independent and can be redone alone.

---

## 1. Write lag

### What was wrong with the first diagnosis

The investigation reported that the live smoothing filter's "mouse-only catch-up was
deleted", leaving pen and touch lagging. **That reading is wrong and must not be acted on.**
Reading the code:

- The live cutoffs were *raised* from 4.5/2.4 Hz to 11/9.5 Hz precisely to cut the trail
  (`events.js:104-111`).
- The catch-up was *replaced*, not removed: `finishInkInput` rebuilds the stroke from
  `tracker.rawPoints` through `InkSmooth.smoothStroke`, which is symmetric and has no lag,
  so the stroke now ends exactly where the pen lifted (`events.js:192-203`). The old
  catch-up ran for the mouse only and left pen/touch strokes ~11px short.
- A display-only `tip` segment draws the live stroke through to the newest raw sample
  (`canvas.js:668-694`), so the ink reaches the nib.

The live-ink design is sound. The lag is a **throughput** problem, not a filter problem.

### The actual cause

`onPointerRawUpdate` calls `window.renderNow()` on every raw pointer event
(`events.js:583-585`). `renderCanvasNow` cancels any pending rAF and runs the whole frame
synchronously (`canvas.js:2645-2651`). `pointerrawupdate` fires at digitizer rate, so a
240 Hz stylus runs the entire frame function about four times per displayed frame, and a
1000 Hz mouse about sixteen times.

That is deliberate and is what bought sample-to-paint 0.3 ms against 5.1 ms from
`pointermove` (2026-09-14 work). **Coalescing it back to display rate would undo that win
and must not be done.** The fix is to make each live frame cheap.

Per-frame work that a live ink stroke does not need, all inside `renderCanvasFrame`:

| Cost | Where | Why it is safe to skip mid-stroke |
|---|---|---|
| `clampNotebookTransform()` | `canvas.js:2578-2580` | Walks every path via `writtenPageCount` → `pathBounds` (uncached, allocates per path). The transform cannot change during a stroke — there is no pan or zoom with the pen down |
| `ConstructionRender.drawOverlay()` | `canvas.js:2543-2545` | Reaches `signature(list)` (`construction.js:130`), which concatenates a string over every path on every call. Draws compass preview, snap and intersection candidates — none of which change while ink is being laid down |
| `dispatchAppEvent('canvasRendered')` | `canvas.js:2631-2633` | Six listeners, including `updateNotebookUi` (three more full-document scans plus an unconditional `textContent` write) and `units.js` `syncInputs` (`querySelectorAll("[data-unit-name]")` over the whole document). All of it is chrome that cannot change mid-stroke |

Corrected from the investigation: `getCanvasMetrics` is **not** a per-sample cost. It caches
until the next animation frame (`core.js:31-46`), so a burst of `renderNow` calls between two
frames shares one measurement.

### Design

Add a live-ink predicate and three guards.

```js
// canvas.js
function __liveInkInFlight(state) {
    if (!state?.isDrawing) return false;
    const tool = state.currentPath?.tool;
    return tool === 'pen' || tool === 'highlight';
}
```

In `renderCanvasFrame`, skip the notebook clamp and the `canvasRendered` dispatch when
`__liveInkInFlight(state)`. In `__paintDrawingLayer`, skip the construction overlay under
the same condition.

Correctness requirement: **every skipped effect must be applied once on lift.** `endDrawing`
already calls `render()`; that frame runs with `isDrawing` false, so the clamp, the overlay
and the `canvasRendered` listeners all run exactly once, with the finished stroke in place.
The guard therefore defers work rather than dropping it.

The selection and eraser overlays are *not* skipped — the eraser lasso is drawn live.

### Second, independent cost: history snapshots

`captureHistory` → `__clonePathSnapshot` does `JSON.parse(JSON.stringify(path))` per path
over the whole document on every pen lift, retaining 80 such snapshots
(`core.js:741-760`). Cost is O(total points) with a large constant, plus GC pressure. This
is what makes the lag worsen as the page fills — which matches "again observable".

Fix: structural sharing. A path that has not changed since the last snapshot is stored by
reference, not cloned. Only the paths that actually differ are deep-copied. Undo already
treats snapshots as immutable, so sharing unchanged entries is safe.

### Verification

`tests/bench_render.py` already exists as a harness. Measure before and after at 200 / 1000 /
3000 strokes, at 1x and 4x CPU throttle, in both Notebook and plain canvas mode. Report raw
numbers, not readback numbers — a 1px readback adds a flat ~3.5 ms (1x) / ~14 ms (4x) of
headless software compositing that is not a tablet GPU's cost.

New tests: one asserting the notebook clamp and `canvasRendered` do not fire per sample
during a stroke and do fire once on lift; one asserting undo still restores correctly with
structural sharing (mutation-check it — the drag exclusion's tests passed while the code was
dead).

---

## 2. Shape assist icon

Current icon (`templates/write.html:1406-1414`) is two disconnected marks: a dashed open arc
top-left and a small outlined triangle bottom-right. It fails three ways:

- `stroke-dasharray="1.8 2.3"` on a 1.6px stroke becomes about eight loose specks at the
  18px rendered size (`write.css:920-926`), reading as dirt.
- The two marks have dead space between them and no transformation cue, so they read as
  fragments rather than "this becomes that".
- They are drawn inconsistently (1.6 vs 1.85 stroke width, `linecap` on one, `linejoin` on
  the other), and the triangle is confusable with the shape picker's `triangle-isosceles`.

The house rule, from the decisions log: an icon depicts the mechanism, as one mark, legible
at 16-18px. `DESIGN.md:313` records the same failure for the settings gear; `icons.js:133`
records the fix.

**Replacement:** a square whose three settled sides are crisp `currentColor`, and whose top
edge is still a hand wobble drawn in `.tool-icon-accent` (`#7dd3fc`). One closed mark,
before-and-after stated in a single shape, no dashes. It contrasts with the two arcs (undo,
redo) immediately to its left, where a circle would blend.

Constraints: keep the button's `id`, `class="tool active"`, `type`, `title`,
`aria-label="Shape assist"` and `aria-pressed` untouched — `tests/test_write_assist.py:292`
pins position, the 44px target, and both ARIA attributes. `viewBox="0 0 24 24"`,
`width/height 21`, `aria-hidden="true"`, `stroke-linecap`/`linejoin` `round`. Must survive
`toolIconActivePop` (scale 1.2, rotate -5deg).

No test asserts the SVG markup.

---

## 3. YouTube capture resolution

### Chain of loss

The player element is 420 x ~215 CSS px (`youtube.js:22`, capped 960x720 by
`viewportPlayerSize`, `youtube.js:106`). YouTube's adaptive bitrate picks a rendition from
the element size, so roughly 360p is being painted. Region/Element Capture crops the tab
frame to the iframe's border box and **a crop can never upscale**. Everything downstream
compounds:

| Step | Where | Effect |
|---|---|---|
| `getDisplayMedia` requests no resolution | `youtube.js:706-712` | Default tab-capture size; no `applyConstraints` follows |
| Downscale cap is downscale-only | `youtube.js:803-805` | `Math.min(1, 1280/w)` is a no-op at 420px |
| Canvas sized 1:1 to the bitmap | `youtube.js:806-813` | No DPR multiplier |
| JPEG quality walks down | `youtube.js:816-821` | 0.9, stepping by 0.15 to a floor of 0.5 |
| Placement discards the real size | `youtube.js:903` | `canvasPlacement(360, ...)` — width hard-coded 360 |
| Painted into a up-to-3x backing store | `core.js:10-16` | Upscaled again at paint time |

Separate defect: the player box (~1.95:1) rarely matches 16:9, so YouTube letterboxes inside
it and **the black bars are baked into the JPEG**. The stored `aspectRatio` is the player
box's, not the video's.

### Design

1. **Grow the player for the capture.** Before grabbing, expand the player to the largest
   size the viewport allows, wait for a rendition change (`onPlaybackQualityChange`, with a
   timeout so a video that will not upgrade still captures), grab, restore. This is the only
   change that raises the actual ceiling; the rest are multipliers on it.
2. **Ask for resolution.** `width: {ideal: 3840}, height: {ideal: 2160}` on `getDisplayMedia`,
   and `applyConstraints` on the existing track where supported. Must degrade silently — the
   test stub is a 640x360 canvas `captureStream` whose track honours neither.
3. **Raise the cap** from 1280 to the data-URL budget rather than a fixed width.
4. **Crop the letterbox.** Compute the video's real rect inside the player box from the known
   aspect ratio and crop to it, so the stored `aspectRatio` becomes the video's.
5. **Place at the captured size**, clamped to the existing viewport fractions, instead of the
   hard-coded 360.
6. **Raise the JPEG floor** and step more gently, staying under the 2 MiB budget.

### Constraints (all test-pinned)

- Output must stay `data:image/jpeg;base64,` (`test_youtube_capture.py:408`). WebP would be
  allowed by the storage regex but breaks this assertion — keep JPEG.
- `image.length <= 2,097,152` or `compactPath`/`normalizeLoadedPath` silently drop the path.
- Exactly one `getDisplayMedia` and one `cropTo`/`restrictTo` per session, across repeated
  captures (`test_youtube_capture.py:414-420`).
- A refused prompt never re-prompts and falls back to the storyboard (`:424-434`).
- No `ytimg.com/vi/` request during capture (`:382-384`).
- `connect-src` (`app.py:1075`) blocks direct browser fetches to YouTube; anything new
  proxies through Flask. COEP must stay off `/write` or the iframe breaks.
- Zero uncaught page errors.

---

## 4. Recents: rename and delete

Rename and delete already exist and work — `Library.renameDocument(id)`
(`library.js:511-531`) and `Library.deleteDocument(id)` (`library.js:533-577`), including the
hard case where the active notebook is deleted. The Library modal already shows both as
per-card pencil/trash buttons (`library.js:897-900`). The Recents pane is read-only purely by
construction. `DESIGN.md:316` argues against a second divergent implementation, so this routes
to the existing functions.

### Design

- **Restructure the row.** Today it is a single `<button class="file-recent-item">`
  (`file-ribbon.js:702`); nested interactive controls are invalid HTML. Becomes a container
  carrying the class, holding an open button that fills the row plus rename and delete icon
  buttons. `.file-recent-name` must stay a descendant of `.file-recent-item` with the bare
  name as its `textContent` (`test_file_ribbon.py:622`), and the row's **centre** must remain
  the open target (`:627` clicks it) — so actions sit at the trailing edge, not the middle.
  That is also the right call for a real user: a mis-click at the row centre must never delete.
- **Raise rows to 44px.** Currently ~38px against DESIGN.md's `--tap` floor, which the icon
  buttons force anyway.
- **Parameterise the confirm dialog.** `showClearCanvasConfirm()` (`core.js:416-428`) is the
  house destructive-confirm but hardcodes its copy (`core.js:341-351`). Give it title, body
  and button labels, keep the existing call site working with defaults, and reuse it for
  delete. Per `DESIGN.md:297` the destructive button is one solid `--accent` — there is no
  warning colour in this system (`DESIGN.md:61-64`).
- **Rename inline**, in the row, rather than a dialog. This needs a name argument:
  `renameDocument(id)` currently raises its own `window.prompt` (`library.js:519`). Add an
  optional name parameter, keeping the prompt as the fallback so the Library modal is
  unchanged.
- **Refresh after mutation.** Nothing currently re-renders Recents. Export `renderRecent`, or
  dispatch a library-changed event the ribbon listens for.
- **Add a pencil icon** to `file-ribbon.js`'s `ICONS` map (`trash` exists at `:83`).

### Two bugs fixed in passing

- `library.deleteDocument` never calls `DocStore.collectGarbage` (`doc-store.js:229`), so a
  deleted notebook's imported PDF/PPT bytes stay in the `documents` store forever.
- `library.setStatus` writes to `#libraryStatus`, which does not exist until the Library
  modal has been opened once (`library.js:718`), so a rename from the ribbon silently drops
  its confirmation. Route ribbon-initiated status through `FileRibbon.setStatus`.

---

## 5. Lasso: object erase or selection

The hold gesture is on the **eraser**, not Select: a 520 ms long-press
(`ERASER_HOLD_MS`, `events.js:853`) arming a free-form polygon. There is no "magnetic" code.

The report is correct, and the cause is sharper than "it behaves like an object eraser":
`finishLasso` (`eraser.js:60-82`) **never reads `toolSettings.eraser.mode`**. It always
deletes whole objects. With the panel set to Partial, the panel is lying. The hint at
`write.html:786` documents the unconditional behaviour.

### Design

A new key rather than a third `mode` value — `eraser.js:19-24` coerces any value that is not
exactly `"object"` back to `"partial"` on every read, so a third string cannot survive.

```js
eraser: { size: 20, mode: 'partial', lassoAction: 'erase' }   // core.js:185
```

`lassoAction` is `"erase"` (current behaviour, the default) or `"select"`. On `"select"`,
`finishLasso` hands the encircled indices to `Selection` and switches to the select tool
instead of splicing them out — the objects can then be moved, restyled or deleted with the
key that already does it.

New panel section in `#eraserOptions` following the established pattern: a
`.tool-option-section` with a `.tool-option-heading` and a `.geometry-toggle-grid.is-pair` of
`[data-eraser-lasso]` buttons, wired the way `eraser.js:138-144` wires the mode buttons. Hint
text at `write.html:786` updated to describe both.

Default stays `"erase"` because `test_interaction_plan.py:160` is load-bearing: it waits
560 ms, asserts `Eraser.isLassoActive()`, drags a rectangle and asserts the encircled object
is deleted.

### Two latent defects fixed at the same time

- `Eraser.syncSettings` (`eraser.js:159`) has **no caller anywhere in the repo**.
  `storage.js:1276-1278` syncs `Compass.syncSettings` after preferences restore but not the
  eraser's, so a restored eraser mode never reaches the buttons if preferences load after
  `initEraserTool`. Add the call.
- `finishLasso` calls `invalidateCanvasDrawingCache()` (`eraser.js:78`), nulling the
  committed-layer meta and forcing a full O(N) rebuild. The drag object-erase path
  (`canvas.js:1366`) does not, and gets region repair instead. Drop the invalidation so the
  lasso takes the same repair path — directly relevant to item 1.

---

## 6. Tool sub-panels

### The finding

The panels are not unstyled. **The target device never receives the styling.** Everything
good is gated behind `@media (min-width: 1180px)` / `body.chrome-rail`, and the product is
written for a ~960px tablet. At 960px:

| >=1180px | 960px |
|---|---|
| `accent-color: var(--accent)` on sliders (`editor-chrome.css:445`) | Browser-default blue |
| `.colors` as a 4-column grid (`editor-chrome.css:459`) | Ragged `flex-wrap` — the layout `DESIGN.md:307` records as *fixed* |
| Headings left, full opacity | Centred at `opacity: 0.66` |
| Line types and arrow tips in a wrapping row | A 5-tall vertical tower |
| Labels as `space-between` rows | Stacked columns |
| `.has-more` scroll fade (`DESIGN.md:294`) | Nothing — `.has-more` is a `.tool-dock` class and there is no dock below 1180px |

The compass's ~950px of controls therefore scroll silently inside a ~580px box on the device
with the least screen.

### Supporting damage

- **`.tool-options` is declared twice**, `write.css:964-979` and `write.css:4768-4793`, 3,804
  lines apart. B wins every conflict; A's background, padding, radius and max-width are dead.
  `.geometry-inspector` is likewise declared twice.
- **18 of 20 dock rules are restated** under `.chrome-rail` in `editor-chrome.css` to undo
  `write.css`'s 48px-dock assumptions. Four pairs are copy-pasted verbatim, comments included.
- **Off-palette colour survives inside the panels**: the violet radial
  `rgba(98,88,255,0.1)` that `DESIGN.md:298` records as removed is still live in light mode
  (`write.css:4790`); `#8b84ff` for the active swatch border; `rgba(133,126,255,.46)` for
  every checked checkbox chip in the line, angle and compass panels; `#6ee7dd` cyan focus
  rings in seven places. In an ochre system.
- **Nine segmented-control implementations** for one visual idea, with five different state
  conventions (`.active`, `aria-pressed`, `:checked + span`, `.is-selected`,
  `.color-swatch.active`). Three swatch implementations. Four slider stylings.
- `.tool-options` still carries `backdrop-filter: blur(18px) saturate(1.15)`
  (`write.css:4783`) over an **opaque** `var(--surface)` — blurring pixels the fill then
  covers, on the slowest GPU shipped to. `DESIGN.md:291` removed exactly this bargain from
  the rail and top bar.
- `tool-dock.js:283` writes `"<Tool> settings"` into `.tool-dock-title`, which is
  `display: none` at every width.

### Design

`shape-picker.css` — written 2026-09-15, entirely on core tokens, uses
`[aria-pressed="true"]` as the real CSS selector rather than a class JS keeps in sync, and
works at both widths — is the template. The work is to bring the rest up to it.

1. **One panel shell, 960-first.** Delete the dead `.tool-options` block. Write the shell
   once against core tokens, sized for the floating case, with the dock case as the *narrow*
   set of overrides rather than the whole layout. Remove the `backdrop-filter`.
2. **Move the >=1180px-only wins down to every width**: `accent-color` on sliders, the
   swatch grid, row-form labels, wrapping control rows, left-aligned full-opacity headings.
3. **Bring the scroll affordance to the floating panel.** Drive `.has-more` off the panel,
   not off `.tool-dock`, so the compass stops scrolling silently on the tablet.
4. **Retire the off-palette colour** listed above to `--accent` / `--accent-wash` /
   `--ok` / the `--ink-*` ladder.
5. **One segmented control.** Collapse the nine forks onto one class family with
   `[aria-pressed]` as the state, keeping every existing hook so JS and tests keep working.
6. **Delete `.tool-dock-title`** and the JS that writes to it.

Staged so each step is independently revertable and testable: (1)+(2) first, since they are
what the user actually sees; (3)+(4) next; (5)+(6) last.

### Constraints (all test-pinned)

`tests/test_tool_panel_close.py` runs **both** layouts (960x720 and 1440x900) across all
eight tools and pins: the eight panel ids; `#toolDockClose` when docked and
`#<panelId>Close` when floating, with the other **not visible**; a >=44x44 box on the close
button; the eight exact `aria-label` strings; a real `.click()` (so anything covering the
button fails); tool unchanged after close; focus returning to `#<tool>Tool`; zero page errors.

`tests/test_shape_picker.py` pins group headings, `data-shape`, `.shape-btn-label`, unique
non-empty SVG per shape, >=44x44 for every `.shape-btn` and `.shape-style-option` in both
layouts, no horizontal scroll, exactly six `.shape-style-option`, and the legacy
`.triangle-type-btn` selectors.

`tests/test_arc_and_colour.py` pins that every `input[type=color]` gets a `.hex-field` as its
**immediate next sibling** (`color-field.js:82` does `picker.after(wrap)`) — wrapping the
picker breaks it — plus `.studio-trigger` per hex field and `.color-studio[hidden]` as the
studio's visibility mechanism.

`tests/test_pen_palette.py` matches a **markup string**, not a selector:
`data-color="{color}" style="background:{color}"` must appear verbatim in the rendered HTML.
The inline `style` attribute and its exact formatting are pinned.

Also preserved: `.tool-options` `display` as the visibility mechanism, `#toolDockBody` as the
docked scroller, and the `window.Inkyscib.ToolDock` API surface.

### Out of scope

The colour studio is three HSL sliders, not an SV square, and no SV-square rebuild exists in
`TODOS.md` or any spec — it was planned in a chat log, which is the failure mode
`CLAUDE.md:70` warns about. Not part of this work; recorded in `TODOS.md` instead.

---

## Order of work

1. Write lag (item 1) — the reported pain, and item 5's cache fix feeds it
2. Shape assist icon (item 2) — small, self-contained
3. Lasso option (item 5) — includes the region-repair fix
4. Recents (item 4)
5. YouTube (item 3)
6. Tool panels (item 6) — largest, staged internally

Each item runs the suite before moving on. Baseline must be green first; any failure is mine
until proven otherwise.
