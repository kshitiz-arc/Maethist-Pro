# Inkyscib Discoverability & Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Two parts.** **Part I (Tasks 1-16)** is discoverability: the 20-item SEO checklist.
**Part II (Tasks 17-27)** is legal, privacy and compliance. They share one spine --
`SITE_ORIGIN`, the template head, and the test modules -- so Part II assumes Part I has
landed. Read Part II's opening section before starting it: it changes one of Part I's
decisions (Task 24 supersedes the font handling in Task 10) and names a product
decision worth taking first.

**Goal:** Make Inkyscib's public pages findable by Google, Bing and LLM crawlers — crawlable (robots, sitemap, canonicals), legible (titles, descriptions, headings, schema), fast and correct on a phone, and served only over HTTPS.

**Architecture:** Everything is server-rendered, inside the existing Flask app and Jinja templates. One module-level helper (`site_url`) plus one context processor supply the absolute public origin to every template, driven by a `SITE_ORIGIN` environment variable with a request-derived fallback, so no domain is ever hardcoded. Three new plain-text/XML routes (`/robots.txt`, `/sitemap.xml`, `/llms.txt`) and one new test module, `tests/test_seo.py`, pin the invariants so a future page cannot silently drop out of the index.

**Tech Stack:** Python 3 + Flask 3, Jinja2, vanilla CSS/JS (no build step), Pillow, Playwright (dev-only; tests skip without it), pytest/unittest.

**Spec:** This plan is its own spec. The source requirement is the 20-item checklist reproduced in **Appendix A**, mapped item-by-item to tasks — including the three items that are not code.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline is 319 passed / 0 failed, 244 subtests, ~10 minutes** (2026-09-19). The suite is green: treat *any* failure as yours until proven otherwise. Run `python -m pytest tests/ -q`.
- **`DESIGN.md` is the authority on anything visual.** Read it before touching CSS. The heading-level changes in this plan must render **pixel-identical**: when a tag changes, its selector in `static/css/marketing.css` changes in the same commit.
- **One token vocabulary.** Do not invent a `--seo-*` palette. The touch-target floor is `var(--tap)` (44px, `static/css/tokens.css:68`).
- **CSP:** `CONTENT_SECURITY_POLICY` at `app.py:1061` already carries `script-src 'self' 'unsafe-inline' …`, so inline `<script type="application/ld+json">` and an inline `onload` attribute are permitted. **Adding any new external origin means editing both `app.py:1061` and `tests/test_analytics_csp.py`.** This plan adds none.
- **No new runtime dependency.** `requirements.txt` is unchanged. Playwright and the one-off image tool are dev-only.
- **The public origin lives in exactly one place:** `SITE_ORIGIN` (env var, read in `app.py`). Never write a domain literal into a template, a test, or `robots.txt`.
- **Browser-test conventions** (none are enforced; all four have caused false failures here):
  - Dismiss the first-run tour via `localStorage['inkyscib-feature-tour-v1']` in an `add_init_script`.
  - Start the server with `make_browser_server(app)` from `tests/browser_server.py` — never a random port.
  - Pass `wait_for_function` an arrow function, never a bare expression (CSP forbids `eval`).
  - Use `state="attached"`, not visibility, for editor chrome.
- **Flask caches templates.** Restart the dev server after editing a template when verifying by hand.
- **Git:** `.git` exists with a single commit (`401f803`) even though `CLAUDE.md` says the project is not a repository. The commit steps assume `git` works; if the user does not want history, skip every "Commit" step — nothing else depends on it.

---

## Scope Check

This is one subsystem — the public surface of one Flask app — so it is one plan. Three checklist items are **not code**, and are labelled as such: #19 (backlinks) produces a document, #20 (Search Console) produces a verification value plus a manual submission, and part of #14 (Core Web Vitals on `/write`) is deliberately deferred; see **Out of Scope**.

---

## What is already true (do not redo)

Verified in the working tree on 2026-09-20:

| Already done | Where |
|---|---|
| `<meta name="viewport">` on every page | `templates/_marketing.html:5`, `templates/write.html:6` |
| Per-page `{% block title %}` / `{% block description %}` machinery | `templates/_marketing.html:11-12` |
| Gzip for static assets, one-year `SEND_FILE_MAX_AGE_DEFAULT`, `v=` cache-busting | `app.py:55`, `app.py:~1150` |
| HSTS when the request is secure | `app.py:1214` |
| Clean, lowercase, hyphen-free URL slugs (`/`, `/features`, `/about`, `/write`) | `app.py:1220-1236` |
| GA4 installed and CSP-allowed | `templates/_marketing.html:40-47`, `tests/test_analytics_csp.py` |
| Both `<img>` tags carry `alt`, `width` and `height` | `templates/about.html:66`, `:139` |
| Contextual internal links (`/features#geometry`, `#material`, `#focus`) | `templates/home.html` |
| **No `noindex` anywhere** — checklist item 3 is already satisfied; Task 4 adds the regression test that keeps it that way | grep of `templates/` |

## What is missing (the work)

No canonical tags · no `robots.txt` · no `sitemap.xml` · no `llms.txt` · no Open Graph or Twitter card · no social share image · no structured data · no `<h1>` on `/features`, `/about` or `/write` · heading levels skip a rank once that is fixed · no meta description on `/write` · no `noindex` on `/lab/ink` or the 404 · no HTTPS redirect (HSTS asserts, it does not redirect) · no link-integrity test · no mobile-overflow test.

---

## Out of Scope (flagged, not silently dropped)

- **The `/write` payload (part of #14).** The editor loads **52 `<script>` tags** and ~3.5 MB of JS. Bundling or lazy-loading that is a project of its own with real regression risk, and it does not move rankings — `/write` is the destination; the marketing pages are what rank. This plan makes `/write` *indexable and well-described*, and applies the Core Web Vitals work (Task 10) to `/`, `/features` and `/about`. Recommend a separate plan for the editor's load cost.
- **`templates/home-classic.html`** is dead: no route renders it. Every test here excludes it. Recommend deleting it separately; leaving it invites someone to "fix the SEO" of a page that does not exist.
- **Self-hosting the Google Fonts files.** Task 10 makes the font stylesheet non-blocking, which is most of the win. Self-hosting removes a third-party origin entirely but changes `CONTENT_SECURITY_POLICY` and adds ~200 KB of woff2 to the repo. Noted, not done here.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `tests/test_seo.py` | Every crawler-facing invariant a test client can see: canonicals, robots, sitemap, titles, descriptions, headings, schema, link integrity. Fast — no browser. |
| `tests/test_seo_browser.py` | The two things a test client cannot see: render-blocking structure / layout shift, and mobile overflow. Playwright; skips without it. |
| `templates/llms.txt` | The llms.txt document, as a Jinja template so its links render absolute. |
| `tools/make_og_image.py` | One-off: screenshots `/` at 1200×630 with Playwright, quantises with Pillow, writes the share image. |
| `static/img/og-cover.png` | The Open Graph / Twitter share image (generated, committed). |
| `docs/seo/backlink-strategy.md` | Checklist item 19 — a dated, per-target list. Not a code change. |
| `docs/seo/search-console.md` | Checklist item 20 — verification and submission runbook. |

**Modified**

| File | Change |
|---|---|
| `app.py` | `Response` import; `SITE_ORIGIN` + `site_url()`; canonical context processor; `/robots.txt`, `/sitemap.xml`, `/llms.txt` routes; `SITEMAP_ROUTES`; HTTPS redirect + `ProxyFix`. |
| `templates/_marketing.html` | Canonical, Open Graph, Twitter card, JSON-LD block, non-blocking font stylesheet, optional Search Console meta. |
| `templates/write.html` | Canonical, description, better title, OG tags, a visually-hidden `<h1>`, non-blocking font stylesheet. |
| `templates/home.html` | Its own `{% block description %}`, `SoftwareApplication` JSON-LD, one more contextual link. |
| `templates/features.html` | `h2→h1`, `h3→h2`, `h4→h3`; tightened title/description; breadcrumb JSON-LD; per-section CTA links. |
| `templates/about.html` | The same heading shift; breadcrumb, `Person` and `Organization` JSON-LD. |
| `templates/404.html` | `noindex` meta. |
| `templates/lab_ink.html` | `noindex, nofollow` meta. |
| `static/css/marketing.css` | Heading selectors follow the tag shift; `var(--tap)` floor on nav links and the CTA at the mobile breakpoint. |

---

## Task 1: The public origin and canonical URLs

Checklist #4. Everything downstream (sitemap, OG, schema) needs one absolute-URL source, so it is built first.

**Files:**
- Modify: `app.py:25` (import), `app.py:56` (config), `app.py:59` (context processors)
- Modify: `templates/_marketing.html:12`, `templates/write.html:12`
- Test: `tests/test_seo.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `app.SITE_ORIGIN: str` (`""` when unset); `app.site_url(path: str = "/") -> str` (absolute URL, no doubled slash); template globals `canonical_url: str` and `site_url` (callable). Tasks 2, 3, 6, 7 and 14 all consume `site_url`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_seo.py`:

```python
"""Crawler-facing invariants for the public pages.

Test-client only, so the whole module runs in well under a second. Anything
that needs a real browser lives in tests/test_seo_browser.py.
"""

import datetime
import re
import unittest
from unittest import mock
from xml.etree import ElementTree as ET

import app as app_module
from app import app

INDEXABLE_PAGES = ("/", "/features", "/about", "/write")


class CanonicalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_each_page_declares_exactly_one_canonical_on_the_request_origin(self):
        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                response = self.client.get(path, base_url="https://inkyscib.test")
                html = response.get_data(as_text=True)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(html.count('rel="canonical"'), 1)
                self.assertIn(
                    f'<link rel="canonical" href="https://inkyscib.test{path}">',
                    html,
                )

    def test_site_origin_overrides_the_request_origin(self):
        with mock.patch.object(app_module, "SITE_ORIGIN", "https://inkyscib.com"):
            html = self.client.get(
                "/features", base_url="http://127.0.0.1:8977"
            ).get_data(as_text=True)

        self.assertIn(
            '<link rel="canonical" href="https://inkyscib.com/features">', html
        )

    def test_site_url_normalises_slashes_at_both_joins(self):
        with mock.patch.object(app_module, "SITE_ORIGIN", "https://inkyscib.com/"):
            with app.test_request_context("/"):
                self.assertEqual(
                    app_module.site_url("features"), "https://inkyscib.com/features"
                )
                self.assertEqual(app_module.site_url(), "https://inkyscib.com/")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py -q`
Expected: FAIL — `AttributeError: module 'app' has no attribute 'SITE_ORIGIN'`, and the canonical assertions fail because nothing renders `rel="canonical"`.

- [ ] **Step 3: Add the origin helper to `app.py`**

Extend the Flask import at `app.py:25`:

```python
from flask import Flask, Response, jsonify, render_template, request, send_file, url_for
```

Immediately after `app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 31536000` (`app.py:56`):

```python
# The public origin, used for canonical URLs, the sitemap, social cards and
# llms.txt. Set SITE_ORIGIN in production (e.g. https://inkyscib.com). Left
# unset, the app falls back to the origin the request arrived on, which is
# right for a local run and harmless on a single-domain deployment. Nothing
# else in the codebase may hardcode a domain.
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "").strip().rstrip("/")


def site_url(path="/"):
    """Absolute URL for a site-relative path, on the configured public origin."""
    if not path.startswith("/"):
        path = "/" + path
    origin = SITE_ORIGIN or request.url_root.rstrip("/")
    return origin + path
```

- [ ] **Step 4: Expose it to every template**

Next to `inject_current_year` (`app.py:59`), add a second context processor:

```python
@app.context_processor
def inject_canonical():
    # request.path drops the query string, which is what a canonical wants:
    # /write?planner=1 and /write are the same document to a crawler.
    return {"canonical_url": site_url(request.path), "site_url": site_url}
```

- [ ] **Step 5: Render it**

In `templates/_marketing.html`, directly below the `<title>` line:

```html
  <link rel="canonical" href="{{ canonical_url }}">
```

In `templates/write.html`, directly below its `<title>` line:

```html
  <link rel="canonical" href="{{ canonical_url }}">
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (3 tests)

- [ ] **Step 7: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: 322 passed, 0 failed.

- [ ] **Step 8: Commit**

```bash
git add app.py templates/_marketing.html templates/write.html tests/test_seo.py
git commit -m "feat(seo): canonical URLs from a single configurable public origin"
```

---

## Task 2: robots.txt

Checklist #2.

**Files:**
- Modify: `app.py` (new route, after `lab_ink`, around `app.py:1260`)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `site_url` (Task 1).
- Produces: `GET /robots.txt` → `text/plain`, advertising `/sitemap.xml` (built in Task 3).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
class RobotsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_robots_is_plain_text_and_allows_the_public_pages(self):
        response = self.client.get("/robots.txt", base_url="https://inkyscib.test")
        body = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.mimetype.startswith("text/plain"))
        self.assertIn("User-agent: *", body)
        self.assertIn("Allow: /", body)

    def test_robots_keeps_crawlers_out_of_the_api_and_the_lab(self):
        body = self.client.get("/robots.txt").get_data(as_text=True)

        self.assertIn("Disallow: /api/", body)
        self.assertIn("Disallow: /lab/", body)

    def test_robots_points_at_an_absolute_sitemap_on_the_public_origin(self):
        body = self.client.get(
            "/robots.txt", base_url="https://inkyscib.test"
        ).get_data(as_text=True)

        self.assertIn("Sitemap: https://inkyscib.test/sitemap.xml", body)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::RobotsTests -q`
Expected: FAIL — `AssertionError: 404 != 200`.

- [ ] **Step 3: Add the route**

In `app.py`, after the `lab_ink` route:

```python
@app.route("/robots.txt")
def robots_txt():
    """Crawl policy. The API returns JSON or binaries and the lab is an
    unfinished prototype, so neither is worth a crawl budget."""
    body = "\n".join([
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /lab/",
        "",
        f"Sitemap: {site_url('/sitemap.xml')}",
        "",
    ])
    return Response(body, mimetype="text/plain")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_seo.py
git commit -m "feat(seo): serve robots.txt advertising the sitemap"
```

---

## Task 3: sitemap.xml, with a coverage guard

Checklist #1. The last test here is the one that pays off later: it fails when someone adds a page and forgets the sitemap.

**Files:**
- Modify: `app.py` (route table + route, below `robots_txt`)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `site_url` (Task 1).
- Produces: `app.SITEMAP_ROUTES: tuple[tuple[str, str, str], ...]` — `(path, changefreq, priority)`, imported by the tests; `app.SITEMAP_TEMPLATES: dict[str, str]`; `GET /sitemap.xml` → `application/xml`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


class SitemapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def _locs(self):
        response = self.client.get("/sitemap.xml", base_url="https://inkyscib.test")
        self.assertEqual(response.status_code, 200)
        self.assertIn("xml", response.mimetype)
        root = ET.fromstring(response.get_data())
        return [node.text for node in root.findall("sm:url/sm:loc", SITEMAP_NS)]

    def test_sitemap_lists_every_indexable_page_absolutely_and_once(self):
        locs = self._locs()

        self.assertEqual(len(locs), len(set(locs)))
        self.assertEqual(
            set(locs),
            {f"https://inkyscib.test{path}" for path in INDEXABLE_PAGES},
        )

    def test_every_url_in_the_sitemap_actually_serves_200(self):
        for path, _changefreq, _priority in app_module.SITEMAP_ROUTES:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)

    def test_each_entry_carries_a_real_lastmod_date(self):
        root = ET.fromstring(self.client.get("/sitemap.xml").get_data())
        stamps = [node.text for node in root.findall("sm:url/sm:lastmod", SITEMAP_NS)]

        self.assertEqual(len(stamps), len(INDEXABLE_PAGES))
        for stamp in stamps:
            with self.subTest(stamp=stamp):
                datetime.date.fromisoformat(stamp)  # raises if it is not a date

    def test_no_page_route_can_be_added_without_a_sitemap_or_exclusion_decision(self):
        """The guard that keeps this file honest a year from now."""
        deliberately_excluded = {
            "/lab/ink",   # unfinished prototype, Disallowed in robots.txt
            "/robots.txt",
            "/sitemap.xml",
            "/llms.txt",
        }
        page_routes = {
            str(rule)
            for rule in app.url_map.iter_rules()
            if "GET" in rule.methods
            and "<" not in str(rule)
            and not str(rule).startswith(("/api/", "/static"))
        }
        listed = {path for path, _, _ in app_module.SITEMAP_ROUTES}

        self.assertEqual(page_routes - listed - deliberately_excluded, set())
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::SitemapTests -q`
Expected: FAIL — 404 on `/sitemap.xml`, `AttributeError` on `SITEMAP_ROUTES`.

- [ ] **Step 3: Add the route**

In `app.py`, below `robots_txt`:

```python
# (path, changefreq, priority). The template a path renders gives its
# <lastmod>: a stamp of "today" on every request is a claim no crawler
# believes, and a template's mtime is the closest honest answer available
# without a git history to read.
SITEMAP_ROUTES = (
    ("/", "weekly", "1.0"),
    ("/write", "weekly", "0.9"),
    ("/features", "monthly", "0.8"),
    ("/about", "monthly", "0.5"),
)

SITEMAP_TEMPLATES = {
    "/": "home.html",
    "/write": "write.html",
    "/features": "features.html",
    "/about": "about.html",
}


def _template_lastmod(path):
    template = Path(app.root_path) / "templates" / SITEMAP_TEMPLATES[path]
    stamp = datetime.datetime.fromtimestamp(
        template.stat().st_mtime, datetime.timezone.utc
    )
    return stamp.date().isoformat()


@app.route("/sitemap.xml")
def sitemap_xml():
    entries = "".join(
        "<url>"
        f"<loc>{site_url(path)}</loc>"
        f"<lastmod>{_template_lastmod(path)}</lastmod>"
        f"<changefreq>{changefreq}</changefreq>"
        f"<priority>{priority}</priority>"
        "</url>"
        for path, changefreq, priority in SITEMAP_ROUTES
    )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{entries}"
        "</urlset>"
    )
    return Response(body, mimetype="application/xml")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (10 tests). If the coverage guard fails, a route exists that this plan has not classified — add it to `SITEMAP_ROUTES`, or to `deliberately_excluded` with a comment saying why.

- [ ] **Step 5: Verify by hand**

```bash
python -c "import os; os.environ['SITE_ORIGIN']='https://inkyscib.com'; from app import app; c=app.test_client(); print(c.get('/sitemap.xml').get_data(as_text=True)); print(c.get('/robots.txt').get_data(as_text=True))"
```

Expected: four `<loc>` values on `https://inkyscib.com`, and a matching `Sitemap:` line.

- [ ] **Step 6: Commit**

```bash
git add app.py tests/test_seo.py
git commit -m "feat(seo): sitemap.xml with a route-coverage guard"
```

---

## Task 4: Titles, meta descriptions, and the two deliberate noindex tags

Checklist #3, #5, #6. `/write` has no description at all; `/features` has a 19-character title; the homepage description is 182 characters and gets cut. Two pages that must *not* be indexed get the only `noindex` tags on the site, and a test pins that no other page ever gets one.

> **Copy note for the reviewer:** the four titles are the load-bearing change here, and they are also brand copy. "the geometry is real" moves from the `<title>` into the description, where it still sells but no longer spends the ~60 characters Google shows. If the user prefers the old homepage title, keep it — every other part of this task stands.

**Files:**
- Modify: `templates/home.html:3`, `templates/features.html:3-4`, `templates/about.html:3`, `templates/write.html:12`, `templates/404.html:5`, `templates/lab_ink.html` (head)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: the `{% block title %}` / `{% block description %}` blocks already in `_marketing.html`.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
DESCRIPTION_RE = re.compile(r'<meta name="description" content="(.*?)"', re.S)


class TitleAndDescriptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True)
            for path in INDEXABLE_PAGES
        }

    def test_every_page_has_one_title_of_a_length_google_will_show_whole(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                titles = TITLE_RE.findall(html)
                self.assertEqual(len(titles), 1)
                self.assertTrue(20 <= len(titles[0]) <= 65, titles[0])
                self.assertIn("Inkyscib", titles[0])

    def test_every_page_has_one_description_in_the_snippet_window(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                descriptions = DESCRIPTION_RE.findall(html)
                self.assertEqual(len(descriptions), 1)
                self.assertTrue(80 <= len(descriptions[0]) <= 160, descriptions[0])

    def test_no_two_pages_share_a_title_or_a_description(self):
        titles = [TITLE_RE.findall(html)[0] for html in self.html.values()]
        descriptions = [DESCRIPTION_RE.findall(html)[0] for html in self.html.values()]

        self.assertEqual(len(set(titles)), len(titles))
        self.assertEqual(len(set(descriptions)), len(descriptions))

    def test_no_indexable_page_carries_a_noindex(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                self.assertNotIn("noindex", html)

    def test_the_prototype_and_the_404_are_kept_out_of_the_index(self):
        for path in ("/lab/ink", "/no-such-page"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('name="robots"', html)
                self.assertIn("noindex", html)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::TitleAndDescriptionTests -q`
Expected: FAIL — `/write` has no description, `/features`' title is 19 characters, the home description is 182, and neither `/lab/ink` nor the 404 carries a robots meta.

- [ ] **Step 3: Rewrite the titles and descriptions**

`templates/home.html`, replacing line 3:

```jinja
{% block title %}Inkyscib — free handwriting, geometry and PDF canvas{% endblock %}
{% block description %}A free, ad-free study canvas: handwritten notes, live ruler-and-compass geometry, algebra tiles and PDF annotation — in your browser, on any device.{% endblock %}
```

`templates/features.html`, replacing lines 3-4:

```jinja
{% block title %}Inkyscib features — handwriting, geometry, PDF and PPT{% endblock %}
{% block description %}Pen feels and highlighters, ruler-and-compass geometry that stays live, algebra tiles, PDF and PowerPoint annotation, notebooks, lectures and Pomodoro.{% endblock %}
```

`templates/about.html`, replacing line 3 (its description already measures 148 characters — leave it):

```jinja
{% block title %}About Inkyscib — who builds it, and why it stays free{% endblock %}
```

`templates/write.html`, replacing the `<title>` line:

```html
  <title>Open the canvas — write, draw and annotate | Inkyscib</title>
  <meta name="description" content="Open the Inkyscib canvas: handwrite notes, construct live geometry, annotate a PDF or a deck, and export clean vector PDF. Free, no account, offline." />
```

- [ ] **Step 4: Keep the prototype and the error page out of the index**

In `templates/lab_ink.html`, inside `<head>`:

```html
  <meta name="robots" content="noindex, nofollow" />
```

In `templates/404.html`, after the `<title>` line:

```html
  <meta name="robots" content="noindex" />
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (15 tests)

- [ ] **Step 6: Commit**

```bash
git add templates/ tests/test_seo.py
git commit -m "feat(seo): unique in-range titles and descriptions; noindex the lab and 404"
```

---
## Task 5: One `<h1>` per page, and a heading ladder with no gaps

Checklist #7, #8. `/features` and `/about` start at `<h2>` and have no `<h1>` at all; `/write` has no heading of any rank. Promoting the page title to `<h1>` then leaves a gap (`h1` → `h3`), so every rank below shifts up by one in the same commit, and each CSS selector moves with its tag so nothing changes visually.

**Files:**
- Modify: `templates/features.html` (1 × h2, 4 × h3, 12 × h4)
- Modify: `templates/about.html` (1 × h2, 4 × h3, and the `profile-name` h4s)
- Modify: `static/css/marketing.css:368`, `:396`, `:432`, `:509`
- Modify: `templates/write.html:170` (after `<body>`)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. `/write` gains `h1.sr-only`; `.sr-only` is already defined at `static/css/editor-chrome.css:806`, a stylesheet `write.html` already loads — do not define a second one.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
HEADING_RE = re.compile(r"<h([1-6])\b", re.I)


class HeadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True)
            for path in INDEXABLE_PAGES
        }

    def test_every_page_has_exactly_one_h1(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                levels = [int(level) for level in HEADING_RE.findall(html)]
                self.assertEqual(levels.count(1), 1, levels)

    def test_the_h1_is_the_first_heading_on_the_page(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                levels = [int(level) for level in HEADING_RE.findall(html)]
                self.assertEqual(levels[0], 1, levels)

    def test_the_heading_ladder_never_skips_a_rank(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                levels = [int(level) for level in HEADING_RE.findall(html)]
                for previous, current in zip(levels, levels[1:]):
                    self.assertLessEqual(
                        current - previous, 1, f"{path}: h{previous} -> h{current}"
                    )
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::HeadingTests -q`
Expected: FAIL on all three for `/features`, `/about` and `/write` (`levels.count(1) == 0`).

- [ ] **Step 3: Shift the ranks in the two content templates**

Top-down order matters: `h2→h1` first empties rank 2, so the next pass cannot double-promote.

```bash
cd "$(git rev-parse --show-toplevel)"
for f in templates/features.html templates/about.html; do
  sed -i 's|<h2\b|<h1|g; s|</h2>|</h1>|g' "$f"
  sed -i 's|<h3\b|<h2|g; s|</h3>|</h2>|g' "$f"
  sed -i 's|<h4\b|<h3|g; s|</h4>|</h3>|g' "$f"
done
git diff --stat templates/
```

Expected: `features.html` shows 34 changed lines, `about.html` about 18. Read `git diff templates/` before continuing — the two files must now open `<h1>Features</h1>` and `<h1>About</h1>` inside `.page-head`, with `.section-title` at `h2` and cards at `h3`.

- [ ] **Step 4: Move the CSS selectors with the tags**

In `static/css/marketing.css`, four selectors, which must change in this same commit or the pages reflow:

- `:368` `.page-head h2 {` → `.page-head h1 {`
- `:396` `.section-title h3 {` → `.section-title h2 {`
- `:432` `.card h4 {` → `.card h3 {`
- `:509` `.track-what h4 {` → `.track-what h3 {`

```bash
sed -i 's|^\.page-head h2 {|.page-head h1 {|; s|^\.section-title h3 {|.section-title h2 {|; s|^\.card h4 {|.card h3 {|; s|^\.track-what h4 {|.track-what h3 {|' static/css/marketing.css
grep -n "page-head h1\|section-title h2\|\.card h3\|track-what h3" static/css/marketing.css
```

Expected: four matches, one per selector.

**Checked before writing this task:** `write.html`'s existing ladder is `[2, 2, 2, 3]`, so inserting the `h1` below makes it `[1, 2, 2, 2, 3]` — no gap, no other edit needed there.

- [ ] **Step 5: Give the editor a heading**

In `templates/write.html`, immediately after `<body>` on line 170:

```html
  {# The editor is a canvas, not a document, so its heading is for screen
     readers and crawlers rather than sighted users. .sr-only comes from
     editor-chrome.css, which this page already loads. #}
  <h1 class="sr-only">Inkyscib — the writing canvas</h1>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (18 tests)

- [ ] **Step 7: Confirm nothing moved on screen**

Start the app (`python -c "import os; os.environ.setdefault('SECRET_KEY','dev'); from app import app; app.run(host='127.0.0.1', port=8977)"`), open `/features` and `/about` at 1440px and at 390px, and compare against `DESIGN.md`'s typographic scale. The page title stays `clamp(2rem, 5vw, 3rem)`; section titles and card titles keep their sizes. Any visible change means a selector was missed.

- [ ] **Step 8: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: 337 passed, 0 failed. A failure in an existing browser test almost certainly means a selector in that test targets `h2`/`h3`/`h4` on a marketing page — update the selector, do not revert the ladder.

- [ ] **Step 9: Commit**

```bash
git add templates/ static/css/marketing.css tests/test_seo.py
git commit -m "feat(seo): one h1 per page and a gapless heading ladder"
```

---

## Task 6: Open Graph, Twitter cards, and a share image

Not on the 20-item list by name, but it is what makes a shared link look like a product instead of a bare URL, and it is the other half of #13 (the only substantial image this site serves). Do it before schema so the image URL exists for both.

**Files:**
- Create: `tools/make_og_image.py`
- Create: `static/img/og-cover.png` (generated)
- Modify: `templates/_marketing.html` (head), `templates/write.html` (head)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `site_url`, `canonical_url` (Task 1); the `title`/`description` blocks (Task 4).
- Produces: `static/img/og-cover.png`, 1200×630 PNG, under 300 KB.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py` (and add `from pathlib import Path` plus `from PIL import Image` to the imports):

```python
OG_COVER = Path(app.root_path) / "static" / "img" / "og-cover.png"


class SocialCardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path, base_url="https://inkyscib.test").get_data(
                as_text=True
            )
            for path in INDEXABLE_PAGES
        }

    def test_every_page_carries_the_four_required_open_graph_properties(self):
        for path, html in self.html.items():
            for prop in ("og:title", "og:description", "og:url", "og:image"):
                with self.subTest(path=path, prop=prop):
                    self.assertEqual(html.count(f'property="{prop}"'), 1)

    def test_the_og_url_matches_the_canonical(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                self.assertIn(
                    f'<meta property="og:url" content="https://inkyscib.test{path}"',
                    html,
                )

    def test_the_share_image_is_absolute_and_declares_its_size(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                self.assertIn(
                    'property="og:image" content="https://inkyscib.test/static/img/og-cover.png',
                    html,
                )
                self.assertIn('property="og:image:width" content="1200"', html)
                self.assertIn('property="og:image:height" content="630"', html)
                self.assertIn('name="twitter:card" content="summary_large_image"', html)

    def test_the_share_image_exists_at_the_size_it_claims_and_stays_small(self):
        self.assertTrue(OG_COVER.exists(), f"run: python tools/make_og_image.py")
        with Image.open(OG_COVER) as image:
            self.assertEqual(image.size, (1200, 630))
        self.assertLess(OG_COVER.stat().st_size, 300 * 1024)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::SocialCardTests -q`
Expected: FAIL — no `og:` tags, and `og-cover.png` does not exist.

- [ ] **Step 3: Add the tags to the shared head**

In `templates/_marketing.html`, after the canonical link:

```html
  {# Social cards. og:title/og:description reuse the page's own blocks via
     Jinja's self, so there is exactly one place to change the copy. #}
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Inkyscib" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="{{ self.title() }}" />
  <meta property="og:description" content="{{ self.description() }}" />
  <meta property="og:url" content="{{ canonical_url }}" />
  <meta property="og:image" content="{{ site_url(url_for('static', filename='img/og-cover.png', v='og-1')) }}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="The Inkyscib homepage: a live ruler-and-compass construction beside the words 'the geometry is real'." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{{ self.title() }}" />
  <meta name="twitter:description" content="{{ self.description() }}" />
  <meta name="twitter:image" content="{{ site_url(url_for('static', filename='img/og-cover.png', v='og-1')) }}" />
```

- [ ] **Step 4: Add the same tags to the editor**

`write.html` does not extend `_marketing.html`, so it needs them literally. After its canonical link:

```html
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Inkyscib" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:title" content="Open the canvas — write, draw and annotate | Inkyscib" />
  <meta property="og:description" content="Open the Inkyscib canvas: handwrite notes, construct live geometry, annotate a PDF or a deck, and export clean vector PDF. Free, no account, offline." />
  <meta property="og:url" content="{{ canonical_url }}" />
  <meta property="og:image" content="{{ site_url(url_for('static', filename='img/og-cover.png', v='og-1')) }}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="The Inkyscib homepage: a live ruler-and-compass construction beside the words 'the geometry is real'." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Open the canvas — write, draw and annotate | Inkyscib" />
  <meta name="twitter:description" content="Open the Inkyscib canvas: handwrite notes, construct live geometry, annotate a PDF or a deck, and export clean vector PDF. Free, no account, offline." />
  <meta name="twitter:image" content="{{ site_url(url_for('static', filename='img/og-cover.png', v='og-1')) }}" />
```

- [ ] **Step 5: Write the image generator**

Create `tools/make_og_image.py`:

```python
"""Generate static/img/og-cover.png, the 1200x630 social share card.

Run it again whenever the homepage hero changes:

    python tools/make_og_image.py

It screenshots the real homepage rather than compositing a mock, so the card
cannot drift from what a visitor actually lands on. Playwright is a dev-only
dependency; the app does not need it to run.
"""

import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from app import app  # noqa: E402
from browser_server import make_browser_server  # noqa: E402

OUTPUT = ROOT / "static" / "img" / "og-cover.png"


def main():
    server = make_browser_server(app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_port}"

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 1200, "height": 630}, device_scale_factor=1
        )
        # The first-run tour would otherwise cover the hero.
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        page.goto(f"{base_url}/", wait_until="networkidle")
        page.wait_for_timeout(800)  # the hero's construction settles
        page.screenshot(path=str(OUTPUT))
        browser.close()

    server.shutdown()

    # The card is flat brand colour and line art, so a 256-colour palette is
    # visually lossless here and cuts the file by roughly two thirds.
    with Image.open(OUTPUT) as raw:
        quantised = raw.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT)
        quantised.save(OUTPUT, optimize=True)

    print(f"{OUTPUT} -> {OUTPUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Generate the image**

Run: `python tools/make_og_image.py`
Expected: a printed path and a size under 300 KB. Open the PNG and look at it — if the hero animation caught mid-sweep or the theme came out dark, raise the `wait_for_timeout` or set `data-theme` in the init script, and run it again.

- [ ] **Step 7: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (22 tests)

- [ ] **Step 8: Commit**

```bash
git add tools/make_og_image.py static/img/og-cover.png templates/ tests/test_seo.py
git commit -m "feat(seo): Open Graph and Twitter cards with a generated share image"
```

---

## Task 7: Structured data (JSON-LD)

Checklist #10. Three blocks: the product itself on the homepage, the people and organisation on `/about`, and breadcrumbs on the two inner pages.

> **Do not add `aggregateRating`, `review`, or an `FAQPage` whose questions are not visible on the page.** Rating markup without real ratings is a manual-action risk, and Google dropped FAQ rich results for most sites in 2023 anyway. If an FAQ is wanted later, write the questions into `/features` as visible copy first, then mark them up.

**Files:**
- Modify: `templates/_marketing.html` (a `structured_data` block before `</head>`)
- Modify: `templates/home.html`, `templates/features.html`, `templates/about.html`
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `site_url`, `canonical_url` (Task 1); the OG image path (Task 6).
- Produces: one or two `<script type="application/ld+json">` blocks per marketing page.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py` (add `import json` to the imports):

```python
LD_JSON_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.S
)


class StructuredDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def _blocks(self, path):
        html = self.client.get(path, base_url="https://inkyscib.test").get_data(
            as_text=True
        )
        return [json.loads(raw) for raw in LD_JSON_RE.findall(html)]

    def test_every_block_on_every_page_is_valid_json_ld(self):
        for path in ("/", "/features", "/about"):
            with self.subTest(path=path):
                blocks = self._blocks(path)  # json.loads raises on bad JSON
                self.assertTrue(blocks)
                for block in blocks:
                    self.assertEqual(block["@context"], "https://schema.org")
                    self.assertIn("@type", block)

    def test_the_homepage_describes_the_product_as_free_software(self):
        types = {block["@type"] for block in self._blocks("/")}
        self.assertIn("SoftwareApplication", types)

        product = next(
            block for block in self._blocks("/")
            if block["@type"] == "SoftwareApplication"
        )
        self.assertEqual(product["offers"]["price"], "0")
        self.assertEqual(product["offers"]["priceCurrency"], "USD")
        self.assertEqual(product["applicationCategory"], "EducationalApplication")
        self.assertTrue(product["url"].startswith("https://inkyscib.test"))

    def test_the_inner_pages_carry_breadcrumbs_that_point_at_real_urls(self):
        for path in ("/features", "/about"):
            with self.subTest(path=path):
                crumbs = next(
                    block for block in self._blocks(path)
                    if block["@type"] == "BreadcrumbList"
                )
                items = crumbs["itemListElement"]
                self.assertEqual([item["position"] for item in items], [1, 2])
                self.assertEqual(items[0]["item"], "https://inkyscib.test/")
                self.assertEqual(items[1]["item"], f"https://inkyscib.test{path}")

    def test_no_page_claims_a_rating_or_a_review(self):
        """Fabricated ratings are a manual-action risk; keep it impossible."""
        for path in ("/", "/features", "/about"):
            with self.subTest(path=path):
                raw = json.dumps(self._blocks(path))
                self.assertNotIn("aggregateRating", raw)
                self.assertNotIn("reviewCount", raw)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::StructuredDataTests -q`
Expected: FAIL — `self.assertTrue(blocks)` fails; no page emits JSON-LD.

- [ ] **Step 3: Open a slot in the shared head**

In `templates/_marketing.html`, immediately before `</head>`:

```html
  {% block structured_data %}{% endblock %}
```

- [ ] **Step 4: Describe the product on the homepage**

In `templates/home.html`, after the `description` block:

```jinja
{% block structured_data %}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Inkyscib",
  "url": "{{ site_url('/') }}",
  "applicationCategory": "EducationalApplication",
  "operatingSystem": "Any browser",
  "browserRequirements": "Requires a modern browser with HTML Canvas support",
  "image": "{{ site_url(url_for('static', filename='img/og-cover.png', v='og-1')) }}",
  "description": "A free, ad-free study canvas: handwritten notes, live ruler-and-compass geometry, algebra tiles and PDF annotation, in the browser on any device.",
  "featureList": [
    "Handwriting with pressure-aware pens",
    "Ruler-and-compass geometry that stays live",
    "Algebra tiles",
    "PDF and PowerPoint annotation and export",
    "Notebook library with offline backup",
    "YouTube lectures beside your notes",
    "Pomodoro timer"
  ],
  "isAccessibleForFree": true,
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "license": "https://opensource.org/licenses/MIT"
}
</script>
{% endblock %}
```

- [ ] **Step 5: Add breadcrumbs to the two inner pages**

In `templates/features.html`, after its `description` block:

```jinja
{% block structured_data %}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "{{ site_url('/') }}"},
    {"@type": "ListItem", "position": 2, "name": "Features", "item": "{{ site_url('/features') }}"}
  ]
}
</script>
{% endblock %}
```

In `templates/about.html`, after its `description` block — breadcrumbs plus the organisation, since this is the page that says who is behind it:

```jinja
{% block structured_data %}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "{{ site_url('/') }}"},
    {"@type": "ListItem", "position": 2, "name": "About", "item": "{{ site_url('/about') }}"}
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Inkyscib",
  "url": "{{ site_url('/') }}",
  "logo": "{{ site_url(url_for('static', filename='icons/inkyscib-512.png', v='pwa-1')) }}",
  "founder": [
    {
      "@type": "Person",
      "name": "Kshitiz Kumar Sinha",
      "jobTitle": "Mathematics educator and applied-ML researcher",
      "sameAs": [
        "https://www.linkedin.com/in/kshitiz47/",
        "https://github.com/kshitiz-arc"
      ]
    },
    {
      "@type": "Person",
      "name": "Salaj Shekhar",
      "sameAs": [
        "https://www.linkedin.com/in/salajs/",
        "https://github.com/SalajPro"
      ]
    }
  ]
}
</script>
{% endblock %}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (26 tests)

- [ ] **Step 7: Validate against the real validators**

Once deployed, paste each URL into `https://validator.schema.org/` and Google's Rich Results Test. The unit tests prove the JSON parses and says what we meant; only the validators prove Google accepts the vocabulary.

- [ ] **Step 8: Commit**

```bash
git add templates/ tests/test_seo.py
git commit -m "feat(seo): JSON-LD for the product, the organisation and breadcrumbs"
```

---

## Task 8: Link integrity

Checklist #11, #12. **Finding:** internal linking is already good — nav and footer on every marketing page, three deep links from the homepage into `/features#geometry`, `#material` and `#focus`, and a `.page-cta` on each inner page pointing at the other two. Adding more would be stuffing. So the deliverable here is the *test* that keeps it working, plus the one genuinely missing case: the 404 page, a real entry point from stale links, currently offers only "home".

**Files:**
- Modify: `templates/404.html`
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
HREF_RE = re.compile(r'href="([^"]+)"')
ID_RE = re.compile(r'id="([^"]+)"')


class LinkIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True)
            for path in INDEXABLE_PAGES + ("/no-such-page",)
        }

    def test_every_internal_link_resolves(self):
        for path, html in self.html.items():
            for href in HREF_RE.findall(html):
                if href.startswith(("http://", "https://", "mailto:", "#", "data:")):
                    continue
                target = href.split("#")[0]
                if not target or target.startswith("/static/"):
                    continue
                with self.subTest(page=path, href=href):
                    self.assertEqual(self.client.get(target).status_code, 200)

    def test_every_fragment_link_lands_on_an_element_that_exists(self):
        for path, html in self.html.items():
            for href in HREF_RE.findall(html):
                if "#" not in href or href.startswith(("http://", "https://")):
                    continue
                target, fragment = href.split("#", 1)
                if not fragment:
                    continue
                page = target or path
                with self.subTest(page=path, href=href):
                    body = self.client.get(page).get_data(as_text=True)
                    self.assertIn(fragment, ID_RE.findall(body))

    def test_every_static_asset_referenced_by_a_page_is_actually_there(self):
        for path, html in self.html.items():
            for href in HREF_RE.findall(html):
                if not href.startswith("/static/"):
                    continue
                with self.subTest(page=path, href=href):
                    self.assertEqual(self.client.get(href).status_code, 200)

    def test_every_outbound_link_that_opens_a_tab_is_opener_safe(self):
        for path, html in self.html.items():
            for match in re.finditer(r"<a\b[^>]*>", html):
                tag = match.group(0)
                if 'target="_blank"' not in tag:
                    continue
                with self.subTest(page=path, tag=tag):
                    self.assertIn("noopener", tag)

    def test_the_404_offers_a_way_back_into_the_site_not_just_the_homepage(self):
        html = self.html["/no-such-page"]
        for destination in ("/features", "/write"):
            with self.subTest(destination=destination):
                self.assertIn(f'href="{destination}"', html)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::LinkIntegrityTests -q`
Expected: FAIL only on `test_the_404_offers_a_way_back_into_the_site_not_just_the_homepage`. **If any other test in this class fails, a real broken link exists — fix the link, that is checklist item 12 doing its job.**

- [ ] **Step 3: Give the 404 somewhere to go**

In `templates/404.html`, after the existing `return-button` anchor:

```html
      <p class="lost-links">
        Or see <a href="{{ url_for('features') }}">what Inkyscib does</a>, or go
        straight to <a href="{{ url_for('write') }}">the canvas</a>.
      </p>
```

Add to `static/css/not-found.css`, matching the existing type scale in that file:

```css
.lost-links {
  margin: var(--s4) 0 0;
  color: var(--ink-2);
}

.lost-links a { color: inherit; text-underline-offset: 3px; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (31 tests)

- [ ] **Step 5: Commit**

```bash
git add templates/404.html static/css/not-found.css tests/test_seo.py
git commit -m "feat(seo): pin link integrity and give the 404 real exits"
```

---

## Task 9: Alt text and image weight

Checklist #9, #13. **Finding:** the site serves almost no raster images — the two portraits are behind `{% if portrait %}` and currently unset, and both already carry `alt`, `width` and `height`. The real gaps are the inline SVG illustrations, which have no accessible name and no `aria-hidden`, and the absence of any budget on what may be committed to `static/`.

**Files:**
- Modify: `templates/home.html` (the hero `.geometry` SVG)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: the OG cover from Task 6 (it is the largest committed image and must pass the budget).
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
IMG_RE = re.compile(r"<img\b[^>]*>", re.I)
SVG_OPEN_RE = re.compile(r"<svg\b[^>]*>", re.I)
IMAGE_BUDGET_BYTES = 300 * 1024


class ImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True)
            for path in ("/", "/features", "/about")
        }

    def test_every_img_has_alt_text_and_intrinsic_dimensions(self):
        for path, html in self.html.items():
            for tag in IMG_RE.findall(html):
                with self.subTest(page=path, tag=tag):
                    self.assertIn("alt=", tag)
                    self.assertIn("width=", tag)
                    self.assertIn("height=", tag)

    def test_every_illustration_is_either_named_or_explicitly_decorative(self):
        for path, html in self.html.items():
            for tag in SVG_OPEN_RE.findall(html):
                with self.subTest(page=path, tag=tag):
                    named = 'role="img"' in tag and "aria-label" in tag
                    decorative = 'aria-hidden="true"' in tag
                    self.assertTrue(named or decorative, tag)

    def test_no_committed_image_blows_the_page_weight_budget(self):
        static_dir = Path(app.root_path) / "static"
        for suffix in ("*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"):
            for image in static_dir.rglob(suffix):
                with self.subTest(image=image.name):
                    self.assertLess(image.stat().st_size, IMAGE_BUDGET_BYTES)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::ImageTests -q`
Expected: FAIL on `test_every_illustration_is_either_named_or_explicitly_decorative` — the homepage hero SVG has neither attribute.

- [ ] **Step 3: Name the hero illustration**

In `templates/home.html`, on the `.geometry` `<svg>` opening tag, add:

```html
        role="img"
        aria-label="A ruler-and-compass construction: two arcs crossing, with a line hung off the point where they meet"
```

If any other inline `<svg>` on these three pages is purely decorative (a chevron, a rule, the logo diamond), give it `aria-hidden="true"` instead — the test accepts either, and a decorative mark announced by a screen reader is worse than one that is silent.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (34 tests)

- [ ] **Step 5: Commit**

```bash
git add templates/home.html tests/test_seo.py
git commit -m "feat(a11y): name the hero illustration; budget committed images"
```

---

## Task 10: Core Web Vitals on the pages that rank

Checklist #14. Scope is `/`, `/features`, `/about` — see **Out of Scope** for why `/write` is a separate project. The one real blocker on these pages is the Google Fonts stylesheet: a render-blocking request to a third-party origin sitting in front of first paint on every page.

**Files:**
- Modify: `templates/_marketing.html` (the font links), `templates/write.html` (the same three lines)
- Modify: `static/css/marketing.css` (below-fold containment)
- Test: `tests/test_seo.py`, `tests/test_seo_browser.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. `tests/test_seo_browser.py` follows the browser-test conventions in **Global Constraints**.

- [ ] **Step 1: Write the failing structural test**

Append to `tests/test_seo.py`:

```python
class RenderBlockingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_the_third_party_font_stylesheet_does_not_block_first_paint(self):
        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                font_links = [
                    tag for tag in re.findall(r"<link\b[^>]*>", html)
                    if "fonts.googleapis.com/css2" in tag and "preload" not in tag
                ]
                self.assertTrue(font_links)
                for tag in font_links:
                    self.assertIn('media="print"', tag)
                    self.assertIn("this.media='all'", tag)
                self.assertIn("<noscript>", html)

    def test_the_font_stylesheet_is_preloaded_and_its_origins_preconnected(self):
        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('rel="preload" as="style"', html)
                self.assertIn('rel="preconnect" href="https://fonts.gstatic.com"', html)

    def test_analytics_never_blocks_the_parser(self):
        html = self.client.get("/").get_data(as_text=True)
        for tag in re.findall(r"<script\b[^>]*googletagmanager[^>]*>", html):
            with self.subTest(tag=tag):
                self.assertTrue("async" in tag or "defer" in tag)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::RenderBlockingTests -q`
Expected: FAIL — the stylesheet has no `media="print"` and there is no preload.

- [ ] **Step 3: Make the font stylesheet non-blocking**

In `templates/_marketing.html`, replace the three font lines with:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  {# The font CSS is fetched at high priority but applied off the critical
     path: media="print" makes it non-blocking, onload promotes it. The faces
     already carry display=swap, so text paints immediately in the fallback
     and swaps when Archivo lands. CSP allows the inline handler via
     script-src 'unsafe-inline' (app.py:1061). #}
  <link rel="preload" as="style"
    href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..900&family=JetBrains+Mono:wght@400..800&display=swap">
  <link rel="stylesheet" media="print" onload="this.media='all'"
    href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..900&family=JetBrains+Mono:wght@400..800&display=swap">
  <noscript>
    <link rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..900&family=JetBrains+Mono:wght@400..800&display=swap">
  </noscript>
```

Apply the identical replacement in `templates/write.html`.

- [ ] **Step 4: Keep the long features page from laying out what nobody has scrolled to**

Append to `static/css/marketing.css`:

```css
/* The features page is four long sections; only the first is ever above the
   fold. contain-intrinsic-size reserves the height so skipping layout costs
   nothing in CLS, and the containment is dropped for print. */
@media screen {
  .section {
    content-visibility: auto;
    contain-intrinsic-size: 0 640px;
  }
}
```

- [ ] **Step 5: Write the failing browser test**

Create `tests/test_seo_browser.py`:

```python
"""The two crawler-facing things a test client cannot see: layout shift and
mobile overflow. Conventions here are the house ones -- dismiss the tour, use
make_browser_server, pass wait_for_function an arrow function.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

MARKETING_PAGES = ("/", "/features", "/about")

COLLECT_VITALS = """
() => new Promise((resolve) => {
  let cls = 0;
  let lcp = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) { cls += entry.value; }
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    lcp = entries[entries.length - 1].startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  setTimeout(() => resolve({ cls, lcp }), 1500);
})
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class WebVitalsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()

    def _vitals(self, path):
        page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        try:
            page.goto(f"{self.base_url}{path}", wait_until="load")
            return page.evaluate(COLLECT_VITALS)
        finally:
            page.close()

    def test_no_marketing_page_shifts_its_layout_after_paint(self):
        for path in MARKETING_PAGES:
            with self.subTest(path=path):
                self.assertLess(self._vitals(path)["cls"], 0.1)

    def test_largest_contentful_paint_stays_inside_the_good_threshold(self):
        # Served from localhost, so this is a regression guard rather than a
        # field measurement: if it creeps past 2.5s here, something is very
        # wrong. Real numbers come from Search Console's Core Web Vitals
        # report once traffic exists.
        for path in MARKETING_PAGES:
            with self.subTest(path=path):
                self.assertLess(self._vitals(path)["lcp"], 2500)
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `python -m pytest tests/test_seo.py tests/test_seo_browser.py -q`
Expected: PASS. If CLS exceeds 0.1 on `/features`, `contain-intrinsic-size` is too far from the real section height — measure a section with `document.querySelector('.section').offsetHeight` and set the value to the median.

- [ ] **Step 7: Confirm the fonts still arrive**

Open `/` and `/features` in a browser with the network throttled to Slow 3G. Text must paint immediately in the fallback face and swap to Archivo; it must never be invisible. Then disable JavaScript and reload: the `<noscript>` copy must still load the font.

- [ ] **Step 8: Commit**

```bash
git add templates/ static/css/marketing.css tests/test_seo.py tests/test_seo_browser.py
git commit -m "perf(seo): non-blocking font CSS, below-fold containment, CWV guards"
```

---
## Task 11: Mobile responsiveness, measured

Checklist #15. The product's stated target is a ~960px budget Android tablet, and phones are where a "free study app" search lands. Two failure modes are worth pinning: horizontal overflow (which Google's mobile-usability report flags directly) and touch targets under `var(--tap)`, which `DESIGN.md:153` already declares as the floor.

**Files:**
- Modify: `static/css/marketing.css` (the `@media (max-width: 44rem)` block at `:594`)
- Test: `tests/test_seo_browser.py`

**Interfaces:**
- Consumes: the browser fixture created in Task 10 (`make_browser_server`, the tour-dismissing init script).
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo_browser.py`:

```python
VIEWPORTS = (
    ("phone", 360, 740),
    ("tablet-768", 768, 1024),
    ("tablet-960", 960, 600),   # the device this product is written for
)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class MobileLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()

    def _page(self, width, height, path):
        page = self.browser.new_page(viewport={"width": width, "height": height})
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        page.goto(f"{self.base_url}{path}", wait_until="load")
        return page

    def test_nothing_scrolls_sideways_at_any_target_width(self):
        for name, width, height in VIEWPORTS:
            for path in MARKETING_PAGES:
                with self.subTest(viewport=name, path=path):
                    page = self._page(width, height, path)
                    try:
                        overflow = page.evaluate(
                            "() => document.documentElement.scrollWidth"
                            " - document.documentElement.clientWidth"
                        )
                    finally:
                        page.close()
                    self.assertLessEqual(overflow, 1, f"{name} {path}: {overflow}px")

    def test_header_controls_meet_the_44px_touch_floor_on_a_phone(self):
        page = self._page(360, 740, "/")
        try:
            heights = page.eval_on_selector_all(
                "header .nav a, header .write-btn, header .icon-btn",
                "nodes => nodes.map(node => node.getBoundingClientRect().height)",
            )
        finally:
            page.close()

        self.assertTrue(heights)
        for height in heights:
            with self.subTest(height=height):
                self.assertGreaterEqual(round(height), 44)

    def test_the_viewport_is_declared_without_locking_zoom(self):
        page = self._page(360, 740, "/")
        try:
            content = page.get_attribute('meta[name="viewport"]', "content")
        finally:
            page.close()

        self.assertIn("width=device-width", content)
        self.assertNotIn("user-scalable=no", content)
        self.assertNotIn("maximum-scale=1", content)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo_browser.py::MobileLayoutTests -q`
Expected: FAIL on the touch-floor test — `.nav a` is `padding: var(--s2)` around a single line of text, roughly 33px. If the overflow test also fails, note which page and width; that is real work and it belongs in this task.

- [ ] **Step 3: Raise the header controls to the floor**

In `static/css/marketing.css`, inside the existing `@media (max-width: 44rem)` block at `:594`, replace the `.nav a` rule:

```css
  /* DESIGN.md: 44px is the touch floor, via var(--tap). These are the three
     controls a phone visitor actually aims at. */
  .nav a {
    padding: var(--s2);
    min-block-size: var(--tap);
    display: inline-flex;
    align-items: center;
  }

  header .write-btn,
  header .icon-btn {
    min-block-size: var(--tap);
    min-inline-size: var(--tap);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo_browser.py -q`
Expected: PASS

- [ ] **Step 5: Look at it**

Open `/`, `/features` and `/about` at 360px and at 960px. Nothing may be clipped, the nav must still read as one row of three, and the header must not grow taller than two rows. Check against `DESIGN.md` before accepting any spacing change.

- [ ] **Step 6: Commit**

```bash
git add static/css/marketing.css tests/test_seo_browser.py
git commit -m "fix(mobile): 44px header touch targets; pin no sideways scroll"
```

---

## Task 12: HTTPS everywhere, and exactly one canonical host

Checklist #16, #17. HSTS is already sent — but only when `request.is_secure`, which behind a reverse proxy is **always false**, because the proxy terminates TLS and the scheme survives only in `X-Forwarded-Proto`. So today the header almost certainly never ships in production, and nothing redirects `http://` to `https://`.

The slugs themselves (`/`, `/features`, `/about`, `/write`) are already clean, lowercase and hyphen-free, so item 17's remaining risk is not the path — it is the *host*: the same pages served on `www.` and the apex, or on the platform's default domain (`*.onrender.com`, `*.fly.dev`) as well as the custom one. That is duplicate content, and canonical tags alone only hint at the fix. One redirect settles it.

**Files:**
- Modify: `app.py` (imports, config block after `SITE_ORIGIN`, a new `before_request`)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `SITE_ORIGIN` (Task 1).
- Produces: `app.FORCE_HTTPS: bool`, `app.CANONICAL_HOST: str` (`""` when `SITE_ORIGIN` is unset), and a `before_request` hook named `redirect_to_canonical_origin`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
class CanonicalOriginRedirectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_http_is_redirected_to_https_permanently_when_enforced(self):
        with mock.patch.object(app_module, "FORCE_HTTPS", True):
            response = self.client.get("/features", base_url="http://inkyscib.com")

        self.assertEqual(response.status_code, 301)
        self.assertEqual(
            response.headers["Location"], "https://inkyscib.com/features"
        )

    def test_a_post_keeps_its_body_across_the_upgrade(self):
        with mock.patch.object(app_module, "FORCE_HTTPS", True):
            response = self.client.post("/api/pdf/export", base_url="http://inkyscib.com")

        self.assertEqual(response.status_code, 308)

    def test_a_non_canonical_host_is_redirected_to_the_canonical_one(self):
        with mock.patch.object(app_module, "CANONICAL_HOST", "inkyscib.com"):
            response = self.client.get("/about", base_url="https://www.inkyscib.com")

        self.assertEqual(response.status_code, 301)
        self.assertEqual(response.headers["Location"], "https://inkyscib.com/about")

    def test_local_development_is_never_redirected(self):
        response = self.client.get("/", base_url="http://127.0.0.1:8977")

        self.assertEqual(response.status_code, 200)

    def test_hsts_ships_on_a_secure_request(self):
        response = self.client.get("/", base_url="https://inkyscib.com")

        self.assertIn("max-age=31536000", response.headers["Strict-Transport-Security"])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::CanonicalOriginRedirectTests -q`
Expected: FAIL — `AttributeError: module 'app' has no attribute 'FORCE_HTTPS'`.

- [ ] **Step 3: Trust the proxy, and add the two switches**

Extend the imports at `app.py:25`:

```python
from flask import (
    Flask, Response, jsonify, redirect, render_template, request, send_file, url_for
)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename
```

Directly below the `site_url` definition from Task 1:

```python
# Behind a reverse proxy (Render, Fly, nginx) the socket this process sees is
# plain HTTP; the real scheme and host survive only in X-Forwarded-*. Without
# ProxyFix, request.is_secure is always False, so the HSTS header set in
# set_security_headers never actually ships. Only enable it where a proxy is
# genuinely in front, or a client can forge the scheme.
if os.environ.get("TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes"}:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

FORCE_HTTPS = os.environ.get("FORCE_HTTPS", "").strip().lower() in {"1", "true", "yes"}

# Everything served on a second hostname -- www. as well as the apex, or the
# hosting platform's default *.onrender.com alongside the custom domain -- is
# duplicate content. The canonical tag hints; this redirect settles it.
CANONICAL_HOST = urllib.parse.urlsplit(SITE_ORIGIN).netloc if SITE_ORIGIN else ""
```

- [ ] **Step 4: Add the redirect**

Immediately before the first `@app.after_request` in `app.py`:

```python
@app.before_request
def redirect_to_canonical_origin():
    """One origin, over TLS. Off by default, so a local run is untouched."""
    host = request.host.split(":")[0]
    if host in ("127.0.0.1", "localhost", "[::1]"):
        return None

    wrong_scheme = FORCE_HTTPS and not request.is_secure
    wrong_host = bool(CANONICAL_HOST) and request.host != CANONICAL_HOST

    if not (wrong_scheme or wrong_host):
        return None

    scheme = "https" if (FORCE_HTTPS or request.is_secure) else request.scheme
    netloc = CANONICAL_HOST or request.host
    target = urllib.parse.urlunsplit(
        (scheme, netloc, request.path, request.query_string.decode(), "")
    )
    # 301 is what search engines consolidate on; 308 keeps the method and body
    # for anything that is not a plain read.
    code = 301 if request.method in ("GET", "HEAD") else 308
    return redirect(target, code=code)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (42 tests)

- [ ] **Step 6: Run the full suite**

Run: `python -m pytest tests/ -q`
Expected: green. Every existing test uses `localhost`/`127.0.0.1` or the test client's default `http://localhost`, so the guard clause keeps them untouched. A failure here means a test uses some other host — fix the test's `base_url`, not the redirect.

- [ ] **Step 7: Write down the production environment**

The app now reads four environment variables. They belong in the deploy config, not in code:

```bash
SITE_ORIGIN=https://inkyscib.com
TRUST_PROXY_HEADERS=true
FORCE_HTTPS=true
SECRET_KEY=...            # already required
```

- [ ] **Step 8: Commit**

```bash
git add app.py tests/test_seo.py
git commit -m "feat(seo): force HTTPS and one canonical host behind a proxy"
```

---

## Task 13: llms.txt

Checklist #18. A single Markdown file at `/llms.txt` telling an LLM crawler what this site is and which pages matter, per llmstxt.org. Rendered from a template so its links carry the configured origin.

**Files:**
- Create: `templates/llms.txt`
- Modify: `app.py` (route, below `sitemap_xml`)
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: `site_url` (Task 1).
- Produces: `GET /llms.txt` → `text/markdown; charset=utf-8`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
class LlmsTxtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_llms_txt_is_markdown_with_a_title_and_a_summary(self):
        response = self.client.get("/llms.txt", base_url="https://inkyscib.test")
        body = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.mimetype.startswith("text/markdown"))
        self.assertTrue(body.startswith("# Inkyscib"))
        self.assertIn("\n> ", body)

    def test_llms_txt_links_to_every_indexable_page_absolutely(self):
        body = self.client.get(
            "/llms.txt", base_url="https://inkyscib.test"
        ).get_data(as_text=True)

        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                self.assertIn(f"https://inkyscib.test{path}", body)

    def test_llms_txt_is_not_html(self):
        body = self.client.get("/llms.txt").get_data(as_text=True)
        self.assertNotIn("<html", body.lower())
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::LlmsTxtTests -q`
Expected: FAIL — 404.

- [ ] **Step 3: Write the document**

Create `templates/llms.txt`:

```jinja
# Inkyscib

> A free, ad-free study and teaching workspace that runs in the browser. Import a
> PDF or a slide deck, write on it by hand, construct real ruler-and-compass
> geometry, and export clean vector PDF. No account, no subscription, and every
> drawing stays in the visitor's own browser storage.

Inkyscib is built for students and teachers on inexpensive hardware — the target
device is a budget Android tablet, not an iPad. It is a Flask app with a vanilla
JavaScript canvas: no framework, no build step, and no server-side copy of
anyone's notes.

## Pages

- [Home]({{ site_url('/') }}): what it is, and the live geometry demo.
- [Features]({{ site_url('/features') }}): handwriting and pen feels, ruler-and-compass geometry, algebra tiles, PDF and PowerPoint annotation, notebooks, YouTube lectures, Pomodoro, offline backup.
- [About]({{ site_url('/about') }}): who builds it, why it is free, and how the local-first storage works.
- [The canvas]({{ site_url('/write') }}): the application itself.

## Facts worth quoting correctly

- Price: free, with no paid tier, no advertising and no account.
- Storage: local-first. Drawings and preferences live in the browser
  (localStorage and IndexedDB); the server sees a file only during a PDF or
  PowerPoint import or export.
- Licence: MIT.
- Import and export: PDF in and out, PowerPoint (.ppt/.pptx) in and out.
- Works offline once loaded, on any modern browser.

## Not covered here

- `/api/*` is a private HTTP interface for the editor, not a public API.
- `/lab/ink` is an unfinished WebGPU prototype and is not part of the product.
```

- [ ] **Step 4: Add the route**

In `app.py`, below `sitemap_xml`:

```python
@app.route("/llms.txt")
def llms_txt():
    """llmstxt.org: a short Markdown brief for LLM crawlers, so a model that
    summarises Inkyscib gets the price, the storage model and the licence
    right rather than inferring them from marketing copy."""
    body = render_template("llms.txt")
    return Response(body, mimetype="text/markdown")
```

Flask sends `text/markdown; charset=utf-8` for that mimetype by default.

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (45 tests). The sitemap coverage guard from Task 3 already lists `/llms.txt` as deliberately excluded, so it stays green.

- [ ] **Step 6: Commit**

```bash
git add app.py templates/llms.txt tests/test_seo.py
git commit -m "feat(seo): serve llms.txt for LLM crawlers"
```

---

## Task 14: A backlink strategy that is a document, not a code change

Checklist #19. **This one cannot be implemented.** Backlinks are earned from other people's sites; no commit creates one. What *can* be shipped is a specific, dated, honest target list with the pitch for each — so the work is doable in an afternoon instead of being a standing intention.

Nothing here involves buying links, link exchanges, or posting to directories that exist only to sell links. Those are the tactics Google's link-spam policy names, and this project — a free MIT-licensed tool with a real story behind it — has better options.

**Files:**
- Create: `docs/seo/backlink-strategy.md`

**Interfaces:** none.

- [ ] **Step 1: Write the document**

Create `docs/seo/backlink-strategy.md`:

```markdown
# Inkyscib backlink strategy

Written 2026-09-20. Review quarterly.

A backlink is earned, not deployed. Everything below is a real place where a
free, ad-free, local-first study tool built by a mathematics teacher is
genuinely on-topic. Nothing here is a paid link, a link exchange, or a
directory that exists to sell links — both because it would not work and
because it is what Google's link-spam policy is written to catch.

## The asset

The story is the asset, not the app: *"I own a Lenovo tablet, not an iPad. The
free apps were buried in ads and the good ones cost more than the tablet, so I
built the thing I wished existed."* That sentence is what a journalist, a
teacher forum or a Hacker News thread can repeat. Lead with it.

## Tier 1 — where the audience already is (do first)

| Target | Why it fits | The pitch |
|---|---|---|
| r/teachers, r/matheducation, r/Professors | Teachers on school budgets, actively swapping tools | Show a slide being annotated live; no launch language |
| r/GoodNotes, r/onenote, r/Notebooks, r/tablets | People searching for a free alternative right now | Answer "is there a free version of X" threads honestly, including what Inkyscib does *not* do |
| Hacker News (Show HN) | Local-first, no-build-step, vanilla-canvas engineering is on-topic twice over | Title: what it is + that it is MIT and local-first. Be in the thread all day |
| Lobste.rs | Same, with a stricter audience | Only with the engineering angle (canvas render cost, PDF vector export) |
| Indian ed-tech / teacher WhatsApp and Telegram groups | The actual first users, in the actual region | A one-line message and a link, from a real teacher |

## Tier 2 — durable, slow-earning links

- **GitHub.** The repository is the highest-authority link this project will
  get for free. Make the README's first screen match the site, and add topics:
  `handwriting`, `pdf-annotation`, `education`, `local-first`, `canvas`.
- **Awesome lists.** `awesome-selfhosted`, `awesome-education`,
  `awesome-local-first-software`. One PR each, following that list's rules.
  Never bulk-submit.
- **AlternativeTo, Slant, SaaSHub.** Real comparison traffic for "free
  GoodNotes alternative". Claim the listing rather than posting a bare link.
- **Wikipedia's comparison-of-notetaking-software article.** Only if the
  project meets notability by then; an unsourced addition is reverted and
  costs credibility.
- **A single conference or journal mention.** The About page names a
  mathematics educator and applied-ML researcher — a short workshop paper or a
  teaching-practice writeup about using the tool in a real classroom is worth
  more than fifty directory links, and it is the one link nobody can copy.

## Tier 3 — content that attracts links on its own

Each of these is a page worth writing *because a student searches for it*, and
each gives another site a reason to cite:

1. "How to annotate a PDF textbook for free on an Android tablet"
2. "Ruler-and-compass constructions you can actually drag" (the differentiator)
3. "Export handwritten notes as real vector PDF, and why that matters"

Publish them under `/guides/<slug>`; add each to `SITEMAP_ROUTES` in `app.py`
as it ships — the coverage test in `tests/test_seo.py` will fail until it is
listed, which is the point.

## What to measure

Search Console → Links → *Top linking sites*, monthly. The number to watch is
distinct referring domains, not total links. Twenty real domains beats two
thousand from one footer.
```

- [ ] **Step 2: Commit**

```bash
git add docs/seo/backlink-strategy.md
git commit -m "docs(seo): backlink strategy with named targets and pitches"
```

---

## Task 15: Verify ownership and submit the sitemap

The checklist in the source image says "20 things" and lists nineteen; this is the twentieth it should have had. Everything built above is invisible to Google until a crawler is told the site exists.

**Files:**
- Modify: `app.py` (one config value), `templates/_marketing.html` (one conditional meta)
- Create: `docs/seo/search-console.md`
- Test: `tests/test_seo.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `app.SEARCH_CONSOLE_TOKEN: str`; a `google-site-verification` meta rendered only when it is set.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_seo.py`:

```python
class VerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_no_verification_meta_is_rendered_when_no_token_is_configured(self):
        html = self.client.get("/").get_data(as_text=True)
        self.assertNotIn("google-site-verification", html)

    def test_the_token_is_rendered_on_every_marketing_page_when_set(self):
        with mock.patch.object(app_module, "SEARCH_CONSOLE_TOKEN", "abc123"):
            for path in ("/", "/features", "/about"):
                with self.subTest(path=path):
                    html = self.client.get(path).get_data(as_text=True)
                    self.assertIn(
                        '<meta name="google-site-verification" content="abc123"',
                        html,
                    )
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_seo.py::VerificationTests -q`
Expected: FAIL — `AttributeError: SEARCH_CONSOLE_TOKEN`.

- [ ] **Step 3: Add the token**

In `app.py`, below `CANONICAL_HOST`:

```python
# Search Console's HTML-tag verification. Empty in development, so no stray
# meta ships locally; set SEARCH_CONSOLE_TOKEN in the deploy environment.
SEARCH_CONSOLE_TOKEN = os.environ.get("SEARCH_CONSOLE_TOKEN", "").strip()
```

Add it to the context processor written in Task 1:

```python
@app.context_processor
def inject_canonical():
    return {
        "canonical_url": site_url(request.path),
        "site_url": site_url,
        "search_console_token": SEARCH_CONSOLE_TOKEN,
    }
```

In `templates/_marketing.html`, after the canonical link:

```html
  {% if search_console_token %}
  <meta name="google-site-verification" content="{{ search_console_token }}" />
  {% endif %}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python -m pytest tests/test_seo.py -q`
Expected: PASS (47 tests)

- [ ] **Step 5: Write the runbook**

Create `docs/seo/search-console.md`:

```markdown
# Getting indexed

Do this once, after the first deploy that includes the SEO work.

## 1. Verify the property

1. Open <https://search.google.com/search-console> and add a **Domain**
   property (it covers www, apex and every subdomain in one) if DNS is
   reachable; otherwise add a **URL prefix** property for the exact
   `SITE_ORIGIN`.
2. For a URL-prefix property, choose **HTML tag** verification, copy the
   `content` value, and set it in the deploy environment:
   `SEARCH_CONSOLE_TOKEN=<value>`. Redeploy, then press Verify.
3. Repeat at <https://www.bing.com/webmasters> — Bing imports directly from
   Search Console, so it is about two clicks.

## 2. Submit the sitemap

In Search Console → **Sitemaps**, submit `sitemap.xml`. Check back in 48
hours: **Pages → Indexed** should show four URLs.

## 3. Request indexing for the homepage

Search Console → **URL inspection** → paste `SITE_ORIGIN` → *Request
indexing*. Once. Repeatedly requesting does nothing.

## 4. Check the environment

The app reads five variables in production. If `SITE_ORIGIN` is missing,
canonical tags fall back to whatever host the request arrived on — which is
exactly the duplicate-content problem the canonical was meant to solve.

| Variable | Value | Why |
|---|---|---|
| `SECRET_KEY` | *(secret)* | Already required |
| `SITE_ORIGIN` | `https://<the real domain>` | Canonicals, sitemap, OG, llms.txt |
| `TRUST_PROXY_HEADERS` | `true` behind a proxy | Otherwise HSTS never ships |
| `FORCE_HTTPS` | `true` | http → https, 301 |
| `SEARCH_CONSOLE_TOKEN` | *(from Search Console)* | Verification only |

## 5. Three weeks later

- **Pages** report: anything under "Crawled – currently not indexed"?
- **Core Web Vitals**: real-device numbers, which is the only place the
  LCP/CLS guards in `tests/test_seo_browser.py` get validated against reality.
- **Links → Top linking sites**: the number to grow is distinct referring
  domains. See `docs/seo/backlink-strategy.md`.
```

- [ ] **Step 6: Commit**

```bash
git add app.py templates/_marketing.html docs/seo/search-console.md tests/test_seo.py
git commit -m "feat(seo): optional Search Console verification + indexing runbook"
```

---

## Task 16: Land it

The whole suite, in one run, plus the two files this project uses to remember things.

**Files:**
- Modify: `README.md` (a short "Running it in production" note), `TODOS.md` (what was deliberately left)

- [ ] **Step 1: Run everything**

Run: `python -m pytest tests/ -q`
Expected: **371 passed, 0 failed** (319 baseline + 52 new: 47 in `tests/test_seo.py`, 5 in `tests/test_seo_browser.py`), about 11 minutes. Any failure is yours until proven otherwise.

- [ ] **Step 2: Check the pages by hand, once, with a real origin**

```bash
SITE_ORIGIN=https://inkyscib.com SECRET_KEY=dev python -c "from app import app; app.run(port=8977)"
```

Visit `/robots.txt`, `/sitemap.xml`, `/llms.txt`, then view-source on `/` and confirm: one canonical, one title, one description, og tags, one JSON-LD block, non-blocking font links. Remember Flask caches templates — restart after any edit.

- [ ] **Step 3: Record what was left undone**

Append to `TODOS.md`:

```markdown
## SEO: what this plan deliberately did not do (2026-09-20)

- **`/write` load cost.** 52 script tags, ~3.5 MB of JS. Core Web Vitals work
  in `docs/superpowers/plans/2026-09-20-seo-discoverability.md` covers the
  three marketing pages only. The editor needs its own plan.
- **Self-hosted fonts.** The Google Fonts stylesheet is now non-blocking, but
  it is still a third-party origin in `CONTENT_SECURITY_POLICY`. Self-hosting
  two woff2 families removes it at the cost of ~200 KB in the repo.
- **`templates/home-classic.html` is dead** — no route renders it. Delete it.
- **HSTS `preload`.** The header ships `max-age` and `includeSubDomains` but
  not `preload`; submitting to hstspreload.org is a commitment that is hard to
  undo, so it is a decision, not a task.
- **Guide pages** (`/guides/<slug>`) are Tier 3 of
  `docs/seo/backlink-strategy.md`. Each new page must be added to
  `SITEMAP_ROUTES` or the coverage test in `tests/test_seo.py` fails — which
  is the intended behaviour.
```

- [ ] **Step 4: Document the production environment in the README**

In `README.md`, under "Run it locally", after the Gunicorn block:

```markdown
**In production**, five environment variables matter — see
`docs/seo/search-console.md` for what each one does:

```bash
SECRET_KEY=...                       # required
SITE_ORIGIN=https://your-domain      # canonical URLs, sitemap, social cards
TRUST_PROXY_HEADERS=true             # behind nginx/Render/Fly; enables HSTS
FORCE_HTTPS=true                     # 301 http -> https
SEARCH_CONSOLE_TOKEN=...             # optional, verification only
```
```

- [ ] **Step 5: Commit**

```bash
git add README.md TODOS.md
git commit -m "docs: production environment and deferred SEO work"
```

---

# Appendix A: the checklist, mapped

The source is a 19-item list captioned "20 things"; item 20 was missing from it, so Task 15 supplies the one that makes the rest visible.

| # | Item | Where it lands | Notes |
|---|---|---|---|
| 1 | a sitemap.xml | Task 3 | Plus a guard so a new page cannot be forgotten |
| 2 | add robots.txt | Task 2 | Disallows `/api/` and `/lab/`, advertises the sitemap |
| 3 | remove noindex tags | Task 4 | **Already clean.** The test pins it, and adds the two `noindex` tags that *should* exist (`/lab/ink`, 404) |
| 4 | add canonical tags | Task 1 | One configurable origin; Task 12 backs it with a redirect |
| 5 | add meta titles | Task 4 | Four unique titles, 20–65 characters |
| 6 | add meta descriptions | Task 4 | Four unique, 80–160 characters; `/write` had none |
| 7 | use one H1 per page | Task 5 | `/features`, `/about` and `/write` had none |
| 8 | fix header hierarchy | Task 5 | Whole ladder shifts up one rank; CSS selectors move with it |
| 9 | add alt text | Task 9 | Both `<img>` tags already comply; the inline SVGs did not |
| 10 | add schema markup | Task 7 | `SoftwareApplication`, `Organization`, `BreadcrumbList`. No fake ratings |
| 11 | add internal links | Task 8 | **Mostly already done**; the 404 was the real gap |
| 12 | fix broken links | Task 8 | An automated crawler test, so this stays fixed |
| 13 | compress images | Tasks 6, 9 | The site serves almost no rasters; the new OG card is the one that needed a budget |
| 14 | improve Core Web Vitals | Task 10 | Marketing pages only — `/write` is explicitly deferred |
| 15 | fix mobile responsiveness | Task 11 | Overflow at 360/768/960 + the 44px touch floor from `DESIGN.md` |
| 16 | enforce HTTPS | Task 12 | Includes `ProxyFix`, without which the existing HSTS header never ships |
| 17 | clean up URL slugs | Task 12 | **Slugs are already clean**; the real duplicate risk was the host |
| 18 | add llms.txt | Task 13 | |
| 19 | build a backlink strategy | Task 14 | **Not code.** A named target list with pitches |
| 20 | *(missing from the source list)* verify in Search Console and submit the sitemap | Task 15 | Without it, none of the above is seen |

## Honest expectations

Every item above is a prerequisite, not a cause. They make Inkyscib *eligible*
to rank and correct when it is shown; they do not create demand. For a new
domain, expect indexing within days of Task 15, and no meaningful search
traffic for months. The two things on this list that will actually move
traffic are the one that is not code (Task 14) and the one that is not on the
list at all — Tier 3 of the backlink document, which is writing pages that
answer what a student actually types into Google.

---

# Part II — Legal, Privacy and Compliance

> **This is engineering, not legal advice.** Nothing below is written by a lawyer. The
> documents in Task 21 are drafts specific to how Inkyscib actually works, complete
> enough to be reviewed rather than started from scratch — **have a qualified lawyer in
> the operating jurisdiction read them before they go live.** The code tasks are
> different in kind: consent gating, erasure, PII-free logs and accessibility are
> engineering obligations, and those are implemented here for real.

## What actually applies, and what does not

Inkyscib is unusual, and that changes the compliance picture more than any checklist can.
**There are no accounts, no login, no server-side user records, and no payments.** Notes,
drawings and preferences live in the visitor's own browser (localStorage + IndexedDB). The
server sees a file only for the seconds it takes to convert a PDF or a deck, inside a
`tempfile.TemporaryDirectory` that deletes itself (`app.py:2051`, `:2110`, `:2509`).

So the personal-data surface is almost entirely **three third parties on the page**:

| Flow | What leaves the visitor's device | Legal weight |
|---|---|---|
| **Google Analytics 4** (`_marketing.html:40-47`, and `/write`) | Client ID cookie, page URLs, IP → Google, US | The whole problem. Loads **before any consent**, on every page. Breaches ePrivacy Art. 5(3) and the UK/EU GDPR consent basis as it stands today |
| **Google Fonts** (`fonts.googleapis.com`, every page) | IP address → Google, on every page load | *LG München I, 3 O 17493/20* — embedding Google Fonts transmits the IP without consent. Self-hosting removes the flow entirely |
| **YouTube embeds** (`frame-src https://www.youtube.com`) | Cookies + IP → Google, once a lecture is opened | `youtube-nocookie.com` is already allowed in the CSP and is not being used |

Everything else on the 30-item list is either **already satisfied by the architecture**
(data minimisation, retention limits, no profiling, no ad-tech) or **not applicable**
(PCI-DSS: no payments; SOC 2 / ISO 27001: audited certifications, not code). Both cases
are stated explicitly in **Appendix B** rather than being quietly skipped — and the
guardrails that keep "not applicable" true are tests, not promises.

**One addition the source list missed:** the operator is in Ranchi, India, so **India's
Digital Personal Data Protection Act, 2023** applies to this processing. It matters more
than most of the listed regimes here, because under §9 anyone **under 18** is a child, and
tracking or behavioural monitoring of children is prohibited outright — for a product
aimed at students, that is the strictest rule on the whole list. Task 21 covers it.

## The decision that removes most of this work

**Recommendation: drop GA4 for a cookieless, self-hosted page counter** (Plausible CE,
Umami, or ~40 lines of Flask writing an aggregate row with no identifier). It ends the
consent requirement for analytics, the US transfer question, the COPPA/DPDP child-tracking
question, and the cookie-banner tax on every visitor, all at once — for a solo free
project whose analytics need is "how many people opened the canvas this week".

This plan **does not assume that decision**, because it is the user's to make. Tasks 17–20
build a full consent gate that works with GA4 in place. If the user drops GA4, Task 17
gets simpler (no gate needed for essential-only), Task 18's banner disappears entirely, and
Tasks 19–20 reduce to a footer link. Ask before starting Task 17.

---

## Task 17: Nothing non-essential loads before consent

Covers: ePrivacy Art. 5(3) prior consent, GDPR/UK GDPR lawful basis, DPDP §6 notice,
LGPD, PIPEDA express consent. This is the keystone — every later task assumes it.

**Files:**
- Create: `static/js/consent.js`
- Modify: `templates/_marketing.html` (replace the GA4 snippet), `templates/write.html` (same)
- Modify: `static/js/youtube.js` *(or wherever the embed URL is built — grep `youtube.com/embed`)*
- Modify: `tests/test_analytics_csp.py` — **an existing green test that this task must change**
- Test: `tests/test_consent.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the single global `window.InkyscibConsent`, with
  `get(): {analytics: boolean, version: number, at: string} | null`,
  `set(categories: {analytics: boolean}): void`,
  `has(category: string): boolean`,
  `onChange(handler: (state) => void): void`,
  and the constant `window.InkyscibConsent.VERSION = 1`.
  Tasks 18, 19, 20 and 22 all call into this object. **Do not export the individual
  functions as top-level declarations** — in a classic script a top-level `function foo` is
  `window.foo`, which has already broken preference saving in this codebase once
  (`TODOS.md`, 2026-09-15). One IIFE, one global.

- [ ] **Step 1: Write the failing test**

Create `tests/test_consent.py`:

```python
"""No non-essential third party may load before the visitor has said yes.

The test-client half proves the served HTML ships no tracker. The browser half
proves the gate actually opens and closes at runtime.
"""

import re
import threading
import unittest
from pathlib import Path

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

PAGES = ("/", "/features", "/about", "/write")
MEASUREMENT_ID = "G-5SW3NRK6X6"
CONSENT_JS = Path(app.root_path) / "static" / "js" / "consent.js"


class ServedHtmlCarriesNoTrackerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_no_page_ships_a_gtag_script_tag(self):
        for path in PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn("googletagmanager.com/gtag/js", html)

    def test_the_measurement_id_lives_only_in_the_consent_module(self):
        for path in PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn(MEASUREMENT_ID, html)

        self.assertIn(MEASUREMENT_ID, CONSENT_JS.read_text(encoding="utf-8"))

    def test_consent_mode_defaults_to_denied_before_anything_loads(self):
        source = CONSENT_JS.read_text(encoding="utf-8")
        self.assertIn("'consent', 'default'", source)
        self.assertIn("analytics_storage", source)
        self.assertIn("denied", source)

    def test_youtube_is_embedded_through_the_no_cookie_host(self):
        editor_js = (Path(app.root_path) / "static" / "js").rglob("*.js")
        embeds = [
            path for path in editor_js
            if "youtube.com/embed" in path.read_text(encoding="utf-8", errors="ignore")
        ]
        self.assertEqual(embeds, [], f"still embedding the cookie host: {embeds}")


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class ConsentGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()

    def _page(self):
        page = self.browser.new_page()
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        return page

    def test_a_first_visit_makes_no_request_to_any_google_origin(self):
        page = self._page()
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        try:
            page.goto(f"{self.base_url}/", wait_until="networkidle")
        finally:
            page.close()

        offenders = [
            url for url in requests
            if "google" in url and "fonts.googleapis" not in url
        ]
        self.assertEqual(offenders, [], offenders)

    def test_accepting_analytics_loads_the_tag_and_records_the_choice(self):
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.evaluate("() => window.InkyscibConsent.set({ analytics: true })")
            page.wait_for_function(
                "() => Array.from(document.scripts)"
                ".some(script => script.src.includes('googletagmanager.com/gtag/js'))"
            )
            state = page.evaluate("() => window.InkyscibConsent.get()")
        finally:
            page.close()

        self.assertTrue(state["analytics"])
        self.assertEqual(state["version"], 1)
        self.assertTrue(state["at"])

    def test_a_declined_choice_survives_a_reload_and_still_loads_nothing(self):
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.evaluate("() => window.InkyscibConsent.set({ analytics: false })")
            requests = []
            page.on("request", lambda request: requests.append(request.url))
            page.reload(wait_until="networkidle")
            state = page.evaluate("() => window.InkyscibConsent.get()")
        finally:
            page.close()

        self.assertFalse(state["analytics"])
        self.assertEqual(
            [url for url in requests if "googletagmanager" in url], []
        )

    def test_withdrawing_consent_is_as_easy_as_giving_it(self):
        """GDPR Art. 7(3): withdrawal must be as easy as granting."""
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.evaluate("() => window.InkyscibConsent.set({ analytics: true })")
            page.evaluate("() => window.InkyscibConsent.set({ analytics: false })")
            state = page.evaluate("() => window.InkyscibConsent.get()")
            cookies = page.context.cookies()
        finally:
            page.close()

        self.assertFalse(state["analytics"])
        self.assertEqual([c for c in cookies if c["name"].startswith("_ga")], [])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_consent.py -q`
Expected: FAIL on every test — the gtag snippet is inline in both templates, `consent.js` does not exist, and the first visit fires requests to `googletagmanager.com`.

- [ ] **Step 3: Write the consent module**

Create `static/js/consent.js`:

```javascript
/* Consent gate.
 *
 * Nothing non-essential runs until the visitor has said yes. That is the
 * ePrivacy prior-consent rule, and it is also the only honest reading of
 * "free, ad-free, nothing pulling your attention away".
 *
 * One IIFE, one global: in a classic script a top-level `function name` is
 * `window.name`, and exporting a wrapper under a name that already existed
 * broke every preference save in this app once (TODOS.md, 2026-09-15).
 */
(function () {
  "use strict";

  var STORAGE_KEY = "inkyscib-consent-v1";
  var VERSION = 1;
  var MEASUREMENT_ID = "G-5SW3NRK6X6";
  var handlers = [];
  var analyticsLoaded = false;

  function read() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var state = JSON.parse(raw);
      // A new version of the notice invalidates the old choice.
      return state && state.version === VERSION ? state : null;
    } catch (error) {
      return null;   // private mode, blocked storage: treat as no consent
    }
  }

  function write(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      /* A visitor who blocks storage still gets the denied default. */
    }
  }

  // Consent Mode v2. Declared before gtag.js can possibly load, so the tag
  // never writes a cookie on a denied visit.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 500
  });

  function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;

    gtag('consent', 'update', { analytics_storage: 'granted' });

    var script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID;
    document.head.appendChild(script);

    gtag('js', new Date());
    gtag('config', MEASUREMENT_ID, { anonymize_ip: true });
  }

  function clearAnalyticsCookies() {
    gtag('consent', 'update', { analytics_storage: 'denied' });
    var host = window.location.hostname;
    document.cookie.split(";").forEach(function (entry) {
      var name = entry.split("=")[0].trim();
      if (name.indexOf("_ga") !== 0) return;
      ["/", ""].forEach(function (path) {
        ["", "." + host, host].forEach(function (domain) {
          document.cookie = name + "=; Max-Age=0; path=" + (path || "/")
            + (domain ? "; domain=" + domain : "");
        });
      });
    });
  }

  function apply(state) {
    if (state && state.analytics) {
      loadAnalytics();
    } else {
      clearAnalyticsCookies();
    }
    handlers.forEach(function (handler) { handler(state); });
  }

  var api = {
    VERSION: VERSION,
    get: read,
    has: function (category) {
      var state = read();
      return Boolean(state && state[category]);
    },
    set: function (categories) {
      var state = {
        version: VERSION,
        analytics: Boolean(categories && categories.analytics),
        at: new Date().toISOString()
      };
      write(state);
      apply(state);
      return state;
    },
    onChange: function (handler) { handlers.push(handler); }
  };

  window.InkyscibConsent = api;

  var existing = read();
  if (existing) apply(existing);
}());
```

- [ ] **Step 4: Replace the inline GA4 snippet on every page**

In `templates/_marketing.html`, **delete** the whole `<!-- Google tag (gtag.js) -->` block (lines 39-47) and put in its place:

```html
  {# Analytics is loaded by consent.js, and only after a yes. The tag, the
     measurement ID and Consent Mode defaults all live there; nothing
     analytics-related may be inlined here again. #}
  <script src="{{ url_for('static', filename='js/consent.js', v='consent-1') }}"></script>
```

It is deliberately **not** `defer`: the Consent Mode default must be on the dataLayer
before anything else can queue a measurement.

Apply the same replacement in `templates/write.html`.

- [ ] **Step 5: Switch the YouTube embed to the no-cookie host**

```bash
grep -rn "youtube.com/embed" static/js/ templates/
```

Replace every `https://www.youtube.com/embed/` with `https://www.youtube-nocookie.com/embed/`.
`frame-src` in `CONTENT_SECURITY_POLICY` (`app.py:1061`) already allows that origin, so
the CSP needs no change. The search API calls at `app.py:1418` are server-to-server and
carry no visitor identifier — leave them alone.

- [ ] **Step 6: Update the existing analytics test — it is green today and this task breaks it**

`tests/test_analytics_csp.py` asserts the gtag URL and `gtag('config', …)` each appear
exactly once **in the served HTML**. After this task they appear in `consent.js` instead.
Replace that assertion block in
`test_analytics_tag_and_core_ga4_origins_are_available_on_pages` with:

```python
        consent_js = (
            Path(app.root_path) / "static" / "js" / "consent.js"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            consent_js.count(
                '"https://www.googletagmanager.com/gtag/js?id=" + MEASUREMENT_ID'
            ),
            1,
        )
        self.assertEqual(consent_js.count(f'"{MEASUREMENT_ID}"'), 1)

        for path in ("/", "/write"):
            with self.subTest(path=path):
                response = self.client.get(path)
                html = response.get_data(as_text=True)
                directives = parse_csp(response.headers["Content-Security-Policy"])

                self.assertEqual(response.status_code, 200)
                # The origins stay allowed -- the tag is injected at runtime.
                for directive, source in required_sources.items():
                    self.assertIn(source, directives[directive])
                # ...but nothing ships in the document any more.
                self.assertNotIn("googletagmanager.com/gtag/js", html)
```

Add `from pathlib import Path` to that file's imports. The CSP assertions and
`test_optional_advertising_origins_remain_disabled` stay exactly as they are.

- [ ] **Step 7: Run both test modules to verify they pass**

Run: `python -m pytest tests/test_consent.py tests/test_analytics_csp.py -q`
Expected: PASS (9 in `test_consent.py`, plus the existing analytics module still green).

- [ ] **Step 8: Commit**

```bash
git add static/js/consent.js static/js/ templates/ tests/test_consent.py tests/test_analytics_csp.py
git commit -m "feat(privacy): load no tracker before consent; youtube-nocookie"
```

---

## Task 18: The consent banner

Covers: ePrivacy prior consent in a usable form, GDPR Art. 7(3) (withdrawal as easy as
consent), and the dark-pattern rules the EDPB and the CNIL both enforce — **Reject must be
as easy to reach as Accept, on the first layer, with equal visual weight.** A banner whose
"Reject" is a second click is worth less than no banner, because it documents intent to
evade.

**Files:**
- Create: `static/css/consent.css`, `static/js/consent-banner.js`
- Modify: `templates/_marketing.html`, `templates/write.html` (one include each), `templates/_consent_banner.html` (create)
- Modify: `static/css/marketing.css` (footer link)
- Test: `tests/test_consent.py`

**Interfaces:**
- Consumes: `window.InkyscibConsent` (Task 17).
- Produces: `window.InkyscibConsent.openPreferences()` — attached by `consent-banner.js`, called by the footer link in every page and by the "Privacy choices" row the legal pages add in Task 21.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_consent.py`, inside `ConsentGateTests`:

```python
    def test_the_banner_appears_on_a_first_visit_and_offers_both_answers_equally(self):
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.wait_for_selector("#consentBanner", state="visible")
            accept = page.locator("#consentAccept").bounding_box()
            reject = page.locator("#consentReject").bounding_box()
            role = page.get_attribute("#consentBanner", "role")
        finally:
            page.close()

        self.assertEqual(role, "dialog")
        # Equal prominence: same height, and within 20% on width.
        self.assertAlmostEqual(accept["height"], reject["height"], delta=1)
        self.assertLess(abs(accept["width"] - reject["width"]) / accept["width"], 0.2)

    def test_rejecting_closes_the_banner_and_keeps_it_closed(self):
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.click("#consentReject")
            page.wait_for_selector("#consentBanner", state="hidden")
            page.reload(wait_until="load")
            visible = page.is_visible("#consentBanner")
        finally:
            page.close()

        self.assertFalse(visible)

    def test_the_banner_is_reachable_and_dismissable_from_the_keyboard(self):
        page = self._page()
        try:
            page.goto(f"{self.base_url}/", wait_until="load")
            page.wait_for_selector("#consentBanner", state="visible")
            page.keyboard.press("Tab")
            focused = page.evaluate("() => document.activeElement.id")
            page.keyboard.press("Enter")
            page.wait_for_selector("#consentBanner", state="hidden")
        finally:
            page.close()

        self.assertIn(focused, ("consentReject", "consentAccept"))

    def test_every_page_offers_a_way_back_to_the_choice(self):
        for path in ("/", "/features", "/about", "/write"):
            with self.subTest(path=path):
                page = self._page()
                try:
                    page.goto(f"{self.base_url}{path}", wait_until="load")
                    page.evaluate(
                        "() => window.InkyscibConsent.set({ analytics: false })"
                    )
                    page.click("#consentPreferencesLink")
                    page.wait_for_selector("#consentBanner", state="visible")
                finally:
                    page.close()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_consent.py::ConsentGateTests -q`
Expected: FAIL — no `#consentBanner` element exists.

- [ ] **Step 3: Write the banner markup**

Create `templates/_consent_banner.html`:

```html
{# One banner, included by every page. Reject and Accept are the same control
   with different labels: equal size, equal weight, both on the first layer.
   The EDPB treats a dimmed or buried "reject" as invalid consent. #}
<div id="consentBanner" class="consent-banner" role="dialog" aria-modal="false"
     aria-labelledby="consentTitle" aria-describedby="consentBody" hidden>
  <div class="consent-inner">
    <h2 id="consentTitle" class="consent-title">Analytics, only if you say so</h2>
    <p id="consentBody" class="consent-body">
      Your notes never leave your device — that part has no choice to make.
      Separately, we can count anonymous page visits with Google Analytics to
      see whether anyone is using this. It sets a cookie and sends your IP to
      Google. It is off until you turn it on, and you can change your mind any
      time from the footer.
      <a href="{{ url_for('privacy') }}">Privacy policy</a> ·
      <a href="{{ url_for('cookies') }}">Cookies</a>
    </p>
    <div class="consent-actions">
      <button type="button" id="consentReject" class="consent-btn">Reject analytics</button>
      <button type="button" id="consentAccept" class="consent-btn">Accept analytics</button>
    </div>
  </div>
</div>
```

`url_for('privacy')` and `url_for('cookies')` are the routes created in Task 21. **Do Task
21 first if you want the pages to exist when you click through**, or stub the two routes
now; the test above does not follow the links.

- [ ] **Step 4: Write the banner behaviour**

Create `static/js/consent-banner.js`:

```javascript
/* Shows the consent choice, and lets it be changed again. All state goes
   through window.InkyscibConsent -- this file owns no policy. */
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") { fn(); return; }
    document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var banner = document.getElementById("consentBanner");
    if (!banner || !window.InkyscibConsent) return;

    var accept = document.getElementById("consentAccept");
    var reject = document.getElementById("consentReject");
    var link = document.getElementById("consentPreferencesLink");

    function open() {
      banner.hidden = false;
      reject.focus();   // the privacy-preserving option gets the focus
    }

    function close() { banner.hidden = true; }

    function choose(analytics) {
      window.InkyscibConsent.set({ analytics: analytics });
      close();
    }

    accept.addEventListener("click", function () { choose(true); });
    reject.addEventListener("click", function () { choose(false); });
    if (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        open();
      });
    }

    window.InkyscibConsent.openPreferences = open;

    if (!window.InkyscibConsent.get()) open();
  });
}());
```

- [ ] **Step 5: Style it**

Create `static/css/consent.css`, using the existing token vocabulary only — no
`--consent-*` palette (`DESIGN.md`, and `CLAUDE.md`'s first repeated rule):

```css
.consent-banner {
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 9998;              /* under the File ribbon at 9996+... see note */
  background: var(--surface);
  border-block-start: 1px solid var(--rule);
  padding: var(--s4);
}

.consent-banner[hidden] { display: none; }

.consent-inner {
  max-inline-size: 72ch;
  margin-inline: auto;
  display: grid;
  gap: var(--s3);
}

.consent-title { margin: 0; font-size: var(--t-4); font-weight: 700; }
.consent-body { margin: 0; color: var(--ink-2); }

.consent-actions { display: flex; gap: var(--s3); flex-wrap: wrap; }

/* Equal weight, both answers. Differing only in label is the point. */
.consent-btn {
  flex: 1 1 14rem;
  min-block-size: var(--tap);
  padding-inline: var(--s4);
  border: 1px solid var(--rule);
  border-radius: var(--r2);
  background: var(--surface-2);
  color: var(--ink-1);
  font: inherit;
  cursor: pointer;
}

.consent-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

> **Check the z-index against the editor before accepting this.** `TODOS.md` records a
> floating panel at `z-index: 11` being covered by a File ribbon fixed at 9996. Open
> `/write` with the banner showing and confirm it sits above the ribbon and below nothing
> that matters; adjust once, here, rather than per page.

- [ ] **Step 6: Include it everywhere**

In `templates/_marketing.html`, before `</body>`:

```html
  {% include "_consent_banner.html" %}
  <script src="{{ url_for('static', filename='js/consent-banner.js', v='consent-1') }}" defer></script>
```

and in the `<head>`, beside the other stylesheets:

```html
  <link rel="stylesheet" href="{{ url_for('static', filename='css/consent.css', v='consent-1') }}">
```

Add the same three lines to `templates/write.html`.

In the footer of `templates/_marketing.html`, beside the existing links:

```html
        <a href="#" id="consentPreferencesLink">Privacy choices</a>
```

`/write` has no site footer, so add the same link to the editor's existing credit row
(`static/js/footer-signature.js` renders it; the anchor belongs in the template beside it,
not in the canvas). Keep the id identical — the test checks all four pages.

- [ ] **Step 7: Run the test to verify it passes**

Run: `python -m pytest tests/test_consent.py -q`
Expected: PASS (13 tests)

- [ ] **Step 8: Look at it, on a phone**

Open `/` at 360px. The banner must not cover the primary CTA permanently, both buttons must
be full-width and 44px tall, and dismissing it must not shift the page (it is `position:
fixed`, so CLS stays zero — confirm with the Task 10 vitals test, which now runs against a
page that shows the banner).

- [ ] **Step 9: Commit**

```bash
git add static/css/consent.css static/js/consent-banner.js templates/ tests/test_consent.py
git commit -m "feat(privacy): consent banner with equal-weight accept and reject"
```

---

## Task 19: Regional wording, Global Privacy Control, and "Do Not Sell or Share"

Covers: CCPA/CPRA §1798.135 and §1798.185(a)(20) (GPC is a legally binding opt-out signal
in California and Colorado), VCDPA/CPA/CTDPA/UCPA opt-outs, and the "geographic consent
routing" item — implemented the way that does not create a new privacy problem.

> **Design decision, stated so a reviewer can reject it:** the banner defaults to the
> **strictest regime for everyone**, and region only changes *wording*, never whether the
> gate exists. Two reasons. Geolocating a visitor means processing their IP against a
> database — a new processing activity, to decide how much to respect their privacy. And
> the total non-essential tracking here is one analytics tag: opt-in globally costs almost
> nothing and is defensible everywhere. Region is read from an **edge header if the
> platform sets one** (`CF-IPCountry` on Cloudflare), never from an IP lookup, and the
> header is used and discarded, never logged.

**Files:**
- Modify: `app.py` (region hint in the context processor), `static/js/consent.js`, `templates/_consent_banner.html`, `templates/_marketing.html` (footer)
- Test: `tests/test_consent.py`, `tests/test_legal.py` (create)

**Interfaces:**
- Consumes: `window.InkyscibConsent` (Task 17).
- Produces: `app.visitor_region() -> str` (an uppercase ISO-3166-1 alpha-2 code, or `""`), the template global `visitor_region`, and `window.InkyscibConsent.gpc(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_legal.py` with its first class (the rest arrives in Task 21):

```python
import unittest
from unittest import mock

import app as app_module
from app import app


class RegionHintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_an_edge_country_header_is_surfaced_to_the_template(self):
        html = self.client.get("/", headers={"CF-IPCountry": "de"}).get_data(as_text=True)
        self.assertIn('data-region="DE"', html)

    def test_no_header_means_no_region_and_the_strict_default(self):
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn('data-region=""', html)

    def test_a_california_visitor_is_offered_the_sale_opt_out_link(self):
        html = self.client.get(
            "/", headers={"CF-IPCountry": "US"}
        ).get_data(as_text=True)
        self.assertIn("Do Not Sell or Share My Personal Information", html)

    def test_the_opt_out_link_is_present_for_every_visitor_too(self):
        """CPRA wants it on the homepage; showing it to everyone is simpler
        than deciding who is Californian, and costs nothing."""
        for path in ("/", "/features", "/about"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn('id="doNotSellLink"', html)

    def test_the_country_header_is_never_written_to_a_log(self):
        with mock.patch.object(app_module.logger, "info") as info:
            self.client.get("/", headers={"CF-IPCountry": "DE"})
        for call in info.call_args_list:
            self.assertNotIn("DE", str(call))
```

And append to `ConsentGateTests` in `tests/test_consent.py`:

```python
    def test_a_global_privacy_control_signal_is_honoured_without_asking(self):
        """CPRA and the Colorado AG treat GPC as a valid opt-out. A visitor
        who sends it must never see the banner, and must never be tracked."""
        page = self.browser.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator, 'globalPrivacyControl',"
            " { value: true, configurable: true });"
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed');"
        )
        requests = []
        page.on("request", lambda request: requests.append(request.url))
        try:
            page.goto(f"{self.base_url}/", wait_until="networkidle")
            banner_visible = page.is_visible("#consentBanner")
            state = page.evaluate("() => window.InkyscibConsent.get()")
        finally:
            page.close()

        self.assertFalse(banner_visible)
        self.assertFalse(state["analytics"])
        self.assertEqual([url for url in requests if "googletagmanager" in url], [])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m pytest tests/test_legal.py tests/test_consent.py -q`
Expected: FAIL — no `data-region`, no opt-out link, and GPC is ignored.

- [ ] **Step 3: Surface the region hint without storing it**

In `app.py`, below `site_url`:

```python
def visitor_region():
    """An ISO-3166-1 alpha-2 country, if the edge told us one.

    Cloudflare sets CF-IPCountry; Fly sets Fly-Region (a datacentre, not a
    country, so it is not used here). Nothing geolocates an IP: that would be
    a new processing activity undertaken to decide how much privacy to give,
    which is the wrong shape. The value is used to pick banner wording and is
    never logged, stored, or sent anywhere.
    """
    country = request.headers.get("CF-IPCountry", "").strip().upper()
    return country if len(country) == 2 and country.isalpha() else ""
```

Add it to the context processor from Task 1:

```python
        "visitor_region": visitor_region(),
```

- [ ] **Step 4: Put the hint on the document**

In `templates/_marketing.html` and `templates/write.html`, on the `<html>` tag:

```html
<html lang="en" data-region="{{ visitor_region }}">
```

(`write.html` already has `data-pattern="dot"` there — add the attribute, keep the rest.)

- [ ] **Step 5: Honour Global Privacy Control**

In `static/js/consent.js`, inside the IIFE, add to the `api` object:

```javascript
    gpc: function () {
      return Boolean(window.navigator && window.navigator.globalPrivacyControl);
    },
```

and replace the last two lines of the IIFE with:

```javascript
  // A GPC signal is a legally recognised opt-out in California and Colorado.
  // It answers the question, so the banner never asks it.
  if (api.gpc()) {
    var denied = { version: VERSION, analytics: false, at: new Date().toISOString(),
                   source: "gpc" };
    write(denied);
    apply(denied);
  } else {
    var existing = read();
    if (existing) apply(existing);
  }
```

- [ ] **Step 6: Add the CPRA opt-out link**

In the footer of `templates/_marketing.html`, beside "Privacy choices":

```html
        <a href="#" id="doNotSellLink">Do Not Sell or Share My Personal Information</a>
```

In `static/js/consent-banner.js`, inside the `ready` callback:

```javascript
    var doNotSell = document.getElementById("doNotSellLink");
    if (doNotSell) {
      doNotSell.addEventListener("click", function (event) {
        event.preventDefault();
        // Inkyscib sells nothing and shares nothing for advertising. The only
        // thing this can switch off is analytics, so it does exactly that and
        // says so, rather than opening a menu of options that do not exist.
        window.InkyscibConsent.set({ analytics: false });
        window.alert(
          "Analytics is now off for this browser. Inkyscib does not sell or "
          + "share personal information for advertising, and never has."
        );
      });
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `python -m pytest tests/test_legal.py tests/test_consent.py -q`
Expected: PASS (5 in `test_legal.py`, 14 in `test_consent.py`)

- [ ] **Step 8: Commit**

```bash
git add app.py static/js/ templates/ tests/test_legal.py tests/test_consent.py
git commit -m "feat(privacy): honour GPC, surface the CPRA opt-out, regional wording"
```

---

## Task 20: A tamper-evident consent record

The checklist asks for an immutable audit trail of consent in a database table. **Inkyscib
has no database and no user records, and creating a server-side row per visitor to prove
we collect little would be self-defeating.** The design that satisfies the intent without
inverting it:

- The **authoritative** record is the visitor's own, in their browser: version, categories, timestamp, and how it was given (`banner`, `gpc`, `preferences`).
- The **audit** record is a server-side append-only JSONL file, **hash-chained** so any edit or deletion is detectable, containing a client-generated random id, the consent version, the categories and a coarse timestamp — **no IP, no user agent, no page, nothing that identifies a person.** It proves *what the site asked and what was answered, over time*, which is what a regulator actually asks for.

**Files:**
- Create: `consent_log.py`, `tools/verify_consent_log.py`
- Modify: `app.py` (one route), `static/js/consent.js` (one beacon)
- Test: `tests/test_consent_log.py` (create)

**Interfaces:**
- Consumes: `window.InkyscibConsent` (Task 17).
- Produces: `consent_log.append(record: dict) -> str` (returns the new head hash), `consent_log.verify(path: Path) -> tuple[bool, int]` (ok, entries checked), `consent_log.LOG_PATH`, and `POST /api/consent` → `{"ok": true}`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_consent_log.py`:

```python
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import consent_log
from app import app


class HashChainTests(unittest.TestCase):
    def setUp(self):
        self._dir = TemporaryDirectory()
        self.path = Path(self._dir.name) / "consent-log.jsonl"
        self._original = consent_log.LOG_PATH
        consent_log.LOG_PATH = self.path

    def tearDown(self):
        consent_log.LOG_PATH = self._original
        self._dir.cleanup()

    def test_each_entry_chains_to_the_one_before_it(self):
        first = consent_log.append({"id": "a", "analytics": True})
        second = consent_log.append({"id": "b", "analytics": False})

        lines = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual(lines[0]["hash"], first)
        self.assertEqual(lines[1]["prev"], first)
        self.assertEqual(lines[1]["hash"], second)

    def test_verify_accepts_an_untouched_log(self):
        for index in range(5):
            consent_log.append({"id": str(index), "analytics": index % 2 == 0})

        ok, checked = consent_log.verify(self.path)
        self.assertTrue(ok)
        self.assertEqual(checked, 5)

    def test_verify_detects_an_edited_entry(self):
        consent_log.append({"id": "a", "analytics": False})
        consent_log.append({"id": "b", "analytics": False})

        lines = self.path.read_text().splitlines()
        tampered = json.loads(lines[0])
        tampered["analytics"] = True          # someone "fixes" the record
        lines[0] = json.dumps(tampered)
        self.path.write_text("\n".join(lines) + "\n")

        ok, _ = consent_log.verify(self.path)
        self.assertFalse(ok)

    def test_verify_detects_a_removed_entry(self):
        consent_log.append({"id": "a", "analytics": True})
        consent_log.append({"id": "b", "analytics": True})
        consent_log.append({"id": "c", "analytics": True})

        lines = self.path.read_text().splitlines()
        self.path.write_text("\n".join([lines[0], lines[2]]) + "\n")

        ok, _ = consent_log.verify(self.path)
        self.assertFalse(ok)

    def test_nothing_identifying_is_ever_written(self):
        consent_log.append({"id": "a", "analytics": True})
        entry = json.loads(self.path.read_text().splitlines()[0])

        for forbidden in ("ip", "remote_addr", "user_agent", "referer", "path"):
            with self.subTest(field=forbidden):
                self.assertNotIn(forbidden, entry)


class ConsentEndpointTests(unittest.TestCase):
    def setUp(self):
        self._dir = TemporaryDirectory()
        self._original = consent_log.LOG_PATH
        consent_log.LOG_PATH = Path(self._dir.name) / "consent-log.jsonl"
        self.client = app.test_client()

    def tearDown(self):
        consent_log.LOG_PATH = self._original
        self._dir.cleanup()

    def test_a_consent_record_is_accepted_and_chained(self):
        response = self.client.post(
            "/api/consent",
            json={"id": "5f3c...", "version": 1, "analytics": True, "source": "banner"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(len(consent_log.LOG_PATH.read_text().splitlines()), 1)

    def test_the_endpoint_drops_any_field_it_was_not_expecting(self):
        self.client.post(
            "/api/consent",
            json={"id": "x", "version": 1, "analytics": True, "source": "banner",
                  "email": "someone@example.com", "ip": "203.0.113.4"},
        )
        entry = json.loads(consent_log.LOG_PATH.read_text().splitlines()[0])

        self.assertNotIn("email", entry)
        self.assertNotIn("ip", entry)

    def test_a_malformed_body_is_rejected_without_writing(self):
        response = self.client.post("/api/consent", json={"analytics": "yes please"})

        self.assertEqual(response.status_code, 400)
        self.assertFalse(consent_log.LOG_PATH.exists())
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_consent_log.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'consent_log'`.

- [ ] **Step 3: Write the chain**

Create `consent_log.py` beside `app.py`:

```python
"""An append-only, hash-chained record of what was consented to.

Not a user table. Every entry carries a random id the browser generated, the
version of the notice that was shown, the categories chosen and a coarse
timestamp -- and nothing else. No IP, no user agent, no page, no fingerprint.
That is enough to answer "what did you ask, and what did people answer, on
what date" without holding a single identifiable record.

Each line embeds the SHA-256 of the previous line, so editing or deleting any
entry breaks every hash after it. Tamper-evident, not tamper-proof: for real
immutability the file belongs on write-once storage or an external log sink,
which is a hosting decision, not a code one.
"""

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path(
    os.environ.get("CONSENT_LOG_PATH", Path(__file__).parent / "data" / "consent-log.jsonl")
)

GENESIS = "0" * 64

# Only these fields are ever persisted. Anything else a caller passes is
# dropped rather than trusted.
ALLOWED_FIELDS = ("id", "version", "analytics", "source")

_lock = threading.Lock()


def _digest(payload):
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _head(path):
    if not path.exists():
        return GENESIS
    last = None
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                last = line
    return json.loads(last)["hash"] if last else GENESIS


def append(record):
    """Append one consent record. Returns the new head hash."""
    entry = {field: record.get(field) for field in ALLOWED_FIELDS if field in record}
    # Minute precision: enough to prove sequence, too coarse to correlate with
    # a web server's request timing.
    entry["at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")

    with _lock:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        entry["prev"] = _head(LOG_PATH)
        entry["hash"] = _digest({k: v for k, v in entry.items() if k != "hash"})
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    return entry["hash"]


def verify(path=None):
    """Walk the chain. Returns (ok, entries_checked)."""
    path = Path(path) if path else LOG_PATH
    if not path.exists():
        return True, 0

    previous = GENESIS
    checked = 0
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            entry = json.loads(line)
            if entry.get("prev") != previous:
                return False, checked
            expected = _digest({k: v for k, v in entry.items() if k != "hash"})
            if entry.get("hash") != expected:
                return False, checked
            previous = entry["hash"]
            checked += 1
    return True, checked
```

- [ ] **Step 4: Add the endpoint**

In `app.py`, beside the other API routes:

```python
import consent_log  # at the top, with the other first-party imports


@app.post("/api/consent")
def record_consent():
    """Append a consent choice to the audit chain.

    Deliberately not authenticated and deliberately not rate-limited by IP:
    both would mean identifying the caller. The worst a flood can do is grow a
    file of anonymous rows, which the retention job in
    docs/legal/data-retention.md trims.
    """
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload.get("analytics"), bool):
        return jsonify({"error": "analytics must be a boolean"}), 400
    if not isinstance(payload.get("version"), int):
        return jsonify({"error": "version must be an integer"}), 400

    consent_log.append(payload)
    return jsonify({"ok": True})
```

- [ ] **Step 5: Send the record from the browser**

In `static/js/consent.js`, inside `api.set`, after `apply(state)`:

```javascript
      try {
        var id = window.localStorage.getItem("inkyscib-consent-id");
        if (!id) {
          id = (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : String(Date.now()) + Math.random().toString(16).slice(2);
          window.localStorage.setItem("inkyscib-consent-id", id);
        }
        // Fire-and-forget: the visitor's own record is authoritative, and a
        // failed beacon must never block the choice from taking effect.
        window.fetch("/api/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: id, version: VERSION, analytics: state.analytics,
            source: categories && categories.source ? categories.source : "banner"
          }),
          keepalive: true
        }).catch(function () {});
      } catch (error) { /* storage blocked: no audit row, no harm */ }
```

`connect-src 'self'` is already in the CSP, so no policy change is needed.

- [ ] **Step 6: Write the verifier**

Create `tools/verify_consent_log.py`:

```python
"""Check the consent chain. Run it before any audit, and on a schedule.

    python tools/verify_consent_log.py [path]

Exit code 0 means every entry hashes to what it claims and nothing has been
removed. Exit code 1 means the file has been edited since it was written.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import consent_log  # noqa: E402


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else consent_log.LOG_PATH
    ok, checked = consent_log.verify(path)
    print(f"{path}: {checked} entries, chain {'intact' if ok else 'BROKEN'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 7: Keep the log out of git**

Append to `.gitignore`:

```gitignore
# Consent audit chain: real records, never committed
data/consent-log.jsonl
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `python -m pytest tests/test_consent_log.py -q`
Expected: PASS (8 tests)

- [ ] **Step 9: Commit**

```bash
git add consent_log.py tools/verify_consent_log.py app.py static/js/consent.js .gitignore tests/test_consent_log.py
git commit -m "feat(privacy): hash-chained, non-identifying consent audit trail"
```

---
## Task 21: The legal documents, and the routes that serve them

Covers: T&C, Privacy Policy, Cookie & Tracking Policy, the EULA question, and the
jurisdiction-specific notices (GDPR/UK GDPR, **India DPDP 2023**, CCPA/CPRA, VCDPA, CPA,
CTDPA, UCPA, COPPA, LGPD, PIPEDA, Australian APPs, Singapore PDPA).

> **On the EULA:** Inkyscib ships **no downloadable desktop or mobile client**. It is a web
> app with a PWA manifest; "Install" creates a shortcut to the same site, and no licensed
> binary changes hands. A separate EULA would therefore describe a thing that does not
> exist. The T&C gets an *Installation and offline use* clause instead, and the MIT licence
> already governs the source. **If a packaged client ever ships, a real EULA is required —
> that is written into `docs/legal/README.md` as a trigger, not left to memory.**

**Files:**
- Create: `templates/legal/terms.html`, `templates/legal/privacy.html`, `templates/legal/cookies.html`, `templates/legal/_legal.html` (shared shell)
- Create: `docs/legal/README.md` (what triggers a re-review), `docs/legal/data-map.md`
- Modify: `app.py` (three routes + `SITEMAP_ROUTES` + `SITEMAP_TEMPLATES`), `templates/_marketing.html` (footer)
- Test: `tests/test_legal.py`

**Interfaces:**
- Consumes: `site_url`, the `_marketing.html` shell.
- Produces: routes `privacy`, `cookies`, `terms` at `/legal/privacy`, `/legal/cookies`, `/legal/terms` — the endpoint names `url_for('privacy')` and `url_for('cookies')` are what Task 18's banner already calls.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_legal.py`:

```python
LEGAL_PAGES = ("/legal/privacy", "/legal/cookies", "/legal/terms")


class LegalPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True) for path in LEGAL_PAGES
        }

    def test_each_legal_page_is_served_and_dated(self):
        for path, html in self.html.items():
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)
                self.assertIn("Last updated", html)

    def test_the_privacy_policy_answers_the_five_questions_it_must(self):
        html = self.html["/legal/privacy"]
        for required in (
            "What we collect",
            "Why we are allowed to",
            "Where it goes",
            "How long we keep it",
            "Your rights",
        ):
            with self.subTest(section=required):
                self.assertIn(required, html)

    def test_the_privacy_policy_names_every_third_party_that_receives_data(self):
        html = self.html["/legal/privacy"]
        for processor in ("Google Analytics", "YouTube", "Google Fonts"):
            with self.subTest(processor=processor):
                self.assertIn(processor, html)

    def test_the_policy_covers_each_regime_the_product_is_exposed_to(self):
        html = self.html["/legal/privacy"]
        for regime in (
            "GDPR", "UK GDPR", "Digital Personal Data Protection Act",
            "CCPA", "CPRA", "LGPD", "PIPEDA", "Privacy Act 1988", "PDPA", "COPPA",
        ):
            with self.subTest(regime=regime):
                self.assertIn(regime, html)

    def test_the_cookie_policy_itemises_every_cookie_by_category(self):
        html = self.html["/legal/cookies"]
        for column in ("Name", "Purpose", "Category", "Expiry"):
            with self.subTest(column=column):
                self.assertIn(column, html)
        for category in ("Essential", "Analytics"):
            with self.subTest(category=category):
                self.assertIn(category, html)
        # Nothing on this site is a marketing cookie; the policy has to say so
        # rather than list an empty category.
        self.assertIn("No marketing or advertising cookies", html)

    def test_the_terms_cover_ip_liability_and_acceptable_use(self):
        html = self.html["/legal/terms"]
        for clause in (
            "Your work is yours",
            "Intellectual property",
            "Acceptable use",
            "Limitation of liability",
            "No warranty",
            "Installation and offline use",
            "Governing law",
        ):
            with self.subTest(clause=clause):
                self.assertIn(clause, html)

    def test_every_page_on_the_site_links_to_the_legal_pages(self):
        for path in ("/", "/features", "/about", "/write"):
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                for legal in LEGAL_PAGES:
                    self.assertIn(f'href="{legal}"', html)

    def test_the_legal_pages_are_in_the_sitemap(self):
        listed = {path for path, _, _ in app_module.SITEMAP_ROUTES}
        for path in LEGAL_PAGES:
            with self.subTest(path=path):
                self.assertIn(path, listed)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_legal.py -q`
Expected: FAIL — 404 on all three routes.

- [ ] **Step 3: Build the shared shell and the three documents**

`templates/legal/_legal.html` extends `_marketing.html`, sets `body_class` to
`page-content`, and renders `{% block legal_body %}` inside a `.page-head` + `.legal-prose`
wrapper with an `h1`, a "Last updated {{ legal_updated }}" line, and a table of contents
built from the document's own `h2`s.

Each document must contain, at minimum, the headings the tests above assert, plus:

**`privacy.html`** — written around what is actually true, which is unusually little:
- *What we collect*: nothing about you, by default. Notes, drawings, preferences and the notebook library stay in the browser (localStorage + IndexedDB) and are never uploaded. Server-side: a PDF or deck you import is held in a temporary directory for the seconds it takes to convert, then deleted (`tempfile.TemporaryDirectory`, `app.py:2051/2110/2509`). Web-server access logs with the IP truncated (Task 23). An anonymous consent record (Task 20). Google Analytics, only after consent.
- *Why we are allowed to*: consent (GDPR Art. 6(1)(a)) for analytics; legitimate interests (Art. 6(1)(f)) for security logs; DPDP §6 notice-and-consent; PIPEDA express consent.
- *Where it goes*: named sub-processors — Google Ireland/LLC (Analytics, Fonts, YouTube), the hosting provider. Transfers outside the EEA/UK rely on the EU-US Data Privacy Framework and Google's SCCs.
- *How long we keep it*: access logs 30 days; consent chain 24 months; GA4 retention set to the 2-month minimum (Task 24); imported files, seconds.
- *Your rights*: access, erasure, rectification, portability, objection, withdrawal (GDPR/UK GDPR); know/delete/correct/opt-out (CPRA); the same under VCDPA, CPA, CTDPA, UCPA; DPDP §11-13; LGPD Art. 18; PIPEDA; APP 12/13; PDPA. **With the honest addition that for browser-stored work the visitor exercises these themselves, in one click — see Task 22 — because nobody else can reach it.**
- *Children*: **DPDP §9 treats everyone under 18 as a child and forbids tracking or behavioural monitoring of them; COPPA applies under 13.** Inkyscib shows no ads, builds no profiles, and runs no behavioural tracking of anyone. Analytics stays off unless consent is given.
- *Complaints*: the ICO (UK), the lead EU supervisory authority, and India's Data Protection Board, each named with a link.
- *Contact*: a real, monitored address for rights requests, with the 30-day statutory response window stated.

**`cookies.html`** — an itemised table, because the checklist asks for one and because it is the only honest way to publish this:

| Name | Purpose | Category | Set by | Expiry |
|---|---|---|---|---|
| `inkyscib-consent-v1` | Remembers your analytics choice | Essential (localStorage, not a cookie) | Inkyscib | Until cleared |
| `inkyscib-consent-id` | Random id linking your choice to the audit record | Essential (localStorage) | Inkyscib | Until cleared |
| `theme`, `inkyscib-*` preferences, notebooks (IndexedDB) | Your settings and your work | Essential (local storage only) | Inkyscib | Until cleared |
| `_ga`, `_ga_<id>` | Distinguishes anonymous visitors | **Analytics — only after consent** | Google | 2 years / 2 years |
| YouTube player cookies | Only if you open a lecture, via `youtube-nocookie.com` | Analytics/functional, on interaction | Google | Varies |

plus the sentence the test pins: *"No marketing or advertising cookies are used on this
site, and none ever will be while it is free and ad-free."* — and a "Change your choice"
button wired to `window.InkyscibConsent.openPreferences()`.

**`terms.html`** — the clauses the test pins, each written short:
- *Your work is yours*: no licence to your content is claimed, because we never receive it.
- *Intellectual property*: Inkyscib's source is MIT (link `LICENSE`); the name and marks are not.
- *Acceptable use*: no uploading material you have no right to convert; no attempt to break the import/export pipeline; no automated hammering of the conversion endpoints; the import size ceiling is 120 MB (`app.config["MAX_CONTENT_LENGTH"]`, `app.py:50`).
- *Third-party content*: YouTube lectures are played under Google's terms; Inkyscib neither hosts nor licenses them.
- *No warranty / Limitation of liability*: provided as-is, free; liability limited to the maximum extent the applicable law allows, with the explicit carve-out that nothing excludes liability for death, personal injury or fraud — an unqualified exclusion is void in the UK, EU and India, and a clause that is void protects nobody.
- *Your work can be lost*: browser storage can be cleared by the browser, by private mode, or by the visitor; **export a backup**. This is the clause that matters most in practice for a local-first app.
- *Installation and offline use*: the PWA is a shortcut to this site, not a licensed binary; no EULA applies.
- *Changes, termination, governing law*: India, courts of Ranchi/Jharkhand, without prejudice to the mandatory consumer-protection rights of a visitor's home jurisdiction.

- [ ] **Step 4: Add the routes**

```python
LEGAL_UPDATED = "2026-09-20"


@app.route("/legal/privacy")
def privacy():
    return render_template("legal/privacy.html", nav_active="",
                           legal_updated=LEGAL_UPDATED)


@app.route("/legal/cookies")
def cookies():
    return render_template("legal/cookies.html", nav_active="",
                           legal_updated=LEGAL_UPDATED)


@app.route("/legal/terms")
def terms():
    return render_template("legal/terms.html", nav_active="",
                           legal_updated=LEGAL_UPDATED)
```

Extend `SITEMAP_ROUTES` with `("/legal/privacy", "yearly", "0.3")`, `("/legal/cookies",
"yearly", "0.3")`, `("/legal/terms", "yearly", "0.3")` and `SITEMAP_TEMPLATES` with their
templates — otherwise the coverage guard from Task 3 fails, which is exactly what it is
for. Update `INDEXABLE_PAGES` in `tests/test_seo.py` to include them, so titles,
descriptions, canonicals and headings are enforced on them too.

- [ ] **Step 5: Link them from every page**

In the `_marketing.html` footer and the `/write` credit row:

```html
        <a href="{{ url_for('privacy') }}">Privacy</a> ·
        <a href="{{ url_for('cookies') }}">Cookies</a> ·
        <a href="{{ url_for('terms') }}">Terms</a>
```

- [ ] **Step 6: Write the review trigger file**

`docs/legal/README.md` lists what forces a re-read of these documents: shipping a packaged
client (EULA becomes required), adding any account or login, adding payments, adding a new
third-party script, changing hosting region, or adding any feature that uploads a visitor's
work. Each line names the file to change.

- [ ] **Step 7: Run the tests**

Run: `python -m pytest tests/test_legal.py tests/test_seo.py -q`
Expected: PASS. `test_seo.py` now covers seven pages, so its counts rise.

- [ ] **Step 8: Commit**

```bash
git add templates/legal/ docs/legal/ app.py templates/_marketing.html templates/write.html tests/
git commit -m "feat(legal): privacy, cookie and terms pages with the notices each regime needs"
```

---

## Task 22: Data subject rights, in an app that holds nothing

Covers: GDPR Art. 15/17/20 (access, erasure, portability), UK GDPR, DPDP §11-13, CPRA
know/delete, LGPD Art. 18, PIPEDA, APP 12/13, PDPA.

> Most products implement this as a support queue. Inkyscib can implement it as **two
> buttons**, because the data is on the visitor's own machine — and that is a stronger
> answer to a regulator than a 30-day email SLA. The `.inky` backup export already exists
> and *is* Art. 20 portability; it needs naming as such, and an erasure counterpart.

**Files:**
- Create: `static/js/privacy-controls.js`
- Modify: `templates/legal/privacy.html` (the controls live in the policy, where they are looked for), `static/css/consent.css`
- Test: `tests/test_privacy_controls.py` (create)

**Interfaces:**
- Consumes: the existing backup export (grep `.inky` in `static/js/`), `window.InkyscibConsent`.
- Produces: `window.InkyscibPrivacy` with `exportEverything(): Promise<Blob>`, `eraseEverything(): Promise<void>`, `inventory(): Promise<{localStorage: number, indexedDB: string[], caches: string[], cookies: number}>`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_privacy_controls.py` — a Playwright module following the house
conventions. Its four tests:

```python
    def test_the_inventory_reports_every_store_the_app_uses(self):
        # seed localStorage, an IndexedDB database and a cookie, then:
        inventory = page.evaluate("() => window.InkyscibPrivacy.inventory()")
        self.assertGreater(inventory["localStorage"], 0)
        self.assertIn("inkyscib-notebooks", inventory["indexedDB"])

    def test_export_returns_every_key_the_inventory_counted(self):
        payload = page.evaluate(
            "async () => JSON.parse(await (await window.InkyscibPrivacy"
            ".exportEverything()).text())"
        )
        self.assertIn("localStorage", payload)
        self.assertIn("indexedDB", payload)
        self.assertIn("exportedAt", payload)

    def test_erase_leaves_nothing_behind_in_any_store(self):
        page.evaluate("async () => window.InkyscibPrivacy.eraseEverything()")
        after = page.evaluate("() => window.InkyscibPrivacy.inventory()")
        self.assertEqual(after["localStorage"], 0)
        self.assertEqual(after["indexedDB"], [])
        self.assertEqual(after["caches"], [])
        self.assertEqual(after["cookies"], 0)

    def test_erase_asks_first_and_stops_on_a_no(self):
        page.on("dialog", lambda dialog: dialog.dismiss())
        page.click("#eraseEverything")
        after = page.evaluate("() => window.InkyscibPrivacy.inventory()")
        self.assertGreater(after["localStorage"], 0)
```

- [ ] **Step 2: Run it to verify it fails** — `window.InkyscibPrivacy` is undefined.

- [ ] **Step 3: Implement `static/js/privacy-controls.js`**

One IIFE, one global (the classic-script rule again). `eraseEverything` must clear, in
order: `localStorage`, `sessionStorage`, every database from `indexedDB.databases()` (with
a hardcoded fallback list for browsers that lack it — Firefox), every `caches` key, every
cookie on the origin, and finally the consent record itself. It must be irreversible and
must say so in the confirm dialog: **"This deletes every notebook, drawing and preference
in this browser. It cannot be undone. Export a backup first if you want to keep anything."**

- [ ] **Step 4: Put the controls in the privacy policy page**

Under *Your rights*, three buttons — `#exportEverything` ("Download everything this browser
holds"), `#eraseEverything` ("Erase everything in this browser"), `#consentPreferencesLink`
("Change your analytics choice") — each with a sentence naming the right it exercises
(Art. 15/20, Art. 17, Art. 7(3)). Add the postal/email route for the server-side records
(access logs, consent chain) that the visitor cannot reach themselves, with the 30-day
window stated.

- [ ] **Step 5: Run the tests, then do it by hand once**

Create two notebooks, draw on both, export, erase, reload: the app must come back as a
first-run visitor with the tour showing, and the exported file must reopen through the
existing restore path.

- [ ] **Step 6: Commit**

```bash
git add static/js/privacy-controls.js templates/legal/privacy.html static/css/consent.css tests/test_privacy_controls.py
git commit -m "feat(privacy): one-click access, portability and erasure"
```

---

## Task 23: PII-free logs, and retention that actually expires

Covers: "dynamic data anonymisation", GDPR Art. 5(1)(c) minimisation and 5(1)(e) storage
limitation, PDPA retention limits, and the SOC 2 audit-trail item as far as it applies.

**Good news first:** every upload path already uses `tempfile.TemporaryDirectory`
(`app.py:2051`, `:2110`, `:2509`), so imported documents are deleted when the request ends
even if it raises. That is real data minimisation, already shipped. It needs a test so it
stays true, not a rewrite.

**Files:**
- Create: `logging_filters.py`, `tools/prune_consent_log.py`
- Modify: `app.py` (logging configuration), `wsgi.py` / deployment notes (gunicorn access format)
- Create: `docs/legal/data-retention.md`
- Test: `tests/test_privacy_server.py` (create)

**Interfaces:**
- Produces: `logging_filters.RedactPII` (a `logging.Filter`), `logging_filters.anonymise_ip(value: str) -> str` (IPv4 → last octet zeroed, IPv6 → /48 kept), and `prune_consent_log.prune(path, months=24) -> int`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_privacy_server.py`:

```python
class LogRedactionTests(unittest.TestCase):
    def test_an_ipv4_address_loses_its_last_octet(self):
        self.assertEqual(logging_filters.anonymise_ip("203.0.113.47"), "203.0.113.0")

    def test_an_ipv6_address_is_truncated_to_a_48_bit_prefix(self):
        self.assertEqual(
            logging_filters.anonymise_ip("2001:db8:85a3:8d3:1319:8a2e:370:7348"),
            "2001:db8:85a3::",
        )

    def test_a_log_record_carrying_an_address_is_rewritten_in_place(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   "import from 203.0.113.47 ok", None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("203.0.113.47", record.getMessage())
        self.assertIn("203.0.113.0", record.getMessage())

    def test_an_uploaded_filename_never_reaches_the_log(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   'converted "Rahul medical report.pdf"', None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("Rahul", record.getMessage())
        self.assertIn("[filename]", record.getMessage())

    def test_an_email_address_never_reaches_the_log(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   "contact kz@sbpsranchi.com", None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("@", record.getMessage())


class UploadLifetimeTests(unittest.TestCase):
    def test_an_imported_pdf_leaves_nothing_on_disk(self):
        before = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.client.post("/api/pdf/import", data={...})   # the existing fixture
        after = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.assertEqual(after - before, set())

    def test_a_failed_import_also_leaves_nothing_on_disk(self):
        before = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.client.post("/api/pdf/import", data={"file": (io.BytesIO(b"not a pdf"), "x.pdf")})
        after = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.assertEqual(after - before, set())

    def test_the_app_never_writes_an_uploaded_file_outside_a_temp_directory(self):
        source = Path(app.root_path, "app.py").read_text(encoding="utf-8")
        self.assertNotIn(".save(", source.replace("secure_filename", ""))


class RetentionTests(unittest.TestCase):
    def test_consent_entries_older_than_the_window_are_pruned(self):
        # two entries stamped 30 months ago, one from today
        removed = prune_consent_log.prune(self.path, months=24)
        self.assertEqual(removed, 2)

    def test_pruning_rewrites_the_chain_so_it_still_verifies(self):
        prune_consent_log.prune(self.path, months=24)
        ok, _ = consent_log.verify(self.path)
        self.assertTrue(ok)
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Write `logging_filters.py`**

`anonymise_ip` uses `ipaddress` (stdlib): IPv4 → `/24`, IPv6 → `/48`. `RedactPII.filter`
rewrites `record.msg` (and `record.args` when they are strings) through four compiled
patterns — IPv4, IPv6, email, and quoted filenames ending in a document extension — and
returns `True`. Document plainly at the top of the file: *this runs before a record reaches
any handler, so nothing identifying is written to disk or forwarded to a log service, which
is what "strip PII before logs leave the server" has to mean in practice.*

- [ ] **Step 4: Attach it in `app.py`**

```python
import logging_filters

_pii_filter = logging_filters.RedactPII()
for _logger in (logger, logging.getLogger("werkzeug"), logging.getLogger()):
    _logger.addFilter(_pii_filter)
```

and document the gunicorn access-log format in the README, with the IP field removed
outright rather than anonymised, since it is not needed at all:

```bash
gunicorn wsgi:app --access-logformat '%(t)s "%(r)s" %(s)s %(b)s %(M)sms'
```

- [ ] **Step 5: Write `tools/prune_consent_log.py`** — drops entries older than 24 months
and **re-chains the survivors from genesis**, so `verify` still passes afterwards (a prune
that breaks the chain is indistinguishable from tampering). Print how many were removed.
Document it as a monthly cron in `docs/legal/data-retention.md`, alongside: access logs 30
days, GA4 2 months, imports seconds, browser data until the visitor clears it.

- [ ] **Step 6: Delete the stray local log**

`debug.log` is 3.0 MB in the project root. `*.log` is already in `.gitignore` and the file
is untracked, so nothing leaked — but it is a local artefact full of dev-session detail:

```bash
rm debug.log
```

- [ ] **Step 7: Run the tests and commit**

```bash
git add logging_filters.py tools/prune_consent_log.py app.py docs/legal/data-retention.md tests/test_privacy_server.py README.md
git commit -m "feat(privacy): redact PII from logs, pin upload ephemerality, set retention"
```

---

## Task 24: Cut the third-party flows that need no consent to begin with

Covers: the Google Fonts IP transfer (*LG München I, 3 O 17493/20*), GA4 configuration
(minimum retention, no Signals, no ad features), and the sub-processor list the privacy
policy promises.

> This is the task that makes the banner rarely matter: after it, a visitor who refuses
> analytics has **zero** third-party requests on the marketing pages, because the fonts are
> local. That supersedes the "self-hosting the fonts" entry in Part I's **Out of Scope** —
> Part I deferred it for performance reasons; the legal reason is stronger.

**Files:**
- Create: `static/fonts/` (woff2 files), `static/css/fonts.css`
- Modify: `templates/_marketing.html`, `templates/write.html` (drop the Google links), `app.py:1061` (drop two origins from the CSP), `tests/test_analytics_csp.py`
- Create: `docs/legal/subprocessors.md`
- Test: `tests/test_consent.py`

**Interfaces:** produces `static/css/fonts.css` with `@font-face` for Archivo 400–900 and
JetBrains Mono 400–800, both `font-display: swap`, both `unicode-range`-split for latin and
latin-ext.

- [ ] **Step 1: Write the failing test** — append to `ServedHtmlCarriesNoTrackerTests`:

```python
    def test_no_page_requests_a_font_from_a_third_party(self):
        for path in PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn("fonts.googleapis.com", html)
                self.assertNotIn("fonts.gstatic.com", html)

    def test_the_csp_no_longer_permits_the_google_font_origins(self):
        csp = self.client.get("/").headers["Content-Security-Policy"]
        self.assertNotIn("fonts.googleapis.com", csp)
        self.assertNotIn("fonts.gstatic.com", csp)
```

and to the browser class:

```python
    def test_a_declined_visit_makes_no_third_party_request_at_all(self):
        # after Task 24 the 'fonts.googleapis' exception in the earlier test
        # is gone: the assertion is now absolute.
        offenders = [url for url in requests if self.base_url not in url]
        self.assertEqual(offenders, [], offenders)
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Vendor the fonts**

Download the two families' latin + latin-ext woff2 from the Google Fonts API response (both
are SIL Open Font License 1.1 — copy each `OFL.txt` into `static/fonts/` beside them, which
the licence requires). Write `static/css/fonts.css` with the `@font-face` rules, then
replace the four font `<link>` tags in both templates with one:

```html
  <link rel="preload" as="font" type="font/woff2" crossorigin
    href="{{ url_for('static', filename='fonts/archivo-latin.woff2', v='fonts-1') }}">
  <link rel="stylesheet" href="{{ url_for('static', filename='css/fonts.css', v='fonts-1') }}">
```

Part I Task 10's non-blocking dance disappears with it: a same-origin stylesheet served
gzipped with a one-year cache is not a performance problem. **Update Part I's
`RenderBlockingTests` accordingly** — the first two tests there assert the `media="print"`
trick and must be replaced with "no third-party stylesheet in the head at all", which is
strictly stronger.

- [ ] **Step 4: Trim the CSP**

In `app.py:1061`, remove `https://fonts.googleapis.com` from `style-src` and
`https://fonts.gstatic.com` from `font-src`. Both directives fall back to `'self'`.

- [ ] **Step 5: Configure GA4 itself** (console work, not code — record it in
`docs/legal/subprocessors.md`): data retention **2 months**, Google Signals **off**, ads
personalisation **off**, data-sharing with Google products **off**, IP anonymisation on
(GA4 default, and set explicitly in `consent.js`).

- [ ] **Step 6: Write the sub-processor list** — `docs/legal/subprocessors.md`: who, what
they receive, where they are, on what legal basis, and how to check. Three rows today
(hosting provider, Google Analytics, YouTube-on-interaction) — and after this task, Google
Fonts leaves the list entirely.

- [ ] **Step 7: Run everything and commit**

```bash
git add static/fonts/ static/css/fonts.css templates/ app.py docs/legal/subprocessors.md tests/
git commit -m "feat(privacy): self-host fonts, tighten the CSP, document sub-processors"
```

---

## Task 25: WCAG 2.1 AA

Covers the ADA / WCAG 2.1 AA item, and it is the one on the legal list with the clearest
day-to-day benefit: the product is for students on cheap hardware, some of whom use a
screen reader or cannot use a mouse.

**Files:**
- Modify: whatever the audit turns up — expect `static/css/marketing.css` (focus styles, contrast), `templates/write.html` (labels on icon-only controls)
- Test: `tests/test_accessibility.py` (create)

**Interfaces:** consumes `axe-core` from `cdn.jsdelivr.net`, which the CSP already allows
in `script-src` — **but only inject it in the test, never in a page.**

- [ ] **Step 1: Write the failing test**

Create `tests/test_accessibility.py`, a Playwright module that, for `/`, `/features`,
`/about`, `/legal/privacy` and `/write`:

```python
    def test_axe_finds_no_violation_at_wcag_2_1_aa(self):
        page.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js")
        results = page.evaluate(
            "async () => await axe.run(document, { runOnly:"
            " { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })"
        )
        violations = [
            (item["id"], len(item["nodes"])) for item in results["violations"]
        ]
        self.assertEqual(violations, [], violations)

    def test_every_interactive_control_is_reachable_by_keyboard_alone(self):
        # Tab through; assert the set of ids reached covers every button and
        # link that a pointer can reach.

    def test_focus_is_always_visible_when_it_moves_by_keyboard(self):
        # For each tab stop, assert getComputedStyle(el).outlineStyle !== 'none'
        # or a visible box-shadow.

    def test_no_control_communicates_state_by_colour_alone(self):
        # The active nav link and the active tool must differ by more than hue.
```

- [ ] **Step 2: Run it and read the violations.** This will fail with a real list. Fix them
in this task — the common ones in a codebase like this are icon-only buttons without an
accessible name (`#themeButton` has `aria-label`; the editor's 40+ tool buttons need
checking), contrast on `--ink-2` against `--surface-2`, and the canvas needing
`role="img"` with a live description. **Any fix that changes a colour goes through
`DESIGN.md` first** — raise the token, do not patch one component.

- [ ] **Step 3: Add the statement.** WCAG 2.1 AA conformance is a claim, and a claim needs
a page: add an *Accessibility* section to `/about` stating the target, what is known not to
conform yet (AR Inky needs a camera and a hand; the canvas cannot be drawn on without a
pointer), and the contact route for problems.

- [ ] **Step 4: Commit**

```bash
git add tests/test_accessibility.py static/css/ templates/ DESIGN.md
git commit -m "feat(a11y): WCAG 2.1 AA audit, fixes and an automated axe gate"
```

---

## Task 26: PCI-DSS, SOC 2 and ISO 27001 — the honest posture

Three items on the list that **cannot be implemented as features**, with the guardrails
that keep the honest answer true.

- [ ] **Step 1: PCI-DSS — not in scope, and a test that keeps it that way**

Inkyscib takes no payments and has no payment form. The rule to write down and enforce: *if
payment is ever added, card data must never touch this server — Stripe Checkout or
Payment Element only, keeping the merchant at SAQ A.* Add to `tests/test_legal.py`:

```python
    def test_nothing_on_the_site_asks_for_a_card(self):
        for path in ("/", "/features", "/about", "/write") + LEGAL_PAGES:
            html = self.client.get(path).get_data(as_text=True)
            for marker in ('autocomplete="cc-', 'name="card', "cardnumber", "cvv"):
                with self.subTest(path=path, marker=marker):
                    self.assertNotIn(marker, html.lower())
```

- [ ] **Step 2: SOC 2 Type II / ISO 27001 — state what they are**

Both are **audited certifications**, not code: an external auditor, 3–12 months of evidence,
and recurring cost. Nothing in a commit produces one, and a free solo project with no
enterprise customers has no one to show it to. What *is* applicable now, and is the
prerequisite if that ever changes, is the evidence trail — written into
`docs/legal/security-posture.md`:

| Control the frameworks ask for | Where it already lives |
|---|---|
| Change management | Git history; `DESIGN.md`'s dated decision log; `TODOS.md` |
| Access control | Single maintainer; deploy credentials in the platform, not the repo; `SECRET_KEY` from env |
| Audit trail of consent | `consent_log.py` (Task 20), verifiable with `tools/verify_consent_log.py` |
| Secure development | `defusedxml` for untrusted PPTX XML (`app.py:29`), CSP, `MAX_CONTENT_LENGTH`, `secure_filename` |
| Vulnerability management | **Missing — add it in Step 3** |
| Incident response | **Missing — add a one-page plan: what to do, who to tell, the 72-hour GDPR / DPDP breach-notification clock** |

- [ ] **Step 3: Add the one control that is genuinely missing**

Dependency scanning, because `yt-dlp`, `PyMuPDF` and `Pillow` all parse hostile input:

```bash
pip install pip-audit
pip-audit -r requirements.txt
```

Record it in `docs/legal/security-posture.md` as a monthly task, with the note that
`PyMuPDF` and `Pillow` advisories are the ones that matter here, since both touch
attacker-supplied files.

- [ ] **Step 4: Write the incident-response page** — `docs/legal/incident-response.md`: what
counts as a breach for a product that holds almost nothing (realistically: a compromised
host serving modified JS that exfiltrates canvas data — so the CSP *is* the control), who
declares it, the 72-hour notification clock under GDPR Art. 33 and DPDP §8(6), who gets
told, and the holding statement to publish.

- [ ] **Step 5: Commit**

```bash
git add docs/legal/security-posture.md docs/legal/incident-response.md tests/test_legal.py
git commit -m "docs(security): posture, applicability and an incident plan"
```

---

## Task 27: Land Part II

- [ ] **Step 1: Run everything**

Run: `python -m pytest tests/ -q`
Expected: 319 baseline + 52 (Part I) + ~32 (Part II) ≈ **403 passed, 0 failed**. The exact
Part II count depends on how many violations Task 25 turns into fixes.

- [ ] **Step 2: Verify the chain**

Run: `python tools/verify_consent_log.py`
Expected: `chain intact`.

- [ ] **Step 3: Walk a first visit, by hand, with the network panel open**

Load `/` in a clean profile. **Before any click there must be zero requests to any origin
that is not this server.** Accept analytics: `gtag/js` appears. Reload: it appears again.
Open the footer link, reject: the `_ga` cookies are gone and `gtag/js` does not return.
This five-minute walk is the only test of the whole system end to end.

- [ ] **Step 4: Book the legal review**

Send `templates/legal/*.html`, `docs/legal/*.md` and `docs/legal/data-map.md` to a lawyer
qualified in India (DPDP) with EU/UK exposure. The drafts are written to be reviewed, not
published unread. **Do not publish `/legal/*` until that review is back** — a wrong privacy
policy is worse than a missing one, because it is a documented representation.

- [ ] **Step 5: Record what is left**

Append to `TODOS.md`: the GA4-versus-cookieless-analytics decision, the EULA trigger, the
WCAG items that do not conform, the monthly `pip-audit` and consent-log prune, and the
review date for the legal documents (one year, or on any trigger in
`docs/legal/README.md`).

---

# Appendix B: the legal checklist, mapped

| Item | Where it lands | Honest status |
|---|---|---|
| Terms & Conditions | Task 21 | Drafted, **needs counsel** |
| Privacy Policy | Task 21 | Drafted, **needs counsel** |
| Cookie & Tracking Policy | Task 21 | Drafted; itemised table |
| EULA | Task 21 | **Not applicable** — no downloadable client. Trigger recorded |
| GDPR (EU) / UK GDPR | Tasks 17, 21, 22, 23 | Right to be forgotten = one button (Task 22); access/portability = export |
| ePrivacy Directive | Tasks 17, 18 | Prior consent, nothing loads before it |
| CCPA / CPRA | Tasks 19, 21 | "Do Not Sell or Share" link + **GPC honoured**, which most sites skip |
| VCDPA / CPA / CTDPA / UCPA | Tasks 17, 19, 21 | Opt-out flows; no targeted advertising exists to opt out of |
| COPPA | Tasks 17, 21 | No accounts, no ads, no profiling; analytics off by default |
| **DPDP 2023 (India)** | Task 21 | **Added — not on the source list, and the operator is in India.** Under-18 = child |
| LGPD (Brazil) | Task 21 | Legal basis stated; controller contact named. A formal DPO is not required at this scale |
| PIPEDA (Canada) | Tasks 17, 21 | Express consent; transfer safeguards named |
| APPs (Australia) | Tasks 17, 21 | Anonymous use is the **default**, not an option — no account exists |
| PDPA (Singapore) | Task 23 | Retention windows set and automated |
| PCI-DSS | Task 26 | **Not applicable**; guarded by a test |
| SOC 2 Type II / ISO 27001 | Task 26 | **Not achievable in code.** Evidence trail + the missing controls added |
| ADA / WCAG 2.1 AA | Task 25 | Automated axe gate + keyboard + contrast |
| Dynamic data anonymisation | Task 23 | `RedactPII` runs before any handler |
| Geographic consent routing | Task 19 | **Deliberately inverted**: strict for everyone, region changes wording only |
| Immutable consent audit trail | Task 20 | Hash-chained, **non-identifying** — no per-visitor database row |

## The two things worth arguing about before building

1. **GA4 is the whole compliance surface.** Drop it for a cookieless counter and Tasks 18,
   19 and 20 shrink to a footer link. Decide before Task 17.
2. **Publishing a privacy policy is a representation.** Today, Inkyscib collects almost
   nothing and says nothing; that is a small risk. A policy that describes controls which
   are not actually in place is a much larger one. Ship Tasks 17–24 *before* the documents
   in Task 21 go live, so every sentence in them is already true when it is published.

---

# Implementation log — 2026-09-20

The plan was executed the same day it was written. What follows is what actually happened,
including where the plan was wrong.

## Where the plan was wrong

1. **`RenderBlockingTests` was unrunnable as written** (Task 10 Step 1). Its filter
   collected every `<link>` matching `fonts.googleapis.com/css2` without `preload` — which
   includes the `<noscript>` fallback, whose whole job is to block. The test now strips
   `<noscript>` blocks before scanning. Nothing about the implementation changed.
2. **`test_the_app_never_writes_an_uploaded_file_outside_a_temp_directory`** (Task 23) used
   `assertNotIn(".save(", source)`, which fails on `image.save(buffer)` and
   `document.save(output)` — Pillow and PyMuPDF writing to memory. It now matches
   `upload.save(NAME)` specifically and follows `NAME` transitively back to `temp_dir`
   (the PPT path goes `temp_dir` → `temp_path` → `source_path`, two hops).
3. **`test_every_page_offers_a_way_back_to_the_choice`** (Task 18) called
   `InkyscibConsent.set()` directly and then clicked the footer link — but `set()` does not
   close the banner, so the open banner intercepted the click. It now clicks *Reject* the
   way a visitor would. This is the same failure mode as the first-run tour eating canvas
   clicks, one layer up.
4. **The homepage has no footer**, by design — `home.html` overrides `{% block footer %}`
   to nothing because the hero is meant to be exactly one screen. The plan put the legal
   links inside that block, which silently removed them from the one page CPRA names. The
   links now render in a `.legal-strip` **outside** the footer block, and `.hero`'s
   `min-height` dropped from `calc(100vh - 190px)` to `calc(100vh - 232px)` to pay for it.
5. **`site_url` did not re-strip a trailing slash** from a patched `SITE_ORIGIN`. Real
   bug, not a test artefact: it would have produced `https://site.com//features`.
6. **Task 8's 404 CSS was written against tokens that page never loads.** `404.html` links
   only `not-found.css`, so `var(--s4)` and `var(--ink-2)` were undefined there; the rules
   now carry fallbacks and are scoped past `.lost-copy p`'s higher specificity.
7. **Task 9's hero `aria-label` was for a drawing that does not exist.** The `.geometry`
   SVG already had `role="img"` and an accurate label; the plan's replacement text
   described two crossing arcs, and the artwork is a triangle inscribed in a circle. The
   existing label was kept.

## What could not be done here, and why

- **Self-hosted fonts (Task 24).** This machine has no outbound TLS from Python, so the
  woff2 files could not be fetched. `tools/vendor_fonts.py` does the whole job and prints
  the three follow-up edits; `fonts.googleapis.com` is still in `style-src` and still
  receives every visitor's IP. **This is the one flow that still runs without consent** —
  see `docs/legal/data-map.md`. The two tests that will pin it are deliberately not
  written yet.
- **Nothing else.** The share image generated (`static/img/og-cover.png`, 1200×630, 27 KB,
  a real screenshot of the live homepage), and axe-core ran against every page.

## What the accessibility pass actually found

Task 25 was the one task whose outcome could not be predicted from reading the code. axe-core
reported **18 violations across 4 of 5 pages**, and all but three were a single cause:
`--ink-3` (3.51:1) printing 12–13px informational text. `DESIGN.md` already said `--ink-3`
was "non-load-bearing only", so the rule did not change — ten usages did. The remaining
three were `--accent` used as *text* on `--accent-wash` (4.47:1, now the new `--accent-ink`
token at 4.79:1), two off-token literals in `.geometry-control-hint`, and
`--ribbon-ink-dim` at 4.31:1. Plus two `.table-scroll` boxes that scrolled without being
keyboard-focusable.

**All five pages now report zero violations at wcag2a / wcag2aa / wcag21a / wcag21aa**,
including `/write`. Both decisions are in `DESIGN.md`'s log.

## One thing the plan did not anticipate

The consent banner opens over every page on a first visit, which meant it intercepted
clicks in **28 existing browser test files** exactly as the first-run tour once did. Each
one's `add_init_script` now pre-answers consent alongside the tour key. The four new
consent/accessibility modules are deliberately excluded — proving the banner appears is
their job.

`tests/test_analytics_csp.py` also had to change, and it was green before this work: it
asserted the gtag loader appears once **in the served HTML**, which is exactly what the
consent gate makes false. It now asserts the loader appears once in `consent.js`, that the
measurement id appears nowhere in any document, and — in the browser test — grants consent
before probing whether the production CSP lets GA4 reach its collect origin.

## Two things checked and found fine

- **`content-visibility: auto` and anchor links.** `/features#geometry`, `#material`,
  `#focus` and `/about#accessibility` all point inside sections that are now skipped until
  scrolled. In the Claude browser pane the jump paints a blank frame — but that pane fires
  no rAF, and in real headless Chromium all four anchors land with the heading at y=64 and
  a fully painted page (2,000+ distinct colours in the screenshot). No change made.
- **The homepage is still exactly one screen.** Measured at 1440x1024 after the legal
  strip was added: zero vertical and zero horizontal overflow. The strip is 52px, and
  `.hero`'s reservation was cut by the same amount. Below ~900px of viewport height the
  hero's own content (756px with padding) exceeds the reservation and the page scrolls —
  which was already true before the strip existed.

## A wrong claim that nearly shipped

`static/js/privacy-controls.js` listed four IndexedDB databases as a Firefox fallback —
`inkyscib-notebooks`, `inkyscib-library`, `inkyscib-frames`, `inkyscib-media`. All four
were invented. The app creates **one** database, `inkyscib_cache` at version 2, with the
`records` and `documents` object stores (`static/js/storage.js:9`). The guess had already
propagated into the privacy policy, the cookie policy and the data map before a live
`inventory()` call in the browser returned the real name. Corrected in all five places.

This is the exact failure the plan warned about in Task 21: a policy is a representation,
and "almost right" about where someone's data lives is a false statement about their data.
Anything a legal page asserts should be read out of the code, then confirmed against a
running page.

## Still open

- Run `tools/vendor_fonts.py` on a networked machine.
- Decide GA4 versus a cookieless counter (the plan's Part II opening section). Taking that
  decision deletes most of Tasks 18–20.
- **Do not publish `/legal/*` until a lawyer has read it.** The three pages carry a visible
  draft notice for exactly this reason.
- `debug.log` (3.0 MB) is still in the project root. It is untracked and `*.log` is
  gitignored, so nothing leaked; it was left in place rather than deleted without asking.
