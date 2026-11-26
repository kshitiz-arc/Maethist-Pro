"""Crawler-facing invariants for the public pages.

Test-client only, so the whole module runs in well under a second. Anything
that needs a real browser lives in tests/test_seo_browser.py.
"""

import datetime
import json
import re
import unittest
from pathlib import Path
from unittest import mock
from xml.etree import ElementTree as ET

from PIL import Image

import app as app_module
from app import app

# The three legal pages shipped in the same change as the SEO work, so every
# invariant here -- canonical, title, description, heading ladder, social card
# -- is enforced on them too.
INDEXABLE_PAGES = (
    "/",
    "/features",
    "/about",
    "/write",
    "/legal/privacy",
    "/legal/cookies",
    "/legal/terms",
)


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
            "/healthz",   # the host's health check, JSON
            "/sw.js",     # the offline service worker, a script
            "/stats",     # the owner's visit counter, behind a password
            "/live",      # the live board join page: private boards, noindex, Disallowed
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
                self.assertIn("MAETHIST", titles[0])

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
                    # A picture is role="img"; an illustration you can operate
                    # (the homepage demo, whose points are focusable) cannot be,
                    # because img hides its children, so it is a named group.
                    named = ('role="img"' in tag or 'role="group"' in tag) and "aria-label" in tag
                    decorative = 'aria-hidden="true"' in tag
                    self.assertTrue(named or decorative, tag)

    def test_no_committed_image_blows_the_page_weight_budget(self):
        static_dir = Path(app.root_path) / "static"
        for suffix in ("*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"):
            for image in static_dir.rglob(suffix):
                with self.subTest(image=image.name):
                    self.assertLess(image.stat().st_size, IMAGE_BUDGET_BYTES)


class RenderBlockingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_no_page_requests_a_font_from_a_third_party(self):
        """The fonts are self-hosted, so this is the whole property.

        These two families used to come from fonts.googleapis.com, which sent
        every visitor's IP to Google on every page load with no consent and no
        way to refuse. The old tests here asserted the *workaround* for that --
        media="print" plus an onload promotion, so the third-party stylesheet
        at least did not block first paint. Self-hosting removed the request,
        so the workaround is gone and this asserts the goal instead: nothing
        reaches a font origin, on any page, ever. Re-adding a Google Fonts
        <link> fails here, and would also be refused by the CSP.
        """
        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertNotIn("fonts.googleapis.com", html)
                self.assertNotIn("fonts.gstatic.com", html)

    def test_the_font_stylesheet_is_same_origin_and_the_latin_face_preloaded(self):
        for path in INDEXABLE_PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                self.assertIn("css/fonts.css", html)
                # Without the preload the latin face is discovered only after
                # fonts.css parses, which is one round trip of fallback text.
                self.assertIn('rel="preload" as="font" type="font/woff2"', html)

    def test_the_self_hosted_font_files_actually_resolve(self):
        """A font <link> that 404s degrades silently to the fallback face."""
        html = self.client.get("/").get_data(as_text=True)
        urls = re.findall(r'href="([^"]*(?:css/fonts\.css|\.woff2)[^"]*)"', html)
        self.assertTrue(urls, "no font stylesheet or face referenced")
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_every_face_the_stylesheet_names_is_on_disk(self):
        css = self.client.get("/static/css/fonts.css").get_data(as_text=True)
        names = re.findall(r"url\('\.\./fonts/([^']+)'\)", css)
        self.assertTrue(names, "fonts.css names no font files")
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(
                    self.client.get(f"/static/fonts/{name}").status_code, 200
                )
        # The OFL requires the licence to travel with the files it covers.
        self.assertEqual(self.client.get("/static/fonts/OFL.txt").status_code, 200)

    def test_analytics_never_blocks_the_parser(self):
        html = self.client.get("/").get_data(as_text=True)
        for tag in re.findall(r"<script\b[^>]*googletagmanager[^>]*>", html):
            with self.subTest(tag=tag):
                self.assertTrue("async" in tag or "defer" in tag)


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


class LlmsTxtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_llms_txt_is_markdown_with_a_title_and_a_summary(self):
        response = self.client.get("/llms.txt", base_url="https://inkyscib.test")
        body = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.mimetype.startswith("text/markdown"))
        self.assertTrue(body.startswith("# MAETHIST"))
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


if __name__ == "__main__":
    unittest.main()
