# Sub-processors and third parties

> **Version 2 (2026-11-15) removed Google Analytics, the consent banner, `/api/consent`,
> `consent_log.py` and the two consent-log tools.** Every row, step or command below that
> mentions analytics, consent or the consent chain is historical and no longer describes
> running code. There is nothing to prune or verify. The only third party a visitor can
> reach is YouTube, and only by opening a lecture. `tests/test_analytics_csp.py` keeps it so.

Written 2026-09-20. Review with `docs/legal/README.md`, or whenever a script, font, embed
or CDN is added.

A short list, because the product holds almost nothing. Every entry here is also named in
`templates/legal/privacy.html` — a sub-processor a visitor cannot see named is one they
cannot object to.

| Who | What they receive | Where | Why | Legal mechanism | Gated by consent |
|---|---|---|---|---|---|
| **Hosting provider** *(fill in when chosen)* | Everything in a request: IP at the edge, request line, status | *(region)* | Serving the site | Art. 28 processor terms, DPA | No — strictly necessary |
| **Google Ireland Ltd / Google LLC — Analytics 4** (`G-5SW3NRK6X6`) | Client-id cookie, page URL, referrer, truncated IP | EU + US | Counting visits | Google Ads Data Processing Terms; EU–US Data Privacy Framework and SCCs for the transfer | **Yes.** Nothing loads before *Accept analytics* |
| **Google — YouTube** (`youtube-nocookie.com`, `www.youtube.com/iframe_api`) | IP, cookies, which video | Global | Playing a lecture the visitor opened | YouTube API Services Terms | By interaction: nothing loads until a lecture is opened |

## Google Fonts was removed from this list on 2026-09-21

`tools/vendor_fonts.py` was run. Both families are served from `static/fonts/` (9 woff2
subsets, 143 KB total, of which a latin-only visitor fetches about 66 KB), the generated
`static/css/fonts.css` preserves every `unicode-range` the API sent, and
`static/fonts/OFL.txt` carries both families' licences verbatim as the SIL OFL requires.
`fonts.googleapis.com` is gone from `style-src` and `fonts.gstatic.com` from `font-src`;
both fall back to `'self'`.

The row is deleted rather than reworded, and the two assertions held back for it now
exist:

```python
tests/test_seo.py::RenderBlockingTests::test_no_page_requests_a_font_from_a_third_party
tests/test_analytics_csp.py::AnalyticsCspTests::test_the_csp_no_longer_permits_the_google_font_origins
```

Two more went in alongside them, because a self-hosted font fails *silently* — a 404 just
falls back to the system face, and nobody notices for months:
`test_the_self_hosted_font_files_actually_resolve` and
`test_every_face_the_stylesheet_names_is_on_disk` (which also checks `OFL.txt` ships).

Two bugs in the tool surfaced when it was finally run, and both are fixed: `_BLOCK_RE` was
used but never defined, so it raised `NameError` on the first real invocation — it had
never been run; and its `fetch()` used urllib's default TLS, which fails on any machine
running antivirus HTTPS interception. It now falls back to `curl`, which verifies the
chain with its own CA bundle rather than switching verification off.

## Analytics configuration

These are console settings, not code, and nothing in the repository can enforce them.
Check them when you verify the property in `docs/seo/search-console.md`:

- Data retention: **2 months** (the minimum GA4 offers).
- Google Signals: **off**.
- Ads personalisation and data-sharing with other Google products: **off**.
- IP anonymisation: on by default in GA4, and set explicitly in `static/js/consent.js`
  (`anonymize_ip: true`).

## The alternative worth taking

Replacing GA4 with a cookieless, self-hosted counter (Plausible CE, Umami, or a small
Flask endpoint writing aggregate rows) removes this entire table's second row, the consent
requirement for analytics, the US transfer question, and the child-tracking question under
DPDP §9 and COPPA. For a free project whose analytics need is "did anyone open the canvas
this week", it is the better trade. See the plan's Part II opening section.
