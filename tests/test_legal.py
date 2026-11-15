"""The legal surface: the three published documents, and the
guardrail that keeps PCI-DSS out of scope.

Test-client only. What a regulator would check on these pages is mostly "does
it say the thing, and is it reachable", which is exactly what a rendered-HTML
assertion is good at. The behaviour behind them -- no analytics, and erasure --
is pinned in tests/test_analytics_csp.py and tests/test_privacy_controls.py.
"""

import unittest
from unittest import mock

import app as app_module
from app import app

LEGAL_PAGES = ("/legal/privacy", "/legal/cookies", "/legal/terms")
SITE_PAGES = ("/", "/features", "/about", "/write")


class NoRegionHintTests(unittest.TestCase):
    """The country header used to pick the wording of the consent banner. With
    no banner there is nothing to pick, so the header is not read at all."""

    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_a_country_header_changes_nothing_on_the_page(self):
        plain = self.client.get("/").get_data(as_text=True)
        for value in ("DE", "<script>", "USA"):
            with self.subTest(value=value):
                html = self.client.get("/", headers={"CF-IPCountry": value}).get_data(as_text=True)
                self.assertEqual(html, plain)
                self.assertNotIn("data-region", html)

    def test_the_country_header_is_never_written_to_a_log(self):
        with mock.patch.object(app_module.logger, "info") as info:
            self.client.get("/", headers={"CF-IPCountry": "DE"})
        for call in info.call_args_list:
            self.assertNotIn("DE", str(call))


class LegalPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()
        cls.html = {
            path: cls.client.get(path).get_data(as_text=True) for path in LEGAL_PAGES
        }

    def test_each_legal_page_is_served_and_dated(self):
        for path in LEGAL_PAGES:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 200)
                self.assertIn("Last updated", self.html[path])

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
        for processor in ("The hosting provider", "YouTube"):
            with self.subTest(processor=processor):
                self.assertIn(processor, html)

    def test_the_policy_covers_each_regime_the_product_is_exposed_to(self):
        html = self.html["/legal/privacy"]
        for regime in (
            "GDPR",
            "UK GDPR",
            "Digital Personal Data Protection Act",
            "CCPA",
            "CPRA",
            "LGPD",
            "PIPEDA",
            "Privacy Act 1988",
            "PDPA",
            "COPPA",
        ):
            with self.subTest(regime=regime):
                self.assertIn(regime, html)

    def test_the_privacy_policy_carries_the_controls_that_exercise_the_rights(self):
        """Art. 15/20 and Art. 17 are two buttons here, not a support queue,
        because the data is in the visitor's own browser."""
        html = self.html["/legal/privacy"]
        for control in ('id="exportEverything"', 'id="eraseEverything"'):
            with self.subTest(control=control):
                self.assertIn(control, html)
        self.assertIn("js/privacy-controls.js", html)

    def test_the_cookie_policy_itemises_every_cookie_by_category(self):
        html = self.html["/legal/cookies"]
        for column in ("Name", "Purpose", "Category", "Expiry"):
            with self.subTest(column=column):
                self.assertIn(column, html)
        for category in ("Essential", "functional"):
            with self.subTest(category=category):
                self.assertIn(category, html)
        # Nothing here is a marketing cookie; the policy has to say so rather
        # than print an empty category.
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
        for path in SITE_PAGES:
            with self.subTest(path=path):
                html = self.client.get(path).get_data(as_text=True)
                for legal in LEGAL_PAGES:
                    self.assertIn(f'href="{legal}"', html)

    def test_the_legal_pages_are_in_the_sitemap(self):
        listed = {path for path, _, _ in app_module.SITEMAP_ROUTES}
        for path in LEGAL_PAGES:
            with self.subTest(path=path):
                self.assertIn(path, listed)


class PaymentsOutOfScopeTests(unittest.TestCase):
    """PCI-DSS applies to anyone who touches card data. Inkyscib does not, and
    this is the test that keeps that answer true: if payment is ever added,
    card data must reach Stripe Checkout or the Payment Element directly and
    never this server, which keeps the merchant at SAQ A."""

    @classmethod
    def setUpClass(cls):
        cls.client = app.test_client()

    def test_nothing_on_the_site_asks_for_a_card(self):
        for path in SITE_PAGES + LEGAL_PAGES:
            html = self.client.get(path).get_data(as_text=True).lower()
            for marker in ('autocomplete="cc-', 'name="card', "cardnumber", "cvv"):
                with self.subTest(path=path, marker=marker):
                    self.assertNotIn(marker, html)


if __name__ == "__main__":
    unittest.main()
