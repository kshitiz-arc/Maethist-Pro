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
