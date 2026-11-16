# Changelog

## 2.1.0 — 2026-11-17

### Changed

- **Inkyscib is now MAETHIST.** Every name a person reads changed: page
  titles, the wordmark, the editor footer, the tour, error and status
  messages, Planner alerts and calendar exports, download file names
  (`maethist-backup-<date>.inky`, `maethist-notebook.pdf`,
  `maethist-presentation.pptx`), the installed app's name, the legal pages
  and the docs.
- **New mark.** The favicon, the installable-app icons, the Android adaptive
  icon, the notification badge, the header and 404 logos, the tour badge and
  the share card all use the new maths-symbols icon, built from one source by
  `tools/make_brand_icons.py`. On pages it sits on a small paper tile, because
  its black outlines would vanish on the dark sheet.

### Kept on purpose

- **Internal names did not change**, so nobody loses their work: storage keys
  (`inkyscib_drawing`, `inkyscib-*`), the IndexedDB database `inkyscib_cache`,
  the backup format's `app: "inkyscib"` marker, the offline cache prefix, the
  `window.Inkyscib` script namespace and the `.inky` / `.inkydoc` file
  extensions. Renaming any of them would orphan every existing visitor's
  notebooks or make older backups unopenable.

## 2.0.2 — 2026-11-17

### Changed

- **Every UI icon now comes from an open icon library**, vendored from GitHub
  at a pinned release by `tools/vendor_icons.py`, one family per surface so
  two styles never share a row:
  - **Lucide** 1.66.0 (ISC) for the editor: toolbar, tool rail, File sheet,
    tool panels, the lecture player and toasts.
  - **Phosphor** 2.0.8 (MIT) for the Planner, Pomodoro and the feature tour.
  - **Remix Icon** 4.9.1 (Remix Icon License) for the marketing and legal pages.
- Templates inline icons on the server (`icon()` in `app.py`), so they are in
  the HTML on first paint; scripts use the same set from `static/js/icon-set.js`.

### Removed

- The 55 hand-drawn icons in `static/js/icons.js`, the File sheet's own icon
  paths, the planner's, tour's, dock's and colour studio's inline icons, and
  the Unicode stand-ins on the homepage (the arrows, the theme-toggle half
  circles and the preview toolbar's tool glyphs).

### Kept on purpose

- Drawings of content, which no icon library has: the 15 shape glyphs and the
  toolbar's current-shape mirror, pen-nib samples, line, arrow, fill and dash
  styles, the assist curves, canvas swatches, the Pomodoro ring, resize grips
  and the tour and planner illustrations. The wordmark's diamond is the logo.


## 2.0.1 — 2026-11-15

### Changed

- **Video moments are captured at maximum resolution and quality.** The
  server now picks the video's highest-resolution SDR stream up to 4K, in any
  codec (VP9 and AV1 as well as H.264; YouTube serves nothing above 1080p as
  H.264), and encodes JPEG at quality 95 with no chroma subsampling, so slide
  text and thin coloured lines stay crisp. Measured: a 4K source gives
  3840x2160 (3.7 MB) in 8.7 s for the first frame and 0.7 s for the next; a
  1080p source gives 1920x1080 (0.8 MB). On by default again; the per-frame
  storage ceiling rose from 2 MB to 12 MB to hold it.

### Added

- **Persistent storage.** After the first save, Inkyscib asks the browser not
  to evict its storage under disk pressure (`navigator.storage.persist()`).
- **Backup reminder.** After two days of work with no backup, or a week since
  the last one, a small bar offers "Back up now". "Later" snoozes it two days.
- **Remote off switch for the offline shell** (`OFFLINE_SHELL=off`), in case a
  release ever ships a broken service worker.
- **Cold-start fallback.** If the host is asleep, the offline shell serves the
  cached page after 3.5 s instead of leaving a blank tab for a minute.

### Fixed

- **Import uploads are capped** at 50 MB on the server, with at most two
  conversions at once; the rest get a clear "busy, try again" answer instead of
  exhausting memory.
- **A save too big for localStorage no longer leaves an old copy behind.**
  IndexedDB was always the copy that loads; the stale mirror is now removed.


## 2.0.0 — 2026-11-15

The first version meant to be launched publicly. The launch review, with every
measurement behind the claims below, is `docs/V2-REVIEW.md`.

### New

- **Works offline, for real.** A service worker (`/sw.js`) keeps a copy of the
  app's own pages, scripts, styles and fonts. After one visit online the canvas
  opens with no connection. The homepage always said "offline"; until now that
  was only true of the notes, not of the app.
- **Blueprint identity.** Drafting blue, one cyan accent, Space Grotesk for
  headlines and labels, a ruled grid behind the marketing pages. New default
  canvas ground for new visitors is Blueprint. Light mode is white drafting
  paper with blue rules.
- **One-click deploy to Render** via `render.yaml`, with `gunicorn.conf.py`,
  a `/healthz` health check, pinned requirements and a `VERSION` file.

### Changed

- **Tablets and phones get a proper toolbar.** Below 1180px the editor now has
  two docked bars (document, then tools) instead of loose icons wrapping over
  two or three rows. 122px tall at every width, down from about 200px. Every
  tool fits without scrolling on a 960px tablet; on a phone the row scrolls
  sideways and fades at the edge to say so.
- **The File sheet opens under both bars** and stops above the footer links.
  On desktop it opens beside the tool rail, not over it.
- **The tour, File sheet, Planner and My Notebooks share one palette.** Each
  used to carry its own (indigo, teal, lavender).
- **Footer credit** now reads "Created by @kshitizarc" and links to LinkedIn.
  The animated "TT" signature is gone.
- **The lecture player opens in 180ms**, not 480ms.
- **Saved video moments used YouTube's preview image** in 2.0.0. Reverted in
  2.0.1, which captures at up to 4K.

### Removed

- **Google Analytics, the cookie banner and `/api/consent`.** There is no
  analytics of any kind. A first visit contacts no third party.
- `consent_log.py`, `tools/prune_consent_log.py`, `tools/verify_consent_log.py`.
- The "Privacy choices" and "Do Not Sell or Share" footer links, which only
  ever switched analytics off.

### Fixed

- The help sheet was 14px wider than a 375px phone and ran off both edges.
- The notebook page switcher sat on top of the Privacy / Cookies / Terms links.
- The zoom field (45x18) and the document name (54x19) were too small to tap;
  both are now 44px, as are the marketing nav controls.
- White text on the accent became unreadable wherever a dialog hard-coded it;
  those now use `--on-accent`.
- Production no longer starts with a random per-worker `SECRET_KEY`: it
  refuses to start until one is set.

### Before you go live

- Set `SITE_ORIGIN` on the host.
- Fill in the privacy contact address on `/legal/privacy` (it is still a
  placeholder) and have the three legal pages read by a lawyer.
- Try it once on the real tablet: everything here was measured in desktop
  Chromium at tablet and phone sizes, not on the device itself.
