# Incident response

> **Version 2 (2026-11-15) removed Google Analytics, the consent banner, `/api/consent`,
> `consent_log.py` and the two consent-log tools.** Every row, step or command below that
> mentions analytics, consent or the consent chain is historical and no longer describes
> running code. There is nothing to prune or verify. The only third party a visitor can
> reach is YouTube, and only by opening a lecture. `tests/test_analytics_csp.py` keeps it so.

Written 2026-09-20. One page, because a plan nobody can read on a bad day is not a plan.

## What a breach looks like here

Inkyscib holds almost nothing, so most of the usual scenarios do not apply. There is no
user table to dump and no password file to leak. The realistic incidents, in order of how
much they would actually matter:

| # | Scenario | Why it is the serious one | The control that exists |
|---|---|---|---|
| 1 | **The host is compromised and serves modified JavaScript** | Visitors' notes never touch the server — but code running on the page can read IndexedDB and send it anywhere. This is the only path to someone else's work | `Content-Security-Policy` restricts where scripts may load from and where the page may connect. It is a security control, not a style preference |
| 2 | A dependency with a known RCE parses an uploaded file | `PyMuPDF`, `Pillow` and `yt-dlp` all parse hostile input on the server | `pip-audit` monthly; `defusedxml`; `MAX_CONTENT_LENGTH` |
| 3 | The consent chain is altered | Not a data breach; an integrity failure that undermines the Art. 7(1) record | `tools/verify_consent_log.py` detects it |
| 4 | Access logs leak | They carry truncated IPs and nothing else | `logging_filters.RedactPII` |
| 5 | Someone's own device is compromised | Their notes are readable, but that is their device, not our system | Out of scope, and worth saying so plainly |

Scenario 1 is the one to rehearse. Everything else is a nuisance by comparison.

## The first hour

1. **Take the site down rather than leave a compromised version up.** A maintenance page
   costs a day of traffic; a page exfiltrating notes costs the thing the product is for.
2. **Write down the time** you noticed, and what you saw. The Art. 33 clock runs from
   *awareness*, and "roughly Tuesday" is not a defensible record.
3. **Preserve evidence before cleaning.** Snapshot the host and the logs. Rebuilding first
   destroys the only answer to "what did they reach".
4. **Rotate every credential**: `SECRET_KEY`, deploy tokens, the GA4 property if the tag
   was touched, DNS and registrar passwords.
5. **Rebuild from a known-good commit**, not from the running host.

## The 72-hour clock

**GDPR Art. 33** — if personal data was or may have been accessed, notify the lead
supervisory authority within **72 hours of awareness**. In the UK that is the ICO. An
incomplete notification on time beats a complete one late; you are allowed to follow up.

**GDPR Art. 34** — if there is a high risk to the people affected, tell them too. With no
accounts there is no mailing list, so notification is **a notice on the site itself**, at
the top of every page, plus the repository's README. Write it as though a student's parent
will read it, because one might.

**DPDP §8(6) (India)** — notify the Data Protection Board and each affected Data Principal.
No 72-hour figure is fixed in the Act; the Rules prescribe the form. Treat it as "without
delay" and follow the same timeline as Art. 33.

Judgement call worth pre-making: **scenario 1 is notifiable.** If injected script could
read IndexedDB, then personal data (whatever people wrote in their notes) may have been
accessed, even without proof that it was.

## Who does what

A solo project, so: the maintainer declares the incident, and the same person does
everything above. The one thing to delegate is the reading — get a second pair of eyes on
the notification text before it is published. Contact for reports:
the address published on `/legal/privacy`.

## The holding statement

Publish this before you know the details. Silence looks worse than an incomplete answer.

> **<date> — service interruption under investigation**
>
> We took Inkyscib offline at <time UTC> while we investigate a problem with the way the
> site was being served. Your notes are stored in your own browser and are not held on our
> servers. We do not yet know whether anything could have been read from a browser while
> the site was affected; we are checking, and we will update this page with what we find,
> including if the answer is "nothing".
>
> If you have a backup you want to keep, export it before clearing your browser data.

## Afterwards

Write the postmortem in `docs/legal/` with the date in the filename: what happened, how it
was noticed, how long it ran, what was reachable, what was changed, and the one control
that would have caught it sooner. No blame — there is only one person here, so blame is
just noise.
