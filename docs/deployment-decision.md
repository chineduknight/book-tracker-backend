# Deployment decision (candidate, not approved)

> **Status: AWAITING OWNER APPROVAL.** Nothing has been provisioned, purchased, connected or
> deployed. Provider, plan, region, Atlas tier, backup tier, monthly budget ceiling and the first
> deployment each need an explicit decision from the owner (section 6). Prices below were read from
> the vendors' official pages on **2026-11-15** and must be re-checked on the day an account is
> created; they exclude VAT/sales tax and foreign-exchange charges on a Nigerian card.

## 1. What the API needs from a host

| Need                                                          | Source in this repository                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Node.js **26.x**                                              | `.nvmrc` (`26`), `engines` with `engine-strict`. Build compiles TypeScript (`npm ci && npm run build`).                    |
| One long-running process                                      | `node dist/server.js`. Rate limits live in memory: **exactly one instance** (see [decisions.md](decisions.md)).            |
| HTTP readiness check                                          | `GET /api/v1/ready`: 200 only with MongoDB connected and required indexes verified. Never `/health` for traffic gating.    |
| Graceful stop                                                 | Handles `SIGTERM`: drains up to 8 s, forced exit at 10 s. The host must wait ≥ 15 s before `SIGKILL`.                      |
| Memory                                                        | Measured 142 MiB RSS idle, 155 MiB after 1,050 requests (local, Node 26). One export holds up to 32 MiB plus its encoding. |
| No disk                                                       | No uploads or local files; any ephemeral filesystem is fine.                                                               |
| MongoDB with unique, partial and TTL indexes, no transactions | Any MongoDB 7/8 deployment; Atlas is the managed default.                                                                  |
| Exact HTTPS CORS origin                                       | `CORS_ORIGIN` (production refuses `http://`).                                                                              |
| Known proxy hop count                                         | `TRUST_PROXY_HOPS` must equal the proxies in front of the API; verified on staging (runbook §5).                           |

## 2. Node hosts compared

### Render ([pricing](https://render.com/pricing), [free](https://render.com/docs/free), [health checks](https://render.com/docs/health-checks), [deploys](https://render.com/docs/deploys), [Blueprint](https://render.com/docs/blueprint-spec), [regions](https://render.com/docs/regions), [Node version](https://render.com/docs/node-version))

- **Workspace:** Hobby has no monthly fee; you pay for compute and usage. Compute is prorated by
  the second ([FAQ](https://render.com/docs/faq)).
- **Instances:** Free (0.1 CPU, 512 MB), Starter `0.5c-512mb` (0.5 CPU, 512 MB) **$7/month**,
  Standard `1c-2g` (1 CPU, 2 GB) **$25/month**. The dollar figures come from the pricing page as
  indexed by search; its tables did not render in a direct fetch. **Reconfirm on the page.**
- **Usage:** Hobby includes 5 GB outbound bandwidth, then $0.15/GB; 500 build minutes. Extra custom
  domains $0.25/month each.
- **Free instances:** spin down after 15 idle minutes, cold start "about one minute", 750 instance
  hours per workspace per month (then suspended until next month), may restart at any time, no
  SSH, single instance, rollbacks only to the two previous deploys.
- **Health checks:** HTTP path (`healthCheckPath`), 2xx/3xx healthy, 5 s per check. A new deploy
  gets traffic only once healthy; otherwise Render cancels it after 15 minutes and keeps the old
  instance serving. While running: 15 s of failures removes the instance from traffic, 60 s
  restarts it.
- **Deploys:** zero-downtime; the old instance receives `SIGTERM`, then `SIGKILL` after
  `maxShutdownDelaySeconds` (default 30, max 300). Auto-deploy can be `off`
  (`autoDeployTrigger: off`).
- **Regions:** Oregon, Ohio, Virginia, **Frankfurt**, Singapore; fixed at creation.
- **Node version:** `NODE_VERSION` > `.node-version` > `.nvmrc` > `engines`. Default for new
  services is 24.22.1; **Node 26 support is not stated** and must be proven on the first staging
  build.
- **Proxy:** the load balancer terminates TLS. `X-Forwarded-For` handling and the number of hops
  are **not documented**; Render's own articles mention `trust proxy` 1, and community reports say
  the edge appends to a client-supplied header. **The hop count must be measured on staging**
  (runbook §5) before `TRUST_PROXY_HOPS` is set; until then all clients share one rate-limit
  bucket (safe but coarse).

### Railway ([pricing](https://railway.com/pricing), [plans](https://docs.railway.com/pricing/plans), [cost control](https://docs.railway.com/pricing/cost-control), [health checks](https://docs.railway.com/deployments/healthchecks), [deployments](https://docs.railway.com/reference/deployments), [networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits), [regions](https://docs.railway.com/reference/regions))

- **Plans:** Hobby **$5/month** subscription including $5 of usage; Pro $20 including $20. Credit
  cards only; the subscription is charged even with zero usage.
- **Usage prices:** RAM $10/GB-month, CPU $20/vCPU-month, egress $0.05/GB, volumes $0.15/GB-month,
  builds free; billed per second.
- **Spend control:** workspace usage limits with email alerts at 75/90/100 % and a **hard limit**
  (minimum $10) that takes workloads offline when reached.
- **Health checks:** deploy-time only (default timeout 300 s); **no continuous monitoring**, so an
  external uptime check is still needed.
- **Deploys:** old deployment gets `SIGTERM` once the new one is active, with **0 s draining by
  default**; set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`. Rollback redeploys a previous image
  within 72 h on Hobby. Auto-deploy can be disabled per service.
- **Proxy:** sets `X-Real-IP` (which this API deliberately ignores); `X-Forwarded-For` and hop
  count **not documented**. Idle keep-alive closed after 60 s (the API keeps 65 s, so the proxy
  closes first); requests may run 15 min while data flows.
- **Regions:** US West (California), US East (Virginia), **EU West (Amsterdam)**, Southeast Asia
  (Singapore).
- **Node version selection** (Railpack) was not confirmed from the docs; prove Node 26 on staging.

### Estimated monthly cost for this API alone

| Option         | Base                     | Estimated usage (one instance)                                          | Estimated total               |
| -------------- | ------------------------ | ----------------------------------------------------------------------- | ----------------------------- |
| Render Free    | $0                       | Within 750 h and 5 GB if traffic is light                               | **$0**, sleeps when idle      |
| Render Starter | $7 (always on)           | Bandwidth inside 5 GB at personal scale                                 | **≈ $7**                      |
| Railway Hobby  | $5 subscription incl. $5 | 0.16–0.25 GB RAM ≈ $1.6–2.5 + mostly idle CPU (0.02–0.05 vCPU ≈ $0.4–1) | **≈ $5** (usage under credit) |

Estimates use the measured memory; CPU and egress are guesses until staging measures them. Add
the database (section 3), backups (section 4), a domain if wanted, taxes and FX charges.

## 3. Database: MongoDB Atlas ([cluster tiers](https://www.mongodb.com/docs/atlas/manage-clusters/), [free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/), [pricing](https://www.mongodb.com/pricing))

| Tier          | Price                            | Limits relevant here                                                                                                                                                                                               |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Free (M0)     | $0                               | 512 MB data + indexes, 100 ops/s, 500 connections, 10 GB in/out per rolling week, one per project, a subset of regions, paused after 30 days with zero connections, no `mongodump --oplog`, no Performance Advisor |
| Flex          | $8–$30/month by ops/s ($0.011/h) | 5 GB, 500 ops/s, 500 connections, **daily snapshots, last 8 kept**, no point-in-time restore                                                                                                                       |
| Dedicated M10 | from ≈ $57/month ($0.08/h)       | 2 GB RAM, burstable CPU; cloud backup billed separately by snapshot storage                                                                                                                                        |

The API needs only a database user with `readWrite` on its own database. MongoDB 8.0 (Atlas
default) matches CI.

## 4. Backups (detail in [backup-and-restore.md](backup-and-restore.md))

- **Atlas Free backup** ([docs](https://www.mongodb.com/docs/atlas/backup/cloud-backup/free-cluster-backup/)):
  **private preview**, may not be offered to this project; $0.10/day up to $3/month; one daily
  snapshot, last four kept; needs a payment method. Not assumed.
- **Flex:** daily snapshots included, eight kept.
- **Operator `mongodump`** (`npm run db:backup`): $0 in vendor fees, works on every tier, costs
  the owner's time and private encrypted storage. Required regardless, until a native backup has
  been restored successfully in a rehearsal.

## 5. Region

Readers are expected mainly in Nigeria. None of these providers offers an African region for
these tiers; the nearest are **Frankfurt** (Render, Atlas on AWS `eu-central-1`) and **Amsterdam**
(Railway). Keep the API and the database in the same region: every request makes one or more
database round trips, so API-to-database latency matters more than browser-to-API latency.
Latency from Nigeria has **not been measured**; staging must record it (runbook §4) before the
region is fixed. Render regions cannot be changed after creation.

## 6. Recommendation and decisions for the owner

**Candidate for a first, disposable preview:** Render **Free** web service in Frankfurt + Atlas
**Free (M0)** in Frankfurt, auto-deploy off, synthetic data only, `npm run db:backup` backups. Cost
$0. It sleeps after 15 idle minutes and wakes in about a minute, so it is not a regularly used
production service.

**Candidate for regular use:** after staging measurements, either Render **Starter** ($7) or
Railway **Hobby** (≈ $5, hard spend limit available), with Atlas **M0** plus operator backups, or
Atlas **Flex** ($8+) if managed daily snapshots are wanted. Railway's hard limit is the better
guardrail against surprise bills; Render's always-on instance is simpler and its health checks are
continuous.

| Decision                                      | Options                                                                                | Status                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| Monthly budget ceiling (all-in, incl. tax/FX) | e.g. $0 (preview only), $10, $20                                                       | **Awaiting owner approval** |
| Host and plan                                 | Render Free (preview) / Render Starter / Railway Hobby                                 | **Awaiting owner approval** |
| Region                                        | Frankfurt (Render, Atlas) or Amsterdam (Railway) + nearest Atlas region; measure first | **Awaiting owner approval** |
| Atlas tier                                    | M0 / Flex                                                                              | **Awaiting owner approval** |
| Backup plan                                   | Operator `mongodump` (required) ± Atlas preview ($3) or Flex snapshots                 | **Awaiting owner approval** |
| Per-reader request limit                      | Off, or a ceiling such as 300/minute (`READER_REQUESTS_PER_MINUTE`)                    | **Awaiting owner approval** |
| Acceptable data loss (RPO) and downtime (RTO) | Proposed RPO ≤ 24 h; RTO measured in rehearsal                                         | **Awaiting owner approval** |
| Account creation, secrets, first deploy       | —                                                                                      | **Awaiting owner approval** |

An inert Render example with auto-deploy off is in
[examples/render.yaml.example](examples/render.yaml.example). It is not a live Blueprint and must
not be connected to Render without approval.
