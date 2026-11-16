# Data map

> **Version 2 (2026-11-15) removed Google Analytics, the consent banner, `/api/consent`,
> `consent_log.py` and the two consent-log tools.** Every row, step or command below that
> mentions analytics, consent or the consent chain is historical and no longer describes
> running code. There is nothing to prune or verify. The only third party a visitor can
> reach is YouTube, and only by opening a lecture. `tests/test_analytics_csp.py` keeps it so.

Written 2026-09-20. Every row was read out of the code, not out of an intention. File and
line references are the evidence; if a row and the code disagree, the code is right and
this file is stale.

## The short version

MAETHIST has no accounts and no server-side store of anyone's work. Three of the five rows
below are "held for the length of one request, then gone", and the two that persist hold
nothing that points at a person.

## Flows

| # | Data | Where it goes | Stored where | Who else sees it | Legal basis | Retention |
|---|---|---|---|---|---|---|
| 1 | Notes, drawings, pages, notebooks, saved video moments, preferences | Never leaves the device | The visitor's `localStorage` and IndexedDB (`inkyscib_cache` v2: the `records` and `documents` object stores) | Nobody. There is no endpoint that could receive it | Not our processing — we are not a controller of data we never receive | Until the visitor clears it, or presses *Erase everything* on `/legal/privacy` |
| 2 | An imported PDF or PowerPoint | `POST /api/ppt/import`, `/api/pdf/import`, `/api/pdf/export`, `/api/ppt/export/*` | A `tempfile.TemporaryDirectory` (`app.py:2274`, `:2333`, `:2732`), deleted when the request ends, including on failure | Nobody | Art. 6(1)(b) — performing the conversion the visitor asked for | Seconds. Pinned by `tests/test_privacy_server.py::UploadLifetimeTests` |
| 3 | Lecture search words | `GET /api/youtube/search` → YouTube, server-to-server | Process memory, a ten-minute cache keyed by the query | Google, as the search terms only — **not** the visitor's IP, because the server asks on their behalf | Art. 6(1)(b) | 10 minutes, in memory |
| 4 | Web-server access logs | stderr / the platform's log sink | Wherever the host keeps logs | The hosting provider | Art. 6(1)(f) — keeping the service up | 30 days (host setting). **IP, email and filenames are rewritten before the record reaches any handler** (`logging_filters.py`) |
| 5 | A consent record | `POST /api/consent` | `data/consent-log.jsonl`, hash-chained, append-only (`consent_log.py`) | Nobody | Art. 7(1) — being able to demonstrate consent | 24 months (`tools/prune_consent_log.py`) |

## Third parties on the page

| Who | What reaches them | When | Gate |
|---|---|---|---|
| Google (Analytics) | Client-id cookie, page URL, IP | Only after *Accept analytics* | `static/js/consent.js`. Consent Mode defaults to denied; nothing loads before an answer |
| Google (YouTube) | Cookies, IP, which video | Only when a lecture is opened, via `youtube-nocookie.com` | User interaction |
| The hosting provider | Everything in row 4 | Every request | Contract / Art. 28 |

### The Google Fonts row is closed (2026-09-21)

`fonts.googleapis.com` used to be requested on every page load, which sent the visitor's
IP to Google before they had agreed to anything — the transfer *LG München I, 3 O
17493/20* found unlawful in the EU. `tools/vendor_fonts.py` has now been run: both
families are served from `static/fonts/`, `static/css/fonts.css` carries the
`@font-face` rules with every `unicode-range` preserved, and `static/fonts/OFL.txt`
carries both licences. The two origins are gone from `style-src` and `font-src`, so the
CSP now refuses the request even if a `<link>` comes back.

**A visit that declines analytics and opens no lecture now makes no third-party request
at all.** That is asserted, not assumed, by
`tests/test_consent.py::test_a_first_visit_makes_no_request_to_any_google_origin`, which
watches real browser traffic and no longer carries a fonts exception.

## What is read and deliberately not kept

- `CF-IPCountry`, if a Cloudflare-style edge sets it. It picks banner wording and is never
  logged, stored or forwarded (`app.py`, `visitor_region()`; pinned by
  `tests/test_legal.py::RegionHintTests`). No IP geolocation is performed — that would be
  a new processing activity undertaken to decide how much privacy to give.
- `navigator.globalPrivacyControl`. It is honoured as an opt-out and never recorded as an
  identifier.

## Roles

MAETHIST is the **controller** for rows 3, 4 and 5. For row 1 it is not a controller at
all: the data never reaches it. For row 2 it is a controller for the seconds the file
exists. Google and the hosting provider are **processors/third parties** as set out above.
