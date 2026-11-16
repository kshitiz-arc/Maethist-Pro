<h1>
    Inkyscib
  <img src="static/logo.ico" alt="Inkyscib Logo" width="40" align="center">
</h1>

**A free, ad-free study and teaching workspace that runs in your browser — on any device, even a cheap tablet.**

Import your textbooks, watch your lectures, take handwritten notes, and stay focused — all in one tab. No login. No ads. Nothing you have to pay for.

> Live canvas · PDF & PowerPoint import · handwriting · slide annotation · YouTube lectures · Pomodoro · multi-notebook library · offline backup

---

## Why I built this

I own a Lenovo tablet, not an iPad.

I wanted a simple place to make digital notes and study. So I tried the free apps — they were buried in ads. I tried the web apps — they were never quite enough for what a student actually needs. And the tools that *did* work properly, like the Apple Pencil + GoodNotes setup everyone recommends, cost more than the tablet itself.

So I built the thing I wished existed: **one calm, free place where a student or a teacher can study and teach — without ads, without paying, and without needing expensive hardware.**

Inkyscib is for the people who got priced out. For students on budget Android tablets. For teachers who just want to mark up a slide and explain it. For anyone who wants to learn without an app fighting for their attention.

---

## What you can do with it

Everything below exists for one reason: **so you can study from your own material, in one place.**

### 📚 Study from your own books and slides
- Import a **PDF** (your textbook, notes, a question paper) and write directly on top of it.
- Import a **PowerPoint** (`.ppt` / `.pptx`), annotate it live, and move slide by slide.
- **Export** your annotated work back out as a clean **PDF** or **PPTX** to keep or share.

### ✍️ Write and draw naturally
- An infinite canvas with smooth, pressure-aware strokes.
- Multiple pen feels — **default, fountain, brush, gel, and calligraphy**.
- Highlighter, eraser, shapes, straight lines with arrows, and a selection tool to move and resize what you've drawn.
- Fast **undo / redo**.

### 📓 Notebook mode
Switch from the infinite canvas to clean, page-based notes (A4-style pages), then save your handwritten work as a **PDF**.

### 📒 Keep every subject in its own notebook
- A **My Notebooks** library: create, rename, and switch between as many notebooks as you need — Physics, Chemistry, Math — each with its own canvas, pages, or imported deck, and a live preview card.
- **Backup & restore**: export your whole library as a single `.inky` file and bring it back on any device. No account, no cloud — it's your file, on your device.

### 🎥 Learn while you study
Search and play **YouTube lectures** in a floating, draggable window — so you can watch and take notes side by side, without juggling tabs.

Pause on an important explanation and save that **video moment onto the canvas** with one click. Inkyscib downloads a lightweight preview directly from YouTube, compresses and stores it in your browser, and never sends capture work to the Inkyscib server. Move it, resize it freely, annotate around it, then double-tap it later to reopen the lecture at the exact saved timestamp.

### 🍅 Stay focused
A built-in **Pomodoro timer** to work in focused sessions. No ads, no clutter, nothing pulling your attention away.

### ✨ AR Inky *(experimental)*
On a laptop with a webcam, draw in the air with your finger using hand tracking. It's an experiment — a glimpse of where Inkyscib could go for live teaching.

---

## Why Inkyscib is different

- **Free, and ad-free.** No subscriptions, no paywalls, no banners.
- **No account needed.** Open it and start. Your work is saved right in your browser.
- **Runs anywhere.** It's a web app — it works on a budget Android tablet, an old laptop, or a phone. No app store, no install.
- **Built for studying, not for selling you things.** Every feature serves learning.

---

## How it's built

Inkyscib is a solo project. I came up with the problem and designed every feature myself, and built it with the help of AI coding tools.

- **Backend:** Python + Flask. The PowerPoint and PDF import/export is handled server-side (PowerPoint files are parsed from the raw Office Open XML format; PDFs are rendered with PyMuPDF).
- **Frontend:** Plain HTML, CSS, and vanilla JavaScript — no framework, no build step. The drawing engine is built directly on the HTML Canvas. The two typefaces are self-hosted from `static/fonts/`, so a visit sends nothing to a font CDN.
- **Storage:** Local-first. Your drawings and preferences are saved in your browser (localStorage + IndexedDB), so nothing leaves your device.

---

## Run it locally

```bash
# 1. Install dependencies
pip install -r requirements.txt      # add -r requirements-dev.txt to run the tests

# 2. Start the app
python app.py

# 3. Open it
#    http://127.0.0.1:10000
```

For production, run it behind Gunicorn:

```bash
gunicorn wsgi:app
```

**Deploying to Render:** `render.yaml` is a ready blueprint. In the Render
dashboard choose *New > Blueprint*, point it at this repository, and set
`SITE_ORIGIN` to your public address. It generates `SECRET_KEY` for you and
health-checks `/healthz`.

**In production**, these environment variables matter — see
`docs/seo/search-console.md` for the SEO ones:

```bash
SECRET_KEY=...                       # required; the app refuses to start without it
INKYSCIB_ENV=production              # set automatically on Render
YOUTUBE_FRAME_MAX_HEIGHT=2160        # video-moment resolution; 1080 on a small instance
OFFLINE_SHELL=on                     # set to off to remotely remove the offline cache
MAX_IMPORT_UPLOAD_MB=50              # server-side PDF/PowerPoint conversion limit
SITE_ORIGIN=https://your-domain      # canonical URLs, sitemap, social cards
TRUST_PROXY_HEADERS=true             # behind nginx/Render/Fly; enables HSTS
FORCE_HTTPS=true                     # 301 http -> https
SEARCH_CONSOLE_TOKEN=...             # optional, verification only
```

And drop the IP out of Gunicorn's access log while you're there — the app's own
logs are scrubbed by `logging_filters.py`, but Gunicorn writes its own, and it
doesn't need to know who asked:

```bash
gunicorn wsgi:app --access-logformat '%(t)s "%(r)s" %(s)s %(b)s %(M)sms'
```

**Notes**
- **No analytics.** Version 2 removed Google Analytics and the cookie banner. A visit sends nothing to any third party unless you open a YouTube lecture.
- **Works offline.** After one visit online, the canvas opens with no connection: a service worker keeps a copy of the app itself. Your notes were always stored on your device.
- **Saved video moments** are cut from the video itself at its own resolution, up to 4K (3840×2160), as high-quality JPEG. A 4K decode needs real CPU: on Render's free plan the first frame of a 4K video can take a minute, so use a paid plan or set `YOUTUBE_FRAME_MAX_HEIGHT=1080`. `YOUTUBE_FULL_FRAMES=false` falls back to YouTube's low-resolution preview images.
- **Your notes are protected from eviction where the browser allows it** (`navigator.storage.persist()`), and after two days of work without a backup Inkyscib reminds you to download one.
- **PDF import** works on any platform (via PyMuPDF).
- **PowerPoint import** is best on Windows with Microsoft PowerPoint installed (used for the highest-fidelity rendering). Without it, Inkyscib falls back to a built-in basic `.pptx` renderer.

---

## Credits

The border beam, the sliding link underline and the odometer digits are ported
by hand from [VengeanceUI](https://github.com/Ashutoshx7/VengeanceUI) (MIT, by
Ashutosh). Inkyscib has no build step, so nothing is installed — the techniques
are rewritten in plain CSS against this project's own tokens. See
`static/css/vengeance.css`.

## License

[MIT](LICENSE) © 2025 Salaj — free to use, learn from, and build on.

Created by [@kshitizarc](https://www.linkedin.com/in/kshitiz47/).
