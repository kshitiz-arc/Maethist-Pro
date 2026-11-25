# MAETHIST

A browser workspace for studying from your own material: import a PDF or a deck, write on
it by hand, construct real geometry, export clean vector PDF. Free, offline-capable, no
account. Flask + vanilla JS, no build step.

**Git exists now, but it is one commit.** `origin` is
github.com/kshitiz-arc/Inkyscib_Beta, `master` holds a single "Initial commit", and
almost every file is modified against it. So `git diff` shows months of work as one
blob and is close to useless for review -- verify changes by running the tests and by
looking at the app, the same as before.

## Privacy: there is no analytics

Version 2 removed Google Analytics, the consent banner and `/api/consent`. A
first visit talks to this origin and nobody else, and the privacy policy says
so in as many words. `tests/test_analytics_csp.py` fails if a tag, a
measurement id or an analytics origin comes back anywhere. Adding any tracker
is an owner decision, not a change: it makes the policy false until the policy
changes too. `templates/legal/*` describes the code as it runs; start at
`docs/legal/README.md`, which lists exactly what forces a re-read.

## Releasing

`VERSION` and `APP_VERSION` in `app.py` must agree. `render.yaml` deploys to
Render with `gunicorn wsgi:app --config gunicorn.conf.py`; production refuses
to start without `SECRET_KEY`. YouTube frames are cut at the source's own
resolution up to `YOUTUBE_FRAME_MAX_HEIGHT` (1080 since 2.7.0, for speed; 2160 brings 4K back), JPEG 95 at 4:4:4; the
browser-side ceiling is 12 MB per frame in `storage.js` and `youtube.js`, and
`app.py`'s `YOUTUBE_FRAME_MAX_DATA_URL` must stay under it.
`YOUTUBE_FULL_FRAMES=false` falls back to storyboard previews. The offline
shell is `/sw.js` (`templates/sw.js`): it precaches every file under `static/`
that the pages load, so a new asset type needs adding to `_OFFLINE_SUFFIXES`.
`OFFLINE_SHELL=off` is its remote off switch (`templates/sw-off.js`).
`docs/V2-REVIEW.md` is the launch review, with the measurements.

Image to text (`ocr_engine.py`, `/api/ocr`) is optional per server. Without
`requirements-ocr.txt` it reports itself unavailable and the tool says so on
opening; `render.yaml` installs only `requirements.txt`, so production has it
off. The equation reader (Pix2Text MFR on ONNX Runtime) is about 120 MB of
weights; the handwriting reader (TrOCR on PyTorch) needs about 2 GB of RAM,
more than Render's free plan. `OCR=off` is its switch. Models load from the
Hugging Face cache before the network (a hub ETag check once hung the first
request), and `OCR_MODEL_TESTS=1` runs the tests that use the real models.

## Icons

Lucide for the editor, Phosphor for the Planner, Pomodoro and tour, Remix for
the marketing and legal pages: one family per surface. All three are vendored
by `tools/vendor_icons.py` (pinned tags, sanitised SVG). To add one, put the
name in that file's `ICONS` and re-run it; never paste an SVG by hand. In a
template use `{{ icon("lucide:name", "class") }}`; in a script use
`window.Inkyscib.Icon.svg("lucide:name")` or the legacy
`<i class="fas fa-...">`, which `static/js/icons.js` maps per family. A
surface opts into a family with `data-icon-set="phosphor"` on its root.
`tests/test_icons.py` fails on any reference that is not vendored.

## Design System

Always read `DESIGN.md` before making any visual or UI decision. All colour, typography,
spacing, radius, motion and layout rules live there. Do not deviate without explicit user
approval. When reviewing code, flag anything that does not match it.

Two rules from that file are worth repeating because they have already caused shipped bugs:

- **One token vocabulary.** Do not invent a `--yourfeature-*` palette. The codebase already
  carries eight of them, and because `--chrome-*` is declared on `body.chrome-rail` (which
  only exists at ≥1180px), a panel built against it rendered with no background at all on a
  tablet. If a token you need does not exist, add it to the core set in `DESIGN.md`.
- **Nothing that teaches the app may hide behind a `?` at one breakpoint.** The target
  device is a ~960px budget Android tablet. Anything gated above 1180px does not exist for
  the user this product is for.

## Running it

```bash
python -c "import os; os.environ.setdefault('SECRET_KEY','dev'); from app import app; app.run(host='127.0.0.1', port=8977)"
```

## Tests

```bash
python -m pytest tests/ -q
```

**Baseline is 668 passed / 0 failed / 1 skipped, 2,392 subtests, about 16 minutes
(2026-11-26, version 2.9.3).** Before that, 665 / 0 / 2,385 (2.9.2). Before that, 663 / 0 / 2,385 (2.9.1). Before that, 658 / 0 / 2,375 (2.9.0, counting a
YouTube speed test's 30s page-ready timeout under load as a straddle). Before that,
653 / 0 / 2,365 (2.8.5). Before that, 649 / 0 / 2,365 (2.8.4, counting the
render-latency view-jump test as a known timing straddle). Before that,
646 / 0 / 2,352 (2.8.3). Before that, 638 / 0 / 2,345 (2026-11-24, 2.8.2,
counting `test_lift_smoothing_is_cheap` -- 2.30ms in the full run, under 2.0
alone -- as the known timing straddle). Before that, 605 /
0 / 2,285 (2026-11-19, version 2.7.0). Before that, 484 / 0 / 1,457 subtests (2026-11-15, version 2). Before that it was 497 passed / 1 failed, 906 subtests, about 10 minutes
(2026-09-21), after the tool-panel and shape-assist work (TODOS item 19) added
`test_tool_panel_layout.py` and nine tests to `test_write_assist.py`. Before
that, 474 / 1 / 814 the same day after the production-readiness pass (item 18). It was 447 / 0 / 723 on 2026-09-20 and 319 / 244 on
2026-09-19.

**The one failure is `test_ink_smoothing.py::test_lift_smoothing_is_cheap`, and it
is the budget, not a regression** -- see TODOS items 17 and 18. Measured on
2026-09-21: five isolated runs of the current tree gave 3.10 / 2.30 / 2.70 / 2.60 /
2.50 ms against a 2.0 ms ceiling, and five runs of the *pre-change* tree on the same
machine minutes later gave 2.50 / 2.30 / 3.00 / 2.30 / 2.20 ms. Overlapping
distributions, both failing: the machine was slower that day, not the code. Raising
the ceiling is the owner's call, so it was left red rather than quietly widened.

Otherwise treat *any* failure as yours until proven otherwise -- and note that
"proven" above meant re-measuring the old code on the same box in the same minute,
not recognising the test name.

**Do not run two full suites at once.** A contended run failed three timing tests
(`test_lift_smoothing_is_cheap`, a render-latency same-frame assertion and an 8s
`page.goto` on /write); all three pass alone. `test_lift_smoothing_is_cheap`
measures 1.5-2.4ms against a 2.0ms ceiling, so it straddles it either way -- see
TODOS.md for the measurements and two ways to make it honest.

It was 17 failed / 156 passed in ~21 minutes until 2026-09-11, and the long-held
belief that those were "pre-existing and unrelated" was wrong — nobody had read
the tracebacks. All 16 planner failures were one dead selector, and each of the
rest was a single file breaking a convention the other files follow. See
`TODOS.md` item 6 for the full diagnosis. The lesson worth keeping: **a stable
failure count is not evidence the failures are understood.**

### Writing a browser test

Four conventions, all of which have caused a false failure here. None is
enforced anywhere, so they have to be applied by hand:

- **Dismiss the first-run tour** via
  `localStorage['inkyscib-feature-tour-v1']`, set in an `add_init_script`. It
  opens over the canvas and takes the pointer, so clicks land on the overlay
  and the canvas never even receives `mouseenter`.
- **(Historical) the consent banner.** It no longer exists, so nothing needs
  answering. Older tests still seed the key below; it is harmless and ignored:
  `localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false}))`.
  Same failure as the tour, one layer up: the banner is `position: fixed` at
  the bottom of every page until someone answers it, so it eats clicks meant
  for anything down there. The `version` must match `VERSION` in
  `static/js/consent.js` or the record is ignored and the banner opens anyway.
  The consent, accessibility and SEO-browser modules deliberately do **not**
  pre-answer it.
- **Pin `locale="en-US"`** on the context if the test asserts any date text.
  The app formats through `Intl.DateTimeFormat(undefined, ...)`, so it follows
  the machine and an en-GB box renders "Sunday, 9 August 2026".
- **Pass `wait_for_function` an arrow function, not a bare expression.**
  Playwright evaluates a bare expression with `eval()`, which the editor's CSP
  forbids. `bypass_csp=True` also works but switches off the real CSP.
- **Opacity composites; it does not inherit.** A test that reads an element's
  own `getComputedStyle(...).opacity` sees `1` while an ancestor at `0.4` halves
  what actually reaches the screen. The first draft of
  `test_accessibility.py::TabletFooterTests` passed against the very bug it was
  written for because of this. Multiply up the ancestor chain, and re-run any new
  guard against a deliberately reverted file to watch it go red.
- **Below 1180px the tool row scrolls sideways.** A tool at the far end may be
  out of view: scroll `.toolbar` or call the element's `click()` rather than
  asserting it is under the pointer. An automated browser also skips the
  offline worker unless the page sets `window.__inkyscibOfflineShell = true`.
- **Tool panels float from `#toolPanelLayer` below 1180px, closed on load.**
  Open one the way a person does (select the tool, or tap the tool in hand)
  rather than assuming the pen panel is showing, and wait out the ~200ms
  transitions before measuring a panel's position.
- **Do not wait for chrome to be *visible*.** `#plannerBtn` and its siblings
  live in `#chromeTriggers`, which write.html keeps permanently `hidden` so the
  import handlers stay bound. Use `state="attached"`, and reach features
  through their module API or the File ribbon.

## Deferred work

`TODOS.md` holds it, with enough context to pick each item up cold. Add to it rather than
leaving an intention in a chat log.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in
doubt, invoke the skill.

- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
