# Security posture: SOC 2, ISO 27001 and PCI-DSS

> **Version 2 (2026-11-15) removed Google Analytics, the consent banner, `/api/consent`,
> `consent_log.py` and the two consent-log tools.** Every row, step or command below that
> mentions analytics, consent or the consent chain is historical and no longer describes
> running code. There is nothing to prune or verify. The only third party a visitor can
> reach is YouTube, and only by opening a lecture. `tests/test_analytics_csp.py` keeps it so.

Written 2026-09-20.

## The honest answer first

**SOC 2 Type II and ISO 27001 are audited certifications, not code.** They need an external
auditor, three to twelve months of collected evidence, and recurring fees. No commit
produces one. A free, solo, MIT-licensed project with no enterprise customers has nobody to
show a report to, so pursuing either now would be spending money to answer a question
nobody has asked.

**PCI-DSS is out of scope**, because Inkyscib takes no payments and has no payment form.

What *is* worth doing now is the part both frameworks actually care about and that also
just makes the project safer: knowing what the controls are, and closing the ones that are
missing. That is the rest of this file.

## Controls that already exist

| What the frameworks ask for | Where it lives here |
|---|---|
| Change management | Git history; the dated decision log in `DESIGN.md`; `TODOS.md` |
| Access control | Single maintainer. Deploy credentials live in the platform, not the repo. `SECRET_KEY` comes from the environment |
| Secrets not in source | `.gitignore` covers `.env*`, `*.pem`, `*.key`, `credentials.json`; `data/consent-log.jsonl` was added 2026-09-20 |
| Audit trail of consent | `consent_log.py`, hash-chained; verify with `tools/verify_consent_log.py` |
| Data minimisation | Uploads live inside a `tempfile.TemporaryDirectory` and no longer; no accounts; no server-side copy of anyone's work |
| Log hygiene | `logging_filters.RedactPII` rewrites IPs, emails and filenames **before** a record reaches a handler |
| Secure development | `defusedxml` for untrusted PPTX XML (`app.py`), a real CSP, `MAX_CONTENT_LENGTH` at 120 MB, `secure_filename` on every upload |
| Abuse limits on unauthenticated endpoints (added 2026-09-21) | `/api/consent` refuses bodies over 1 KB and validates every field it writes; the YouTube lock table and stream cache are LRU-capped at 256 entries; at most 3 frame decodes run at once. All three are global, not per-IP, so none of them keeps a record of who asked |
| Transport security | HSTS when the request is secure; `FORCE_HTTPS` redirects; `TRUST_PROXY_HEADERS` so the header actually ships behind a proxy |
| Regression protection | ~490 tests, including ones that fail if a tracker returns to the page, a first visit touches any Google origin, or an upload is written outside a temp directory |

## Controls that were missing, and what was done

### Vulnerability management — added

`yt-dlp`, `PyMuPDF` and `Pillow` all parse hostile input: a PDF, a PPTX, or a video stream
someone else controls. They are the realistic attack surface here.

```bash
pip install pip-audit
pip-audit -r requirements.txt
```

Monthly, and before any deploy that bumps a pinned version. PyMuPDF and Pillow advisories
are the ones that matter — both touch attacker-supplied files on the server.

### Incident response — added

See `docs/legal/incident-response.md`. GDPR Art. 33 gives 72 hours; DPDP §8(6) requires
notification to the Data Protection Board and to affected people. Neither clock is one to
start reading about on the day.

## If payments are ever added

Card data must never reach this server. Use Stripe Checkout or the Payment Element, where
the card fields live in Stripe's iframe and the merchant stays at **SAQ A** — the shortest
PCI questionnaire, and the only one appropriate for a project this size. Anything that
posts a card number to a Flask route drags the whole host into PCI scope.

`tests/test_legal.py::PaymentsOutOfScopeTests` fails if a card field appears on any page.
It is there so this decision has to be made deliberately rather than drifted into.

## If a SOC 2 report is ever genuinely needed

It will be because an institution wants to deploy Inkyscib for its students. At that point
the gap is not the controls above — it is evidence collection over time, a written policy
set, and an auditor. Start with ISO 27001 Annex A as a checklist, not with a vendor.
