# Changelog

## 2.3.0 — 2026-11-17

### Changed

- **New look: neo-brutal with frost.** Cream paper (deep ink at night), thick
  ink outlines, hard offset shadows, a yellow / red / purple / blue / green
  accent set, and frosted glass over soft colour blobs.
- **The homepage is rebuilt.** A big "Maths you can touch." headline, a demo
  window that draws its own construction on load, a tilted marquee, a bento
  grid of features, a "Free means free" stats row, three steps and a closing
  call to action. The same one action ("Start writing, free") appears twice.
- **A new welcome tour.** Six short steps, each with its own colour, a drawn
  illustration and a spotlight on the real control it describes. Keyboard,
  clickable progress dots, and a bottom sheet on phones. Replaces the old
  onboarding cards (`onboarding.js` and `onboarding.css` are gone; the stored
  "seen" key is unchanged, so returning users are not shown it again).
- **The editor matches.** Bars, rail and panels get ink outlines and hard
  shadows; the tool in your hand is a yellow block; dialogs and sheets are
  frosted. Bars are frosted only on a desktop pointer, to keep panning smooth
  on a tablet.
- **Everything moves like one product.** One set of curves and durations,
  shared by every page. Moving between pages cross-fades; switching light and
  dark, or picking a canvas, wipes the new look out of the button you
  pressed. On the homepage, sections rise in as you scroll, the demo window
  leans toward the pointer, a soft light follows the pointer across the
  feature tiles, the header settles as you scroll, and a fine grain sits over
  the colour. Editor buttons press in, and dialogs arrive rather than pop.
  Under reduced motion all of it stands still.
- **The focus timer is rebuilt, with a Sound studio.** Each mode has its own
  hue on the clock (yellow focus, green break, blue long break), the clock
  breathes while it runs, and everything you press has an ink outline and a
  hard shadow. The new Sound studio adds white, pink and brown noise and a
  Wind down bed that swells on a slow 4-in, 6-out breath, alongside rain,
  deep sea and clock. It also has focus frequencies: delta 2 Hz, theta 6 Hz,
  alpha 10 Hz, beta 16 Hz and gamma 40 Hz presets, or any rate from 1 to
  45 Hz. They play as a binaural beat in headphones or as a soft pulse on a
  speaker, with their own pitch and volume. A switch plays sound only while
  you are focusing, fading it out for breaks. Everything is generated on the
  device, nothing is downloaded, and the studio always opens silent.

### Fixed

- On phones the marketing header scrolls away with the page instead of
  pinning three rows over it.

- **The editor had no way back to the homepage.** The MAETHIST mark now
  starts the File ribbon at every width and links home; notebooks save as
  you write, so leaving loses nothing.
- The docked tool panel on desktop started at the top of the window, so its
  title sat hidden behind the top bar.
- The homepage scrolled sideways by a pixel on phones.


## 2.2.1 — 2026-11-17

### Fixed

- **Every error now reaches the screen.** 2.2.0 fixed the PDF, PowerPoint
  and image pickers; the same flaw was in three more places, now fixed:
  notebook PDF export ("Write notes before exporting.", export failures),
  File-menu commands whose result was written inside a menu that had already
  closed, and My Notebooks messages (such as a bad backup) shown inside a
  dialog that was not open. AR Inky's camera errors used blocking browser
  pop-ups and now use the same notice.
- **A damaged PDF crashed the server import on Windows.** PyMuPDF kept the
  failed file locked, the temporary folder could not be deleted, the request
  ended in an HTML error page, the upload stayed on disk, and the editor
  showed the raw text "Unexpected token '<' ... is not valid JSON". PDFs are
  now read in memory and never written to disk; temporary folders for
  PowerPoint tolerate a locked file; every API error answers in JSON with a
  readable sentence; and the editor turns an unreadable reply into a plain
  message.
- The privacy policy now says that PDFs are read in memory and that most
  imports never reach the server.
- An upload test posted the wrong field name, so it never exercised the code
  that failed. It now sends a real damaged PDF.


## 2.2.0 — 2026-11-17

Launch checklist. Items that were already in place (privacy and terms pages,
meta titles and descriptions, social preview image, favicon, sitemap,
robots.txt, alt text, custom 404, no secrets in front-end code) were audited
and kept.

### Added

- **A visit counter you own.** Page loads per day, per page, by phone, tablet
  or desktop, and the referring website's name. No cookies, no IP addresses,
  nothing per visitor and nothing sent to anyone, so no consent banner is
  needed. Read it at `/stats` with the `STATS_TOKEN` password.
- **Request limits on every public API endpoint** (search, video frames,
  imports, exports), so one visitor cannot flood the server. Visitors are told
  to wait with a 429 and a retry time; the address is only ever held as a
  scrambled code for one minute, in memory.
- **`PRIVACY_CONTACT_EMAIL`** puts your contact address on the privacy and
  terms pages; until it is set they keep the visible placeholder.

### Changed

- **One call to action**: "Start writing, free", on every page and in the
  header. Second choices are quiet text links, not competing buttons.
- **HTTPS is forced in production by default** (Render or
  `INKYSCIB_ENV=production`); `FORCE_HTTPS=false` turns it off.
- **Brand images compressed** from about 650 KB to 52 KB; the favicon from
  432 KB to 7 KB.
- **Form fields**: the planner marks an empty task name as invalid for screen
  readers; size fields accept decimals without flagging them; the lecture
  search has the server's 200-character limit.
- The privacy policy describes the visit count and the request limits, with
  their retention.

### Fixed

- **Import errors were invisible.** "Choose a .pdf file", "Could not open this
  PDF" and the PowerPoint messages were written into side-menu status lines
  the v2 chrome never shows, so a wrong file looked like a button that did
  nothing. They now appear as an on-screen notice, as do image-insert errors.
- The 404 page gained a description and a clearer title.
- The EDPB link in the privacy policy pointed at a moved page.

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
