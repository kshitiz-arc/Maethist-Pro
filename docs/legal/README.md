# The legal documents: when they stop being true

Written 2026-09-20.

`templates/legal/privacy.html`, `cookies.html` and `terms.html` describe the code as it
runs today. Every sentence in them is verifiable in this repository, which is the only
reason they are safe to publish — a privacy policy is a representation, and one that
describes controls you do not have is worse than no policy at all.

**These are drafts. They have not been read by a lawyer.** Do not publish `/legal/*`
until they have. See `docs/superpowers/plans/2026-09-20-discoverability-and-compliance.md`,
Task 27 Step 4.

## What forces a re-read

Each row is a change that makes one of the documents wrong the moment it ships.

| If you add or change | What breaks | File to change |
|---|---|---|
| Any account, login, email field or password | "There is no account, no email field and no password anywhere on this site" becomes false, and the whole lawful-basis section changes | `legal/privacy.html`, `legal/terms.html` |
| A packaged desktop or mobile client | A real EULA becomes required; "the PWA is a shortcut to this site, not a licensed binary" stops covering it | new `legal/eula.html`, `legal/terms.html` |
| Payments of any kind | PCI-DSS enters scope. Card data must reach Stripe Checkout or the Payment Element directly and never this server (SAQ A) | `legal/terms.html`, `docs/legal/security-posture.md`, `tests/test_legal.py::PaymentsOutOfScopeTests` |
| Any new third-party script, font, embed or CDN | The sub-processor list and the cookie table are incomplete, and `CONTENT_SECURITY_POLICY` needs the origin | `legal/privacy.html`, `legal/cookies.html`, `docs/legal/subprocessors.md`, `app.py` |
| Any feature that uploads a visitor's work, or stores it server-side | "no server-side copy of your work" becomes false; retention and erasure both change shape | `legal/privacy.html`, `docs/legal/data-retention.md` |
| Moving hosting to another country | The transfer section and the sub-processor list both name a region | `legal/privacy.html`, `docs/legal/subprocessors.md` |
| Adding any analytics, counter or tracker | v2 removed Google Analytics and the consent banner with it. The policy now says "There is no analytics on this site"; anything that measures visits makes that false, and a tracker that sets a cookie or sends an IP abroad needs the consent gate rebuilt first | `legal/privacy.html`, `legal/cookies.html`, `tests/test_analytics_csp.py` |
| Adding a cookie or a storage key | The itemised cookie table is incomplete, which is the specific thing the ePrivacy guidance asks for | `legal/cookies.html` |

## Routine review

Once a year from the date above, or on any row firing, whichever is sooner. Bump
`LEGAL_UPDATED` in `app.py` when the text changes — the date is printed on each page and a
stale one is its own small misrepresentation.

## Where the machinery lives

| Thing | File |
|---|---|
| "No analytics" guard | `tests/test_analytics_csp.py` (fails if a tag, id or origin returns) |
| Export / erase controls | `static/js/privacy-controls.js`, rendered on `/legal/privacy` |
| Offline shell (Cache Storage, listed in the cookie table) | `templates/sw.js`, `static/js/sw-register.js` |
| Log redaction | `logging_filters.py` |
| Tests that pin all of it | `tests/test_legal.py`, `tests/test_analytics_csp.py`, `tests/test_privacy_server.py`, `tests/test_privacy_controls.py` |
