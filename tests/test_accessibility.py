"""WCAG 2.1 AA, checked by axe-core in a real browser.

axe-core is loaded from cdn.jsdelivr.net, which CONTENT_SECURITY_POLICY already
allows in script-src -- but only ever inside this test, never from a page. A
machine with no outbound network cannot run this check at all, so a failed
injection *skips* rather than fails: a red test here would say "this page has
accessibility violations", which is not what an offline CI box has learned.
"""

import pathlib
import re
import threading
import unittest

from app import app
from browser_server import make_browser_server

try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover
    PLAYWRIGHT_AVAILABLE = False

AXE_URL = "https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js"

# /no-such-page renders 404.html. It was left out of this list until
# 2026-09-21, and it was the page with the accessibility defect: its CTA label
# was #FFFFFF on a #6868FF gradient, 4.19 : 1, an AA failure. A page reached by
# accident is still a page.
AUDITED_PAGES = (
    "/", "/features", "/about", "/write",
    "/legal/privacy", "/legal/cookies", "/legal/terms",
    "/no-such-page",
)

AXE_RUN = """
async () => await axe.run(document, { runOnly:
  { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class AxeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

        # Probe the CDN once. Without it every page would wait out its own
        # network timeout before skipping.
        reachable, reason = cls._probe_axe()
        if not reachable:
            cls._shut_down()
            raise unittest.SkipTest(f"axe-core is not reachable: {reason}")

    @classmethod
    def _probe_axe(cls):
        page = cls.browser.new_page()
        try:
            page.goto(f"{cls.base_url}/", wait_until="domcontentloaded")
            page.add_script_tag(url=AXE_URL)
            if not page.evaluate("() => typeof window.axe !== 'undefined'"):
                return False, "the script loaded but defined no axe global"
            return True, ""
        except Exception as error:  # offline, DNS failure, blocked by a proxy
            return False, str(error).splitlines()[0]
        finally:
            page.close()

    @classmethod
    def _shut_down(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.thread.join(timeout=3)

    @classmethod
    def tearDownClass(cls):
        cls._shut_down()

    def _page(self, path):
        page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        page.goto(f"{self.base_url}{path}", wait_until="load")
        return page

    def test_axe_finds_no_violation_at_wcag_2_1_aa(self):
        for path in AUDITED_PAGES:
            with self.subTest(path=path):
                page = self._page(path)
                try:
                    try:
                        page.add_script_tag(url=AXE_URL)
                    except Exception as error:  # pragma: no cover - offline box
                        raise unittest.SkipTest(
                            f"axe-core did not load on {path}: {error}"
                        )
                    results = page.evaluate(AXE_RUN)
                finally:
                    page.close()

                violations = [
                    (item["id"], len(item["nodes"])) for item in results["violations"]
                ]
                self.assertEqual(violations, [], violations)


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class TabletFooterTests(unittest.TestCase):
    """The editor footer at the size of the device this product is for.

    Two defects lived here and axe found neither, because axe cannot resolve a
    colour through a composited layer over a canvas, and an overflow that is
    off-screen rather than in flow produces no scrollbar to notice:

      * <footer> was width:100% + 20px padding in content-box, so it measured
        1000px in a 960px viewport and the last 20px of "Do Not Sell or Share
        My Personal Information" sat past the right edge.
      * opacity:0.4 on <footer> dimmed .editor-legal along with the decorative
        credit, rendering --ink-2 (7.70 : 1) at 2.24 : 1.

    960x600 on purpose: CLAUDE.md names a ~960px budget Android tablet as the
    target, and both faults were invisible at desktop width.
    """

    VIEWPORT = {"width": 960, "height": 600}

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
        cls.thread.join(timeout=3)

    def _page(self):
        page = self.browser.new_page(viewport=self.VIEWPORT)
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed');"
            "localStorage.setItem('inkyscib-consent-v1',"
            " JSON.stringify({version: 1, analytics: false}))"
        )
        page.goto(f"{self.base_url}/write", wait_until="load")
        return page

    def test_nothing_in_the_footer_runs_off_the_right_edge(self):
        page = self._page()
        try:
            report = page.evaluate(
                """() => {
                    const footer = document.querySelector('footer');
                    const over = [...footer.querySelectorAll('a')]
                      .filter(a => a.getBoundingClientRect().right > innerWidth + 1)
                      .map(a => a.textContent.trim());
                    return {
                      footerWidth: Math.round(footer.getBoundingClientRect().width),
                      viewport: innerWidth,
                      clipped: over,
                    };
                }"""
            )
        finally:
            page.close()

        self.assertEqual(report["clipped"], [], report)
        self.assertLessEqual(report["footerWidth"], report["viewport"])

    def test_the_legal_row_keeps_its_contrast_while_the_credit_stays_quiet(self):
        """The credit may be decoration. The privacy links may not."""
        page = self._page()
        try:
            measured = page.evaluate(
                """() => {
                    const luminance = (c) => {
                      const s = c.map(v => { v /= 255;
                        return v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
                      return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2];
                    };
                    const parse = (s) => s.match(/[\\d.]+/g).slice(0,3).map(Number);
                    const hex = (h) => [0,2,4].map(i => parseInt(h.replace('#','').slice(i,i+2),16));

                    const paper = hex(getComputedStyle(document.documentElement)
                      .getPropertyValue('--paper').trim() || '#141413');
                    const legal = document.querySelector('.editor-legal');
                    const link = legal.querySelector('a');

                    // Opacity does not inherit, it composites: the element's
                    // own computed opacity stays 1 while an ancestor at 0.4
                    // halves what reaches the screen. Reading only the
                    // element's own value is what let this ship, and it let
                    // the first draft of this test pass against the bug.
                    let alpha = 1;
                    for (let n = link; n && n !== document.documentElement; n = n.parentElement) {
                      alpha *= parseFloat(getComputedStyle(n).opacity);
                    }
                    const fg = parse(getComputedStyle(link).color);
                    // Composite the declared colour over the canvas at whatever
                    // opacity actually survives the ancestor chain.
                    const eff = fg.map((c, i) => c*alpha + paper[i]*(1-alpha));
                    const [a, b] = [luminance(eff), luminance(paper)];
                    return {
                      contrast: (Math.max(a,b)+0.05) / (Math.min(a,b)+0.05),
                      creditOpacity: parseFloat(
                        getComputedStyle(document.querySelector('footer .left')).opacity),
                      effectiveAlpha: alpha,
                    };
                }"""
            )
        finally:
            page.close()

        self.assertGreaterEqual(
            measured["contrast"], 4.5,
            f"the editor's privacy links render at {measured['contrast']:.2f} : 1",
        )
        # Since v2 the credit names its author and links to them, so it is
        # no longer faint: it has to be as readable as the legal row.
        self.assertEqual(measured["creditOpacity"], 1.0)


class TokenVocabularyTests(unittest.TestCase):
    """The rule DESIGN.md states, enforced. No network, so it always runs.

    axe cannot catch either of these. A custom property that resolves to
    nothing is not an accessibility violation to axe -- it is just a colour
    that never applied -- and axe needs a CDN this suite may not be able to
    reach. Both faults below shipped on 404.html and were invisible until
    someone read the computed styles in a browser.
    """

    CSS_DIR = pathlib.Path(__file__).resolve().parents[1] / "static" / "css"

    def test_no_stylesheet_declares_a_self_referential_custom_property(self):
        """`--accent: var(--accent)` computes to the guaranteed-invalid value.

        Everything reading it silently falls back, so the symptom is a control
        with no colour rather than an error anywhere. not-found.css shipped
        exactly this and the primary CTA lost its background.
        """
        pattern = re.compile(r"^[^\S\n]*(--[\w-]+)\s*:\s*var\(\s*\1\s*[,)]", re.M)
        # Comments are stripped first. The note in not-found.css explaining
        # this very bug quotes the broken line, and a checker that reads a
        # comment as a declaration reports the explanation as the defect.
        comments = re.compile(r"/\*.*?\*/", re.S)
        for path in sorted(self.CSS_DIR.glob("*.css")):
            with self.subTest(stylesheet=path.name):
                source = comments.sub("", path.read_text(encoding="utf-8"))
                hits = pattern.findall(source)
                self.assertEqual(hits, [], f"{path.name} declares {hits} as itself")

    def test_every_page_loads_the_token_vocabulary_before_its_own_styles(self):
        """tokens.css says "Load this FIRST ... on every page", and a page that
        skips it renders every --r-*, --s*, --ink-* and --accent as nothing."""
        client = app.test_client()
        pages = {
            "/": 200, "/features": 200, "/about": 200, "/write": 200,
            "/legal/privacy": 200, "/legal/cookies": 200, "/legal/terms": 200,
            "/no-such-page": 404,
        }
        for path, status in pages.items():
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, status)
                html = response.get_data(as_text=True)
                sheets = re.findall(r'<link[^>]+href="([^"]*\.css[^"]*)"', html)
                names = [href.split("/")[-1].split("?")[0] for href in sheets]
                self.assertIn("tokens.css", names, f"{path} loads {names}")
                # Order matters: a later :root can only override what an
                # earlier one defined, never supply what it never loaded.
                self.assertLess(
                    names.index("tokens.css"),
                    min(
                        (names.index(n) for n in names
                         if n not in {"tokens.css", "fonts.css"}),
                        default=len(names),
                    ),
                    f"{path} loads a stylesheet before tokens.css: {names}",
                )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
