# Inkyscib 2.0 launch review

2026-11-15. Written for the owner, as the review a CEO would want before
pressing publish: is it ready, what was wrong, what changed, what is still open.

## Verdict

**Ready to deploy once three owner-only items are done** (see "Before you go
live"). The drawing engine, geometry, import and export were already solid.
What blocked launch was the first five minutes and the release plumbing, and
that is what version 2 fixes.

## What was blocking launch, and what happened to it

| # | Problem found | Status |
|---|---|---|
| 1 | The homepage's first claim is "offline", but the app had no offline support. Only the notes were local; the app itself needed the network every time. | **Fixed.** A service worker precaches the app. Tested by loading the editor, cutting the network and reloading. |
| 2 | A new visitor to the editor got an 11-step tour and an analytics banner stacked on top of each other before drawing anything. | **Fixed.** Analytics and the banner are removed entirely, so the tour is the only thing that opens. |
| 3 | On the target device (a 960px tablet) and on phones, the toolbar was loose icons wrapping over 2 to 3 rows with the File menu floating detached underneath: about 200px of chrome on a 600px screen. | **Fixed.** Two docked bars, 122px, the same at every width. |
| 4 | No way to deploy: no host config, unpinned dependencies, a secret key that silently fell back to a random value, no version number. | **Fixed.** `render.yaml`, `gunicorn.conf.py`, pinned requirements, `/healthz`, `VERSION`, fail-fast secret. |
| 5 | The repository carried about 35 MB of unrelated material (form redesign folders, a `.docx`, QA dumps, a 3 MB log). | **Fixed without deleting anything.** They are ignored by git. The files are still on disk. |
| 6 | Four dialogs wore four palettes: the tour was indigo, the File sheet teal, the Planner purple, My Notebooks lavender. | **Fixed.** All read the Blueprint tokens. |
| 7 | The server downloaded YouTube streams for anonymous visitors: a terms-of-service risk and the most expensive thing a stranger could trigger. | **Fixed.** Off by default; saved moments use YouTube's preview image. |

## Decisions you made, and what they changed

| Decision | Consequence |
|---|---|
| Remove Google Analytics | No cookie banner, no consent log, no US-transfer or child-tracking question. A first visit contacts no third party. You have no visitor numbers; a cookieless counter can be added later without a banner. |
| Host on Render | `render.yaml` blueprint: one web service, health-checked, secret generated for you. |
| New visual identity: Blueprint | Drafting blue, cyan accent, Space Grotesk headlines. `DESIGN.md` is rewritten to match. |
| Preview-only YouTube frames | `yt-dlp` and `av` are no longer installed in production (`requirements-optional.txt`). |
| Footer credit | "Created by @kshitizarc", linked to your LinkedIn profile, at full legibility. |

## Audit: button placement and overlap

Method: a script opened the editor in Chromium at three sizes (1440x900 desktop,
960x600 tablet, 375x812 phone), clicked every toolbar control and every menu,
and measured each panel or dialog that appeared: where it landed, whether any
part left the screen, and how many pixels of the toolbar, File bar, tool rail,
footer links or another open panel it covered. It ran three times: before the
fixes, after the first round, and after the last.

### The bars themselves

| | Before | After |
|---|---|---|
| Tablet 960px: height of the top chrome | about 200px, tools on 2 rows | 122px, 1 row |
| Phone 375px: height of the top chrome | about 250px, tools on 3 rows | 122px, 1 row |
| Tablet: do all tools fit without scrolling | wrapped instead | yes (942px used of 942px) |
| File bar overlapping the toolbar | fixed by a 146px hard-coded offset | none: stacked, 4px apart |
| Controls smaller than 44px in the editor chrome | zoom field 45x18, document name 54x19 | none on tablet or phone |
| Sideways page scroll, any page, any size | none | none |

### Every surface that opens

"Covers" means pixels of a bar or another panel hidden under it.

| Surface | Desktop | Tablet | Phone |
|---|---|---|---|
| Pen, eraser, highlighter, shape, line, compass, angle, tile panels | clear | clear | clear |
| Canvas theme popover | clear | clear | clear |
| File / Insert / Export / Tools sheet | **was** over the tool rail, now beside it | **was** over the tool row, now under it | **was** over the tool row and footer links, now between them |
| Notebook page switcher | **was** on the footer links, now above them | same fix | same fix |
| Help sheet | docked, clear | modal (see below) | **was** 14px wider than the screen, now fits |
| Lecture player | clear | clear | clear |
| Pomodoro, Planner, My Notebooks, Clear confirm, feature tour | modal | modal | modal |

**About modals.** Five surfaces are modal: they dim the whole page and sit in
the middle of it until dismissed. They cover the bars on purpose, the same way
any confirm dialog does, and the page behind them is not usable while they are
open. Everything that is not modal now opens clear of every bar and of every
other open panel.

Two items the audit flagged turned out not to be defects, and are recorded so
nobody chases them again: the pen-style buttons reported "off screen" on
desktop are inside the panel's own scroll area, and the two links on the 404
page that "overlap" are one sentence wrapping onto a second line.

**One thing I could not control:** the custom colour swatch opens the browser's
own colour picker, which the browser places itself. On a tablet it can land
over the tool row.

## Audit: response time

Measured in the page, from the click to the first frame in which the surface is
visible ("appears"), and to the frame where it has stopped moving ("settled").
Desktop Chromium on this laptop; a budget tablet will be slower, but the order
of magnitude holds because none of these do real work on open.

| Feature | Appears | Settled | Verdict |
|---|---|---|---|
| Any tool panel (pen, eraser, shape, compass, ...) | 7 to 30 ms | same frame | instant |
| Canvas theme popover | 7 to 10 ms | same frame | instant |
| Help | 7 to 8 ms | same frame | instant |
| File / Insert / Export / Tools sheet | 21 to 88 ms | 190 to 290 ms | good; the 180ms slide is deliberate |
| Pomodoro | 24 to 84 ms | 150 to 210 ms | good |
| Lecture player | 25 to 45 ms | 160 to 180 ms | good; **was 520 ms**, the slowest thing in the app |
| Feature tour | 48 to 150 ms | 200 to 400 ms | acceptable; opens once |
| Notebook pages mode | 11 to 63 ms | same frame | instant |
| Drawing: cost of one pen movement | under 0.1 ms | | far inside a 16 ms frame |
| Drawing: lifting the pen | 0.1 to 0.2 ms | | instant |

Page loads, uncached, local server:

| Page | Time to first paint | Fully loaded |
|---|---|---|
| Editor, tablet and phone | about 220 to 270 ms | about 430 to 500 ms |
| Editor, desktop (first request, cold server) | about 800 ms | about 1,030 ms |
| Homepage | | about 175 to 220 ms |
| Features, About, Privacy, 404 | | 25 to 55 ms |

The editor loads 72 requests and 624 KB. That is the one number here I would
not call good: it is 55 script tags, all parsed before the first stroke. It is
fast on this machine and will be the slowest part of the experience on a cheap
tablet's first visit. After that first visit the offline shell serves it from
the device. Splitting the optional features out is `TODOS.md` item 1.

## Tests

Full suite, run once after all changes: **482 passed, 5 failed** (1,454 subtests passed, 10 min 34 s).
All five failures came from this work, not from old flakiness:

- Three were tests still asserting the old design (the ochre-only palette rule, the "credit must
  stay faint" rule, and two new routes missing a sitemap decision). Those tests are updated.
  **They have not been re-run since the update.**
- One is open: the accessibility scanner reports a violation on the 404 page under the new
  colours. **Not yet investigated or fixed.** Most likely a contrast pair in `not-found.css`.
- The fifth is the same palette rule counted for a second layout.

The previously marginal timing test (`test_lift_smoothing_is_cheap`) passed in this run.
The share image (`static/img/og-cover.png`) still shows the old orange look; regenerate it with
`python tools/make_og_image.py`.

## What is still open

1. **Privacy contact.** `/legal/privacy` still says, in bold, that the contact
   address is to be set before publishing. Put a monitored address there.
2. **Legal read.** The privacy, cookie and terms pages are accurate to the code
   as of today, including the removal of analytics, but they are drafts written
   to be reviewed by a lawyer. That is yours to arrange.
3. **Real-device check.** Nothing in this review was measured on the budget
   Android tablet. Open it there once, draw, open each menu, then go offline
   and reload.
4. **`SITE_ORIGIN`.** Set it on Render to your public address, or canonical
   links and the sitemap will point nowhere useful.
5. **Nothing is committed.** The repository is still one commit with everything
   modified on top of it. Committing and pushing are yours to approve.
6. **Editor weight** (above), and the items in `TODOS.md` 20.

## Before you go live

1. Set the privacy contact address and get the legal pages read.
2. Commit, push, create the Render blueprint, set `SITE_ORIGIN`.
3. Open the deployed site on the tablet: draw, open every menu, go offline, reload.
