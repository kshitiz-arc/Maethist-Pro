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
