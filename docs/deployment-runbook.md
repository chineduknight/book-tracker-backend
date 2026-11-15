# Deployment runbook

Manual, step-by-step procedures for staging, launch, verification and rollback. **Nothing in this
runbook may be executed against a real host or database until the owner has approved the
provider, plan, region, budget and the specific step** ([release-checklist.md](release-checklist.md)).
There is no automatic deployment: CI only verifies, and any host must have auto-deploy off.

Related: [deployment-decision.md](deployment-decision.md) (provider options),
[index-operations.md](index-operations.md), [backup-and-restore.md](backup-and-restore.md),
[monitoring-and-budget.md](monitoring-and-budget.md), [operations.md](operations.md) (data repairs).

## 1. Environments

| Environment | Database                                                                                 | Data                      | Who may use it                     |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| Local       | `book-tracker` / `book-tracker-dev` on the developer's machine                           | Developer's own           | Developer                          |
| Tests       | `book-tracker-test*`, `book-tracker-smoke`, `book-tracker-restore-rehearsal`, local only | Synthetic, deleted freely | Automated tests (guarded)          |
| Staging     | Its own Atlas project/cluster or database, e.g. `book-tracker-staging`                   | **Synthetic only**        | Owner and a synthetic test account |
| Production  | Its own Atlas project and database, e.g. `book-tracker`                                  | Readers' private data     | Readers                            |

Staging and production never share a database, a database user or a signing secret.

## 2. Configuration

Every value is a **runtime** variable set in the host's dashboard (secret store), never in the
repository, the build command or CI. The build needs no secrets.

| Variable                     | Production value                                                                                                                                             | Secret  | Rotation                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                   | `production` (turns on production checks and turns off automatic index builds)                                                                               | No      | —                                                                                                                                                                              |
| `PORT`                       | Set by the host (Render, Railway); do not override                                                                                                           | No      | —                                                                                                                                                                              |
| `MONGODB_URI`                | `mongodb+srv://<app-user>:<password>@<cluster>/<database>?retryWrites=true&w=majority`, naming the database explicitly                                       | **Yes** | New Atlas password → update variable → redeploy → delete old password. No downtime with a two-user overlap.                                                                    |
| `JWT_ACCESS_TOKEN_SECRET`    | Fresh 32 random bytes, base64url (`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`), generated per environment | **Yes** | Rotation invalidates every access token at once (clients refresh within 15 min; refresh tokens stay valid). Only on suspected leak or by schedule, announced; never automatic. |
| `CORS_ORIGIN`                | Exact `https://` frontend origin(s), comma-separated; `http://` and `*` are refused in production                                                            | No      | —                                                                                                                                                                              |
| `LOG_LEVEL`                  | `info`                                                                                                                                                       | No      | —                                                                                                                                                                              |
| `TRUST_PROXY_HOPS`           | `0` until §5 has measured the host's hop count; then exactly that number (0–3)                                                                               | No      | Re-verify after any change in front of the API (CDN, custom proxy)                                                                                                             |
| `READER_REQUESTS_PER_MINUTE` | Unset (off) unless the owner approves a ceiling ([monitoring-and-budget.md](monitoring-and-budget.md))                                                       | No      | —                                                                                                                                                                              |

**Must never be set on a deployed API** (the process refuses to start in production if any is
present): `MONGODB_TEST_URI`, `MONGODB_SMOKE_URI`, `RESTORE_REHEARSAL_URI`.

Database users (Atlas → Database Access):

- `book-tracker-api`: built-in role **`readWrite` on the application database only**. Never an
  Atlas admin, `atlasAdmin`, `readWriteAnyDatabase` or the cluster's root user.
- `book-tracker-indexes`: `dbAdmin` on the application database, used only from an operator
  machine for `npm run db:indexes -- --apply`; disable or delete it afterwards.
- `book-tracker-backup`: `read` on the application database (plus `backup` if Atlas requires it
  for `mongodump`), used only for `npm run db:backup`.

Network access: the API host's outbound addresses may not be fixed on free/cheap tiers, which
pushes towards `0.0.0.0/0` in the Atlas IP access list. If that is accepted, compensate with long
random passwords and no other users; record the decision. Operator machines are added
temporarily by IP and removed afterwards.

## 3. Build and start (host-agnostic)

| Step        | Command                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime     | Node.js 26.x (`.nvmrc`; on Render also `NODE_VERSION=26`). The build log must show Node 26.                                              |
| Build       | `npm ci && npm run build` (dev dependencies are needed to compile TypeScript)                                                            |
| Start       | `node dist/server.js`, directly, so `SIGTERM` reaches Node (no `tsx`, no watch mode, no `npm run dev`)                                   |
| Health path | `/api/v1/ready`                                                                                                                          |
| Instances   | Exactly **1**, no autoscaling (in-memory rate limits)                                                                                    |
| Shutdown    | Host grace period ≥ 15 s: Render `maxShutdownDelaySeconds` 30 (default); Railway `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` (default is 0) |
| Auto-deploy | **Off**                                                                                                                                  |

What the process does: listens immediately (`/health` 200, `/ready` 503), connects to MongoDB with
retries every 5 s, verifies required indexes read-only (rechecking every 30 s), then `/ready`
returns 200. On `SIGTERM` it stops accepting connections, finishes in-flight requests for up to
8 s, closes the rest, disconnects and exits 0; a forced exit happens at 10 s; a second signal
exits immediately.

HTTP limits (`src/http-server.ts`): request headers within 20 s, whole request within 30 s
(`408`), idle keep-alive 65 s (above Railway's documented 60 s proxy idle timeout; Render's is not
documented), and a connection idle for 60 s mid-response is destroyed. A full 32 MiB export
completes as long as the client keeps reading. Bodies are capped at 100 kB.

## 4. Staging rehearsal (synthetic data only)

Preconditions: owner approval for the staging account, plan, region and spend; a staging Atlas
database and users per §2; no production data anywhere in staging.

1. Run `npm run db:indexes -- --apply --confirm-database=<staging database>` from an operator
   machine with the index user, then `npm run db:indexes` (exit 0).
2. Create the service by hand (or from the inert example after review) with the §2 variables and
   §3 settings. Confirm auto-deploy is off.
3. Deploy the exact commit to be released. In the build log, record the Node version and the
   commit SHA.
4. Wait for the health check to pass. In the logs confirm `HTTP server listening`, `MongoDB
connected`, `Required MongoDB indexes verified` and the `Rate limits are held in this process`
   line with the expected settings.
5. Run the **non-destructive smoke checklist** (§6) against staging.
6. Measure and record: memory after start and after the smoke checklist; `/api/v1/ready` latency
   from Nigeria (for example 20 × `curl -w '%{time_total}'` from a Nigerian connection) and from
   the host region; cold start time if on a free tier.
7. Run the proxy hop-count check (§5) and set `TRUST_PROXY_HOPS`.
8. Rehearse a rollback (§8) and a restart (`/ready` returns 503 then 200; no errors besides the
   expected disconnect warning).
9. Take a backup of staging and run a restore rehearsal from it
   ([backup-and-restore.md](backup-and-restore.md)).

Never run `npm run test:integration`, `npm run api:smoke` or any Bruno folder that deletes or
races data against staging or production. The full Bruno collection registers accounts and
writes data; it is for the local disposable smoke database only.

## 5. Proxy hop-count check (staging)

`TRUST_PROXY_HOPS` must equal the number of proxies that append to `X-Forwarded-For` in front of
the API. Too low: every reader shares one rate-limit bucket (safe, but one abusive client can
throttle sign-ups for everyone). Too high: callers choose their own address and evade per-address
limits. The test suite proves both behaviours through a real appending proxy
(`test/trusted-proxy.test.ts`); this check measures the real host.

The auth limiter reports the caller's bucket in the standard `RateLimit` response header
(`r=<remaining>`). Each check request is a harmless invalid login (`400`, no account touched):

```bash
check() { curl -s -o /dev/null -D - -X POST "$API/api/v1/auth/login" \
  -H 'content-type: application/json' "$@" --data '{}' | grep -i '^ratelimit:'; }
API=https://<staging-host>
check                                         # r=N
check -H 'X-Forwarded-For: 203.0.113.7'       # must be r=N-1 (same bucket)
check -H 'X-Forwarded-For: 198.51.100.8'      # must be r=N-2
```

1. With `TRUST_PROXY_HOPS=0`: the three calls must decrement one counter. Repeat from a second
   network (for example a phone hotspot): it continues the **same** counter (all clients share
   the proxy's address). Record this as the baseline.
2. Set `TRUST_PROXY_HOPS=1`, redeploy, repeat. Forged headers must still decrement the same
   counter, and the second network must start its **own** counter. If forged headers start new
   counters, 1 is too high: set it back to 0 and investigate the host's proxy chain.
3. If 1 still shares a counter across networks, try 2 and repeat all checks; never go above the
   value at which forged headers stay ineffective.
4. Record the result, date and host in [decisions.md](decisions.md). Re-run after any change at
   the edge (custom domain through a CDN, another proxy).

The API must not be reachable except through the host's proxy, otherwise a direct caller could
forge the header (also shown in the tests). Render and Railway expose services only through their
edge; a self-managed server would need a firewall.

## 6. Non-destructive smoke checklist (staging or production)

Run by hand after every deployment. Nothing here writes to a real reader's data.

| Check                                                                                              | Command / action                                                                                       | Expect                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Liveness                                                                                           | `curl -si $API/api/v1/health`                                                                          | `200`, `cache-control: no-store`, `x-request-id`                                               |
| Readiness                                                                                          | `curl -si $API/api/v1/ready`                                                                           | `200` `{ "data": { "status": "ready", "checks": { "database": "connected" } } }`               |
| TLS                                                                                                | `curl -sI http://<host>/api/v1/health`                                                                 | Redirect to `https://`                                                                         |
| No auth, no data                                                                                   | `curl -si $API/api/v1/books`                                                                           | `401`, `www-authenticate: Bearer`, `no-store`                                                  |
| CORS allowlist                                                                                     | `curl -si -X OPTIONS $API/api/v1/books -H "Origin: $FRONTEND" -H 'Access-Control-Request-Method: GET'` | `204` with `access-control-allow-origin: $FRONTEND`                                            |
| CORS refusal                                                                                       | Same with `-H 'Origin: https://evil.example'`                                                          | No `access-control-allow-origin` header                                                        |
| Error envelope                                                                                     | `curl -si $API/api/v1/nope`                                                                            | `404` `{ "error": { "code": "NOT_FOUND", … , "requestId" } }`                                  |
| Signed-in read (staging only, or production with the owner's own synthetic account after approval) | Log in with the dedicated synthetic account; `GET /api/v1/auth/me`, `GET /api/v1/books`                | `200`, own data only                                                                           |
| Logs                                                                                               | Host log view                                                                                          | One line per request with method, path, status, request id; no query strings, bodies or tokens |

Explicitly prohibited on staging with real data and on production: concurrent loan or
reading-session races, deletions, registration floods, exports of real readers, the Bruno
collection and every test suite. The `409` invariants are proven by CI against MongoDB 8.0 and by
the index check (`npm run db:indexes`), not by live races.

## 7. Production launch

1. Every item in [release-checklist.md](release-checklist.md) is ticked and the owner has written
   "go" for this commit.
2. Fresh production secrets (§2); production database and users created; IP access list decided.
3. Indexes built and verified on the production database ([index-operations.md](index-operations.md)).
4. Manual deploy of the approved commit SHA. Wait for `/api/v1/ready` 200 via the host health
   check.
5. Smoke checklist (§6) against production, without signed-in steps unless approved.
6. First backup taken and its rehearsal passed within 24 hours of launch.
7. Monitoring and budget alerts active ([monitoring-and-budget.md](monitoring-and-budget.md)).

## 8. Rollback

Code rollback and data rollback are different. Redeploying an older commit never undoes database
writes or index changes.

```text
Is the problem in the code only (bad response, crash loop, 5xx), with no data written wrongly?
├─ yes → Is the previous release compatible with the current indexes and data?
│        ├─ yes (normal: indexes are additive) → redeploy the previous artifact/commit
│        │        (Render: Rollback to the previous deploy; Railway: Rollback within 72 h),
│        │        confirm /ready 200 and the smoke checklist. Keep new indexes.
│        └─ no / unsure → stop writes (suspend the service or set it to maintenance), then decide
│                 with the owner; do not improvise migrations under pressure.
└─ no, data is wrong or lost →
         stop writes immediately (suspend the service), keep the current database untouched for
         investigation, and follow the recovery procedure in backup-and-restore.md
         (restore into a NEW database, verify, repoint MONGODB_URI). Never restore over the
         live database.
```

Never drop a newly built unique index to roll back code: older code is unaffected by it, and
dropping it would let duplicates in. Never run `syncIndexes()` or any destructive tool to "clean
up" during an incident.

## 9. Incident response

Procedures per incident (database unavailable, request flood, leaked secret, compromised session,
failed index rollout, failed deployment, missing backups, oversize exports, provider outage, free
tier exhausted) are in [monitoring-and-budget.md](monitoring-and-budget.md#incident-procedures).
