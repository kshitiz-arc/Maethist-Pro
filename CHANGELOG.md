# Changelog

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
- **Saved video moments use YouTube's preview image.** The server no longer
  downloads video streams unless `YOUTUBE_FULL_FRAMES=true`.

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
