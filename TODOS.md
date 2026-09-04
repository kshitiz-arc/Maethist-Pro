# TODOS

Deferred work, with enough context to pick up cold. An item here is a decision
that was made and recorded, not a vague intention. If something is worth doing
later, it goes here; if it is not worth writing down, it is not worth doing.

Ordered by expected value, not by effort.

---

## 1. Load the optional features on demand

**Why it matters:** about 350 KB of the editor bundle is features behind
buttons, and all of it is parsed and executed before the first stroke on every
visit. gzip cut the transfer, but parse and execute cost is paid on the
uncompressed bytes, and it is paid on a budget Android tablet with a slow CPU,
which is the device this product is written for.

| Module | Size | Reached by |
|---|---|---|
| `static/js/planner.js` | 96 KB | Planner button |
| `static/js/ppt.js` | 52 KB | PowerPoint import |
| `static/js/ppt-local-import.js` | 48 KB | PowerPoint import |
| `static/js/youtube.js` | 41 KB | YouTube button |
| `static/js/pomodoro.js` | 41 KB | Pomodoro button |
| `static/js/library.js` | 36 KB | My Notebooks |
| `static/js/onboarding.js` | 35 KB | First run only |

**Why it is not done:** each module wires its own UI at load time and registers
its own `DOMContentLoaded` handler, so this is a real refactor into dynamic
imports behind each entry point, not a mechanical change. `onboarding.js` is the
cheapest first target: it is 35 KB that only ever runs once per user, and it is
already gated on a `localStorage` key.

**Done when:** time to first stroke on a throttled mid-range mobile CPU profile
improves measurably, and every feature still opens from its own button.

---

## 2. Blit the committed canvas layer when panning instead of rebuilding it

**Why it matters:** any transform change invalidates the whole committed layer,
so a pan redraws every visible stroke, 60 times a second. Viewport culling
(shipped 2026-09-02) removed the offscreen strokes; what remains is about
1.2 ms of canvas clear-and-composite plus the background grid per frame.

**Shape of the fix:** copy the existing bitmap at an offset and redraw only the
newly exposed strip. This is the classic scroll-blit. See
`__rebuildCommittedLayer` in `static/js/canvas.js`.

**Done when:** pan frame cost on a large document is dominated by the exposed
strip rather than by the whole viewport.

---

## 3. Brush and fountain nibs stroke once per point

**Why it matters:** `__drawVariablePenStroke` in `static/js/canvas.js` issues a
separate `beginPath()` / `stroke()` for every point so each segment can carry
its own width, and it recomputes `__penSegmentWidth` twice per segment. The live
stroke is repainted every frame while you draw, so a long stroke gets
progressively more expensive: the cost is quadratic in its own length.

**Why it is not urgent:** the default pen style takes the single-path route and
is unaffected. This only bites users who switch to the brush or fountain nib and
then draw a long stroke.

**Two steps, in order:** carrying `nextWidth` forward halves the width
computation immediately and is a few lines. Caching the already-drawn prefix of
the live stroke removes the quadratic term and is the real fix.

---

## 4. The document is serialised twice on every save

**Why it matters:** `flushDrawingSave` in `static/js/storage.js` writes the full
path list to `localStorage` **and** to IndexedDB, so a large document is
stringified and stored twice per save.

**Why it is not urgent:** the save is debounced and runs on an idle callback, so
it is not inside a gesture.

**Open question, and the reason this is not just done:** the `localStorage` copy
looks like a legacy fallback that IndexedDB made redundant, but that needs
confirming before removal. If it is still the recovery path for a browser where
IndexedDB is blocked, it stays.

---

## 5. `penSegmentWidth` is duplicated in three places

`static/js/canvas.js` (`__penSegmentWidth`), `static/js/pdf-vector.js`, and
`app.py`. If one changes and the others do not, exported strokes come out at the
wrong weight, and the export no longer matches what was on screen.

**Done when:** there is one definition, or a test that fails when they drift.

---

## 6. Two planner tests are flaky, and it hides regressions

`tests/test_planner.py::test_phone_layout_has_no_horizontal_overflow` and
`test_device_calendar_mobile_share_and_failure_paths_stay_local` both click
`#menuBtn` without dismissing the first-run feature tour, so `#featureTour`
intercepts the pointer event whenever it wins the race. Confirmed
non-deterministic on 2026-09-03: three identical runs gave 2 passed, 2 failed,
and 1-1.

**Why it matters beyond the tests themselves:** the failure *count* stays at 16
while the *membership* changes, which is exactly the pattern that trains people
to ignore a real regression.

**Fix:** dismiss the tour in those tests the way the other suites already do,
via `localStorage['inkyscib-feature-tour-v1']`.

---

## 7. Baseline: the suite has 16 pre-existing failures

14 in `tests/test_planner.py`, 1 in `tests/test_smart_geometry.py`
(`test_constructions_remain_on_circle_after_move_and_resize`), and 1 in
`tests/test_planner_deeplink.py` which is only a date-format locale mismatch
(the test expects `'August 9, 2026'`, the machine renders
`'Sunday, 9 August 2026'`).

These are not regressions; they were verified against reverted code. They are
listed here because a known-failing baseline that is not written down is
indistinguishable from a broken build to anyone new.
