<p align="center">
  <img src="static/img/maethist-mark.png" alt="MAETHIST logo" width="96">
</p>

<h1 align="center">MAETHIST</h1>

<p align="center">
  <strong>A free study canvas for maths: write on your own textbook, build geometry that stays live, and keep working offline on a budget tablet.</strong>
</p>

<p align="center">
  No account · No ads · No analytics · Works offline · Free
</p>

---

## What it is

MAETHIST is a browser workspace for students and teachers. Open your own PDF or
PowerPoint, write on it by hand, construct ruler-and-compass geometry whose
points stay connected when you drag them, and export clean vector PDF.

It is built for the device most students actually have: a budget Android tablet
with a capacitive stylus, not an iPad and an Apple Pencil. It runs in the
browser, installs as an app, and keeps working without a connection after the
first visit.

## What you can do

**Study from your own material**
- Import a PDF (a textbook, worksheet or question paper) and write on it. PDFs
  are converted in your browser, so the file stays on your device.
- Import a PowerPoint (`.ppt`, `.pptx`) and annotate it slide by slide.
- Export as vector PDF, PowerPoint, a 300 DPI PNG, or an editable `.inkydoc`.

**Write and construct**
- Pressure-aware pens: fineliner, fountain, brush, gel and calligraphy.
- Highlighter, eraser, shapes with shape assist, lines with arrowheads, select
  and move.
- Live geometry: set a compass, sweep arcs, and the points where they cross
  stay live. Hang a line off one later and it still holds when you drag.
- Algebra tiles that know your variables, and an angle tool.

**Organise**
- A notebook library: one notebook per subject, each with its own canvas,
  pages or imported deck.
- Page mode for A4-style notes.
- A day planner and a Pomodoro focus timer.

**Learn alongside**
- Search and watch YouTube lectures in a floating player beside your notes.
- Save a video moment onto the canvas at up to 4K. Double-tap it later to
  reopen the lecture at that second.

**Keep it safe**
- Everything is stored in your own browser. There is no server copy of your
  work and no account to lose.
- One-tap backup of your whole library as a `.inky` file, with a reminder when
  you have gone too long without one.

## Privacy

MAETHIST has no accounts, no ads and no analytics. A first visit contacts no
third party at all; the only outside service is YouTube, and only when you open
a lecture. Imported files that do reach the server are converted and deleted
in the same request. The full policy is at `/legal/privacy`.

## Run it locally

```bash
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:10000. To reach it from a tablet on the same Wi-Fi,
run `start.bat` on Windows, which listens on the network and prints the address
to type into the tablet's browser.

To run the tests:

```bash
pip install -r requirements-dev.txt
python -m playwright install chromium
python -m pytest tests/ -q
```

## Deploy

`render.yaml` is a ready blueprint for [Render](https://render.com). In the
Render dashboard choose **New > Blueprint**, point it at this repository, and
set `SITE_ORIGIN` to your public address. It generates `SECRET_KEY` for you and
health-checks `/healthz`.

| Variable | What it does |
|---|---|
| `SECRET_KEY` | Required in production; the app refuses to start without it |
| `SITE_ORIGIN` | Your public address, for canonical links, the sitemap and share cards |
| `TRUST_PROXY_HEADERS` | `true` behind Render, nginx or Fly; enables HSTS |
| `FORCE_HTTPS` | `true` to redirect http to https |
| `YOUTUBE_FRAME_MAX_HEIGHT` | Video-moment resolution, default `2160`; use `1080` on a small instance |
| `YOUTUBE_FULL_FRAMES` | `false` to fall back to YouTube's low-resolution previews |
| `MAX_IMPORT_UPLOAD_MB` | Server-side PDF and PowerPoint conversion limit, default `50` |
| `OFFLINE_SHELL` | `off` to remotely remove the offline cache if a release misbehaves |

A 4K video frame needs real CPU. On Render's free plan the first frame from a
4K video can take a minute, so use a paid plan or lower
`YOUTUBE_FRAME_MAX_HEIGHT`.

## How it is built

- **Server:** Python and Flask. It converts uploaded PowerPoint files, serves
  the offline shell, proxies YouTube search and cuts video frames.
- **Client:** plain HTML, CSS and JavaScript with no framework and no build
  step. The drawing engine is written directly on the HTML canvas.
- **Storage:** local-first, in `localStorage` and IndexedDB.
- **Offline:** a service worker caches the app itself after the first visit.

## Credits

- Icons: [Lucide](https://github.com/lucide-icons/lucide) (ISC),
  [Phosphor](https://github.com/phosphor-icons/core) (MIT) and
  [Remix Icon](https://github.com/Remix-Design/RemixIcon) (Remix Icon License
  v1.0). Their licences are in `static/icons/LICENSES.md`; they are not
  covered by this project's licence.
- Typefaces: Space Grotesk, Archivo and JetBrains Mono (SIL Open Font
  License), self-hosted in `static/fonts/`.
- PDF rendering in the browser: [PDF.js](https://github.com/mozilla/pdf.js)
  and [pdf-lib](https://github.com/Hopding/pdf-lib).
- The border beam, sliding underline and odometer digits are ported by hand
  from [VengeanceUI](https://github.com/Ashutoshx7/VengeanceUI) (MIT).

## Licence

[MIT](LICENSE). Created by [@kshitizarc](https://www.linkedin.com/in/kshitiz47/).
