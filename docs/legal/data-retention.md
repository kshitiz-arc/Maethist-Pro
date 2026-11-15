# Retention

> **Version 2 (2026-11-15) removed Google Analytics, the consent banner, `/api/consent`,
> `consent_log.py` and the two consent-log tools.** Every row, step or command below that
> mentions analytics, consent or the consent chain is historical and no longer describes
> running code. There is nothing to prune or verify. The only third party a visitor can
> reach is YouTube, and only by opening a lecture. `tests/test_analytics_csp.py` keeps it so.

Written 2026-09-20. GDPR Art. 5(1)(e), Singapore PDPA §25, DPDP §8(7): data is kept only
as long as the purpose needs it. A retention promise nothing enforces is worse than no
promise, so each row below names the mechanism that actually expires it.

| What | Window | Enforced by | Automatic? |
|---|---|---|---|
| Notes, drawings, notebooks, preferences | Until the visitor clears them | The visitor's own browser; *Erase everything* on `/legal/privacy` | Their choice, not ours |
| An imported PDF or deck | The length of one request | `tempfile.TemporaryDirectory` (`app.py:2274`, `:2333`, `:2732`) | Yes — the context manager deletes on success and on exception |
| Lecture search results | 10 minutes | In-memory cache in `app.py` | Yes |
| Web-server access logs | 30 days | The hosting platform's log retention setting | **Configure it.** Nothing in this repo can |
| Consent audit chain | 24 months | `tools/prune_consent_log.py` | **Only if scheduled.** See below |
| Google Analytics event data | 2 months | GA4 console setting | **Configure it.** See `docs/legal/subprocessors.md` |

## The consent chain prune

```bash
python tools/prune_consent_log.py            # 24 months, the default
python tools/prune_consent_log.py --months 12
```

It drops entries older than the window and **re-chains the survivors from genesis**, so
`tools/verify_consent_log.py` still reports the chain intact afterwards. A prune that left
a broken chain would be indistinguishable from tampering, which is why the two tools are
tested together (`tests/test_privacy_server.py::RetentionTests`).

Schedule it monthly. On a Linux host:

```
0 4 1 * * cd /srv/inkyscib && python tools/prune_consent_log.py >> /var/log/inkyscib-prune.log 2>&1
```

On Windows, Task Scheduler with the same command.

## Verify before an audit

```bash
python tools/verify_consent_log.py
```

Exit code 0 and `chain intact` means every entry hashes to what it claims and nothing has
been removed out of band. Exit code 1 means the file has been edited since it was written —
which is the question an auditor is actually asking.

## What "immutable" does and does not mean here

The chain is **tamper-evident**, not tamper-proof: someone with write access to the file
can rewrite the whole chain from genesis. Making it tamper-proof is a hosting decision —
write-once object storage, or shipping each line to an append-only external log sink — not
something a Python module can do to a file it owns. Said plainly here so nobody reads
"immutable audit trail" into a guarantee that is not being made.
