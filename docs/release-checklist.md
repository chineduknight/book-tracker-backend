# Release checklist (go / no-go)

Copy this list into the release notes for each staging or production release and tick each item
with evidence (link, log excerpt, command output, date). **Any unticked item is a no-go.** The
final gate is the owner's written approval for that exact commit; no one else can give it.

## A. Code and CI

- [ ] PR reviewed and merged by the owner; release commit SHA: `________`
- [ ] Both CI jobs green on that SHA (typecheck, lint, format, unit tests, build, production
      dependency audit; MongoDB 8.0 integration tests including the backup/restore drill; Bruno
      smoke on a local disposable database)
- [ ] `npm audit --omit=dev` reports no high or critical vulnerability
- [ ] No API contract change, or every change documented in `docs/api-contract.md`, Bruno and tests

## B. Decisions (owner)

- [ ] Monthly all-in budget ceiling: `$____`
- [ ] Host, plan and region: `________` (latency from Nigeria measured on staging: `____ ms`)
- [ ] Atlas tier and region: `________`
- [ ] Backup plan, RPO (proposed ≤ 24 h) and measured RTO accepted
- [ ] Per-reader request limit: off / `____` per minute
- [ ] Atlas IP access list policy recorded (fixed egress IPs or `0.0.0.0/0` with compensations)

## C. Configuration (host dashboard, never the repository)

- [ ] `NODE_ENV=production`; `PORT` left to the host
- [ ] `MONGODB_URI` uses the least-privilege `readWrite` user and names the database explicitly
- [ ] `JWT_ACCESS_TOKEN_SECRET` freshly generated for this environment, stored only in the host
- [ ] `CORS_ORIGIN` = exact `https://` frontend origin(s)
- [ ] `TRUST_PROXY_HOPS` set from the staging hop-count check (runbook §5), result recorded
- [ ] None of `MONGODB_TEST_URI`, `MONGODB_SMOKE_URI`, `RESTORE_REHEARSAL_URI` set (the API would refuse to start)
- [ ] Build `npm ci && npm run build`; start `node dist/server.js`; build log shows Node 26.x
- [ ] Health check path `/api/v1/ready`; exactly **one** instance; no autoscaling
- [ ] Shutdown grace ≥ 15 s (Render default 30 s; Railway `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`)
- [ ] Auto-deploy **off**; no deploy hooks, pre-deploy commands or CI secrets that can deploy

## D. Database

- [ ] Verified backup younger than 24 h **and** a passing restore rehearsal from it
- [ ] `npm run db:indexes` exits 0 on the target database (output recorded); no `conflicting`
- [ ] Index builds, if any, were approved and done in a window ([index-operations.md](index-operations.md))
- [ ] Temporary index-builder and operator IP access removed afterwards

## E. Staging rehearsal (synthetic data only)

- [ ] Deployed the same SHA to staging; logs show `Required MongoDB indexes verified`
- [ ] Non-destructive smoke checklist passed (runbook §6)
- [ ] Memory after start and after the checklist: `____ MB` / `____ MB`
- [ ] Rollback rehearsed to the previous release; `/ready` 200 afterwards
- [ ] Restart rehearsed: `SIGTERM` → `Shutdown complete`, no forced exit in logs

## F. Operations

- [ ] Uptime check on `/api/v1/ready` and alert channel working (test alert received)
- [ ] Spend alerts / hard limit configured at the ceiling
- [ ] Owner knows where backups and the encryption key are
- [ ] Incident procedures read ([monitoring-and-budget.md](monitoring-and-budget.md#incident-procedures))

## G. Gates that cannot be met in this repository (pending first approved staging)

These were not and could not be verified locally; they block production until done on staging:

- [ ] Host builds and runs on Node 26 (Render's documented default is 24)
- [ ] Real proxy hop count and forged-header behaviour (runbook §5)
- [ ] Host proxy idle/keep-alive timeout compatible with the API's 65 s (documented for Railway, not Render)
- [ ] Host sends `SIGTERM` and waits the configured grace period (observe `Shutdown complete`)
- [ ] Atlas M0/Flex accepts the index build and the read-only check on MongoDB 8.0
- [ ] `mongodump` / `mongorestore` work against the chosen Atlas tier from the operator machine
- [ ] Latency and memory measured in the chosen region

## Go / no-go

- [ ] **Owner approval** for SHA `________` to `staging` / `production` on `____-__-__`:
      "Go" — signed `________`

Nothing is provisioned, purchased, deployed or connected before this line is signed.
