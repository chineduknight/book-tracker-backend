# Monitoring, limits, budget and incidents

Status: **plan only.** No monitoring service, alert channel or billing alert has been set up;
each needs an account the owner approves. Provider features are as documented on 2026-11-15
([deployment-decision.md](deployment-decision.md)).

## Probes

| Probe                | Use                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/ready`  | Host health check (traffic gating, restarts) and the external uptime check. 200 only with MongoDB connected and indexes verified. |
| `GET /api/v1/health` | Process liveness only. Never for traffic gating: it stays 200 while the database is down.                                         |

Both are unauthenticated, `no-store`, and reveal nothing beyond status and a timestamp. There is
no diagnostics, metrics or debug endpoint, and none should be added without authentication.
Render checks continuously; **Railway checks only during deploys**, so an external uptime monitor
(for example a free UptimeRobot or Better Stack check on `/api/v1/ready` every 5 minutes) is
needed on Railway and recommended everywhere. Choosing that service is an owner decision.

## Logs

Structured JSON (Pino) to stdout, read in the host's log view (access-controlled by the host
account). One line per request with `req.id`, `req.method`, `req.path` (**no query string**),
`res.statusCode` and duration; lifecycle lines (`HTTP server listening`, `MongoDB connected`,
`Required MongoDB indexes verified`, `Shutdown started/complete`); safe errors reduced to class
name and code. Never logged: request or response bodies, headers such as `Authorization` and
cookies, tokens, passwords, notes, borrower details, query strings, connection strings, raw
exception messages or stacks. Index problems are logged by collection and index name only.

**Correlating a complaint:** every response carries `X-Request-Id` (a client may send its own
safe id). Ask the reader for the id shown by the app (or the time and action), search the host's
logs for it, and read the matching line. Never ask a reader for their password or tokens, never
look up another reader's data to investigate, and do not copy log lines into public issues.

Log retention is whatever the host keeps (short on free tiers); no log drain is planned for V1.

## Alerts (to set up after approval)

| Signal                             | Source                                                       | Threshold (proposal)                                                      | First response                                    |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| API unreachable / `/ready` failing | External uptime check; Render health events                  | 2 consecutive failures (≈ 10 min)                                         | Incident: database unavailable / provider outage  |
| Repeated 5xx                       | Host logs/metrics                                            | > 5 in 10 min                                                             | Check request ids, recent deploy → rollback       |
| Restarts / crash loop              | Host events                                                  | > 2 restarts in 30 min                                                    | Check `fatal` log lines; rollback                 |
| Memory                             | Host metrics                                                 | > 400 MB on a 512 MB instance                                             | Look for export bursts; consider per-reader limit |
| CPU                                | Host metrics                                                 | > 80 % for 15 min                                                         | Flood procedure                                   |
| Excessive 429                      | Host logs (`statusCode: 429`)                                | > 100 in 10 min                                                           | Flood procedure                                   |
| Atlas connections / storage / ops  | Atlas project alerts                                         | Connections > 400 of 500; storage > 400 MB of 512 MB (M0); ops near 100/s | Plan tier change (approval)                       |
| Backup freshness                   | Operator log of backups                                      | Newest verified backup > 24 h old                                         | Take one now; incident if it fails                |
| Spend                              | Railway usage limits / Render billing / Atlas billing alerts | 50 %, 75 %, 90 % of the ceiling                                           | Budget procedure                                  |

Owner: the project owner; channel: email to the owner (and phone push from the uptime monitor).
No escalation chain exists yet; with a single operator, response is best effort. Free tiers have
no support SLA.

## Request limits

| Layer                           | Today                                                                                                         | Decision needed                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Auth per address/account        | On: 100 auth requests/15 min, 20 registrations/h, 30 failed logins/15 min per address, 10 per account         | —                                                                                                               |
| Per reader (all private routes) | **Off by default.** `READER_REQUESTS_PER_MINUTE` turns it on                                                  | Candidate **300/minute** (5 requests/s sustained; a dashboard load uses a handful); **awaiting owner approval** |
| Coarse per-address at the edge  | None in the app. Render and Railway apply platform DDoS protection; no configurable rate rules on these tiers | Revisit with a CDN/WAF if abuse appears                                                                         |
| Exports                         | ≤ 20,000 records and ≤ 32 MiB per download; a stalled download is dropped after 60 s idle                     | Consider a separate export limit (e.g. 10/hour) with the per-reader limit                                       |
| Stored records per reader       | **No quota.** Not a request-rate concern; would be a product decision                                         | Not proposed                                                                                                    |

All limits are held in this process's memory, valid only with **exactly one** instance; the
process logs this at start. Running two instances would double every limit and split counters.
Scaling out first needs a shared store (for example a managed Redis at extra cost, or
MongoDB-backed counters); that is a future, separately approved decision.

## Budget guardrails

- The owner sets an all-in monthly ceiling (compute, bandwidth, database, backups, domain, taxes,
  FX) before any paid account exists.
- **Railway:** set a workspace usage limit with alerts and a **hard limit** at the ceiling (minimum
  $10); when reached, workloads are taken offline rather than billed further.
- **Render:** Hobby has no monthly fee; set billing alerts and keep one Starter instance; watch the
  5 GB included bandwidth ($0.15/GB beyond). Free instances suspend at 750 h or quota exhaustion
  instead of billing when no payment method is on file.
- **Atlas:** set project billing alerts; M0 cannot incur charges; Flex varies $8–$30 with ops/s.
- No autoscaling, extra instances, paid add-ons, paid backups, log drains or plan upgrades without
  written approval. Review the bill monthly.
- **Free tier suspended or exhausted:** the API stops (Render Free) or the cluster pauses (M0 after
  30 days without connections). Decide with the owner: wait for the next cycle, resume the cluster
  (Atlas UI), or approve a paid plan. Data on M0 stays unless the cluster is deleted.

## Incident procedures

Record every incident: start and end time, impact, request ids, actions, follow-ups.

**Database unavailable** (`/ready` 503 "database is not connected"): the API keeps retrying every
5 s and recovers by itself when MongoDB returns. Check the Atlas status page and cluster state
(paused M0? IP access list? password rotated?). Do not restart in a loop; do not switch databases
without the recovery procedure.

**Indexes not verified** (`/ready` 503 "required database indexes are not verified" after a
deploy): the host keeps the previous instance. Run `npm run db:indexes` read-only, then follow
[index-operations.md](index-operations.md). Never run `syncIndexes`.

**Request flood / bot traffic:** confirm in logs (429s, one path, many request ids). Auth limits
already apply per address; if a signed-in account is the source, revoke its sessions (below) and,
with approval, enable `READER_REQUESTS_PER_MINUTE`. If the flood is distributed and degrading
service, contact the host's support or put the API behind a CDN/WAF (approval needed). Do not
raise limits during a flood.

**Leaked JWT signing secret:** generate a new secret, set `JWT_ACCESS_TOKEN_SECRET`, redeploy.
All access tokens become invalid at once; clients obtain new ones with their refresh tokens.
Forged tokens also need an active session id, but rotate immediately anyway.

**Leaked MongoDB credentials:** change the user's password in Atlas (or create a new user), update
`MONGODB_URI`, redeploy, delete the old credentials, review Atlas access logs if available, and
take a fresh backup.

**Compromised reader session or account:** revoke all of that reader's sessions; access tokens
stop working immediately (every request checks the session) and refresh tokens cannot be used:

```js
// mongosh, connected with an operator user; userId from the reader's report, never guessed
db.sessions.updateMany(
  { userId: ObjectId('<user id>'), revokedAt: null },
  { $set: { revokedAt: new Date(), revocationReason: 'logout' } },
);
```

(`logout` is the closest existing reason; an operator-specific reason would need a code change.)
The reader then signs in again; there is no password reset yet, so a compromised password needs
a manual, owner-approved procedure.

**Failed deployment:** the host keeps the previous instance when the new one never becomes ready.
Read the new instance's logs (config error names the variable; index problems name indexes),
fix, redeploy. If the bad version is serving, roll back
([deployment-runbook.md](deployment-runbook.md#8-rollback)).

**Missing or failed backups:** take a backup now; if it fails, check tools, network access and
credentials; if no verified backup is younger than 24 h, tell the owner the RPO is breached until
one succeeds.

**Oversize exports:** a reader whose export exceeds 20,000 records or 32 MiB gets
`413 EXPORT_TOO_LARGE`; nothing is sent and the cursors are closed. Offer an operator-assisted
export only with the owner's approval and the reader's request; never send another reader's data.
Repeated large exports raising memory: see the memory alert and the per-reader limit.

**Provider outage:** check the host and Atlas status pages; nothing to fix in the app. If prolonged
and data is at risk, the recovery procedure in [backup-and-restore.md](backup-and-restore.md)
applies to a new provider only with the owner's approval.
