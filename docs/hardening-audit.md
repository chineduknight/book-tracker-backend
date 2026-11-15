# Backend hardening audit (PR #13)

A cross-module security, integrity and performance audit of the backend as merged through PR #12
(`3642a04`). It records what was examined, how, what was found and fixed, which existing protections
were verified (and by which test), what was rejected as a false alarm, and what remains for PR #14
or later. It makes no claim that the backend is "secure"; it states what the evidence shows.

**Environment.** Node.js 26.13.0. Local MongoDB 7.0.32 (a single-node replica set reached with
`directConnection=true`; only the disposable `book-tracker-test` and `book-tracker-smoke` databases
were touched). CI uses a standalone `mongo:8.0` service. No transactions are used or assumed.

**Method.** Code review of every route, service, model, middleware and script; probes against a
running app (later deleted, not committed); then a failing regression test before every fix, and
targeted mutations of the protections the new tests rely on (section 10).

## 1. Findings

| ID    | Severity                           | Finding                                                                                            | Status                     |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| HA-01 | Critical (latent, needs misconfig) | The destructive integration suite deleted data on any `MONGODB_TEST_URI`, remote or not            | Fixed                      |
| HA-02 | High                               | Export cursors stayed open on the server when a download stopped at its limit                      | Fixed                      |
| HA-03 | Medium                             | `GET /auth/me` for a deleted account answered 401 without the `WWW-Authenticate: Bearer` challenge | Fixed                      |
| HA-04 | Low                                | express-rate-limit printed its diagnostics, with stacks, to the console instead of the safe logger | Fixed                      |
| HA-05 | Medium                             | Per-request database work grows with the reader's own data, which has no quota or write throttling | Accepted; follow-up (§11)  |
| HA-06 | Low                                | Dev-only `minimatch` advisory (moderate) through the lint toolchain                                | Accepted; not shipped      |
| HA-07 | Informational                      | Unknown methods on root-mounted routers answer 404 before authentication; prefix-mounted ones 401  | Accepted                   |
| HA-08 | Informational                      | `//books`, `/%62ooks` and `;` path variants answer 404 without `no-store`                          | Accepted (no private data) |

### HA-01: destructive integration tests could reach a non-test database

- **Where.** `test/integration/setup.ts` connected to `process.env.MONGODB_TEST_URI` with the
  option `dbName: 'book-tracker-test'` and then ran `deleteMany({})` on all twelve collections
  before every test. The URI was never checked.
- **Reproduction (before the fix).** With `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/book-tracker-production`
  a child integration run **exited 0**: the `dbName` override silently redirected it to
  `book-tracker-test` and its cleanup deleted a sentinel the parent had planted. An SRV or remote
  URI would have been connected to the same way, with `deleteMany` run on that server.
- **Fix.** `scripts/local-database-target.ts` (`toLocalDisposableDatabaseUri`) generalizes the
  smoke runner's allowlist and is used by both destructive tools before any connection, index build
  or delete: `mongodb://` only, one host among `127.0.0.1`, `localhost`, `[::1]`, the exact database
  (`book-tracker-test` for `test/integration/test-database.ts`, `book-tracker-smoke` for
  `scripts/smoke/smoke-target.ts`; kept distinct), only `appName`, `authMechanism`, `authSource`,
  `connectTimeoutMS`, `directConnection`, `serverSelectionTimeoutMS`, and `directConnection=true`
  enforced. The requested database is validated, not overridden. Refusals name only the variable
  and the rule.
- **Tests.** `test/test-database-target.test.ts` (26 refused URIs including SRV, remote, look-alike
  and abbreviated hosts, several hosts, other or encoded database names, replica-set discovery in any
  case, load balancer, proxy, TLS, disabled direct connection; 5 accepted local forms; no
  connection is opened). `test/integration/test-database-guard.test.ts` runs a child suite with a
  refused URI and proves the sentinel, the indexes and the database list are untouched and the
  output carries no credential or host. The smoke tests keep passing on the shared helper.
- **Limit.** A tunnel or port forward on `localhost` can reach a remote server; no URI check can
  detect it (documented in README and decisions). No remote database was used to prove the guard.

### HA-02: export cursors leaked when a download stopped early

- **Where.** Every `stream*ForArchive` generator iterated `Model.find().sort().lean().cursor()` with
  `for await`. Mongoose's `QueryCursor[Symbol.asyncIterator]` returns the cursor itself, which has
  no `return()`, so when `BoundedExportWriter` threw `413 EXPORT_TOO_LARGE` inside the loop the
  server-side cursor was never closed.
- **Reproduction.** With 400 notes and `maxRecords: 50`, `$currentOp` with `idleCursors: true`
  showed one more idle cursor on `book-tracker-test.notes` after each oversized download, until
  MongoDB's 10-minute idle timeout. For sections sorted in memory (§8) the cursor also holds the
  sorted result. Any reader whose data exceeds a limit could accumulate them by repeating the
  request.
- **Fix.** `src/shared/archive-cursor.ts` `closingWhenDone(cursor)` closes the cursor in `finally`;
  all ten archive reads use it.
- **Tests.** `test/integration/export-limits.test.ts`: each of the five downloads leaves no idle
  cursor after a `413` (all five failed before the fix), plus a control that a deliberately open
  cursor is detected. `test/archive-cursor.test.ts` covers completion, early exit and a failing
  cursor.

### HA-03: missing Bearer challenge on a deleted account's `/auth/me`

- **Where.** `src/modules/auth/auth.routes.ts` threw `unauthenticatedError()` without
  `res.set('WWW-Authenticate', 'Bearer')`, contrary to the contract's `UNAUTHENTICATED` row.
- **Fix.** `rejectAsUnauthenticated(res)` in `auth.middleware.ts` sets the challenge and throws; the
  middleware, `/auth/me` and the export account check (`exportingProfileOf`) share it.
- **Tests.** `test/integration/current-user.test.ts` now asserts the challenge and `no-store` for a
  revoked, expired or missing session and a deleted user (the deleted-user case failed before);
  `test/route-security.test.ts` asserts it on all 67 private routes.

### HA-04: rate-limiter diagnostics bypassed the safe logger

- **Where.** express-rate-limit validates its configuration on the first request of each limiter and,
  by default, prints a `ValidationError` with a stack via `console.error`. A request carrying
  `X-Forwarded-For` (while `trust proxy` is off) triggered it. No secret was printed, but it bypassed
  the structured logger and the "name and code only" logging decision.
- **Fix.** `createAuthRateLimiters(limits, logger)` passes a `logger` that logs `{ err }` through the
  safe serializer (`ValidationError`, `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`).
- **Tests.** `test/security.test.ts` (no console output, a structured line with only name and code,
  no forwarded address, no stack). It failed before the fix with two `console.error` calls.

### HA-05: request cost is bounded only by the reader's own data (accepted)

All queries are owner-scoped and indexed (§8), so one reader never pays for another's data. But
several reads are linear in the reader's own data: the global notes and reading-history lists join
each record to its book before paging (2,000 notes: 4,000 documents examined, ≈100 ms locally), the
dashboard counts, text searches with an in-memory sort, and export sections without a
`{ ownerId, createdAt }` index sorted in memory before the record limit applies. There is no
per-reader quota and no throttling of authenticated writes, so an abusive account could grow its
data and make these requests expensive. At personal-library scale (the documented target) the
measured costs are small, and the exact-total semantics of the joined lists are intentional.
**Follow-up:** authenticated request throttling at the edge or app (PR #14, with the reverse proxy),
a product decision on per-reader quotas, and, if libraries grow by an order of magnitude, the
measured alternative in §8 (active book ids first, then indexed finds and covered counts).

### HA-06 to HA-08

- **HA-06.** `npm audit` (dev dependencies included) reports a moderate `minimatch` advisory via
  ESLint and typescript-eslint. It is lint tooling only; `npm audit --omit=dev` reports 0
  vulnerabilities. Its suggested fix downgrades typescript-eslint, so dependencies were not changed.
- **HA-07.** Copies, loans, reading, notes and organization routers are mounted at the API root
  with per-route authentication, so `PUT /api/v1/notes/:id` (no such route) is `404` without a
  token, while `/books`, `/locations` and the other prefix routers authenticate first (`401`). Route
  existence is public (Bruno, the contract), and no data is involved.
- **HA-08.** Express routing and the `no-store` middleware use the same matcher, so case and
  trailing-slash variants (`/API/V1/BOOKS`, `/books/`) are served **with** `no-store`; only paths
  that do not route at all (`//books`, `/%62ooks`, `/books;x`) miss it, and those are `404 Route not
found` with no data.

## 2. Endpoint inventory and authorization

`test/route-inventory.ts` reads the inventory from the Express router itself; the test fails if a
route is added without being classified. **73 routes: 6 public** (`/health`, `/ready`, `register`,
`login`, `refresh`, `logout`) **and 67 private**. Every owner id is taken from
`authenticatedUserOf(req).userId`; no schema accepts `ownerId`, `userId` or similar (strict Zod
objects; an `ownerId` field is `400 Unknown field`, also in Bruno `Security/Intruder names an owner`).

| Surface                    | Invariant                                                                                                                | Evidence                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| All private routes         | No, malformed, forged or duplicated credentials: `401`, Bearer challenge, `no-store`, exact envelope                     | `route-security.test.ts` (67 × 2), `current-user.test.ts`, Bruno `Security/Forged access token`                                     |
| All private routes         | Revoked session: `401` everywhere                                                                                        | `cross-owner-isolation.test.ts` "revoked sessions" (67)                                                                             |
| Every owner-scoped id      | A foreign id gets the same status and body as a missing one (request id aside); both readers' raw records byte-identical | `cross-owner-isolation.test.ts` (55 probes: path, body and query ids, both orders for memberships and acquisitions)                 |
| Every id route             | Malformed id: `400 VALIDATION_ERROR` naming exactly the path parameters, before any lookup                               | `cross-owner-isolation.test.ts` "malformed ids" (43)                                                                                |
| Books and duplicates       | No foreign details, search hits or suggestions                                                                           | `books-isolation.test.ts`, `planted-references.test.ts`                                                                             |
| Copies and locations       | Copy visible only with an active owned parent book; foreign location refused in body and filter                          | probes on `/books/:bookId/copies` and `/copies/:copyId`, `copy-races.test.ts`, `planted-references.test.ts`                         |
| Reading sessions           | Book owned and visible; hidden-book history excluded from ordinary reads                                                 | probes, `reading-access.test.ts`, `reading-races.test.ts`, `planted-references.test.ts`                                             |
| Notes                      | Session link must be the same owner and book; foreign book/session in body or filter refused                             | probes, `notes-access.test.ts` (cross-book and foreign-session cases), `planted-references.test.ts`                                 |
| Categories and collections | Owner-specific groups; foreign book or group refused; planted foreign members never listed                               | probes (both orders), `group-access.test.ts`, `planted-references.test.ts`                                                          |
| Wishlist                   | Acquisition needs an owned active book; planted foreign acquisition stays an opaque id                                   | probes (both orders), `wishlist-access.test.ts`, `planted-references.test.ts`                                                       |
| Loans                      | Owner-scoped only, survive parent deletion; foreign copy or loan refused                                                 | probes, `loans-access.test.ts`, `loans-races.test.ts`, Bruno `Security/*loan*`                                                      |
| Dashboard                  | Counts and activity owner-scoped; hidden books filtered before limits                                                    | `dashboard-access.test.ts`, `dashboard-activity.test.ts`, `planted-references.test.ts`                                              |
| Export                     | Only the owner's records; deleted-account guard on all five downloads; no credentials, tokens or internals               | `export-access.test.ts` (PR #12 five-download matrix kept), `planted-references.test.ts`, Bruno `Security/Intruder exports archive` |

`planted-references.test.ts` writes, through the driver only, records of reader A that point at
reader B's book, copy, location and reading session (notes, a session, copies, both group kinds, an
acquired wish and a loan), then requests 27 views of A, including dashboard and all five exports,
and checks that none of B's text appears and B's records are byte-identical.

## 3. Authentication and API perimeter (verified)

| Area                 | Verified protection                                                                                                                                                                        | Evidence                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Access tokens        | `jwtVerify` with `algorithms: ['HS256']`, issuer, audience, `typ: at+jwt`, required `sub`/`sid`/`iat`/`exp`, lowercase 24-hex ids; `alg: none` and HS512 refused                           | `access-token.test.ts`                                                   |
| Bearer parsing       | Exactly one `Authorization` header, `Bearer <three base64url parts>`, scheme case-insensitive; double space, `Token`, `Basic` refused                                                      | `current-user.test.ts`, `route-security.test.ts`                         |
| Sessions             | Every protected request checks an active, unexpired session of that user; logout is immediate                                                                                              | `sessions.test.ts`, revoked-session matrix                               |
| Refresh rotation     | Atomic `active → consumed`; replay revokes the session; concurrent refreshes yield at most one success then revocation; a guess revokes nothing                                            | `sessions.test.ts` (concurrency against real MongoDB)                    |
| Rotation race review | Consume, then session check, then insert of the new token: a failure between steps fails closed (the session ends at its next refresh); the partial unique index forbids two active tokens | `database-invariants.test.ts`, `sessions.test.ts`; no change needed      |
| Login                | Unknown account runs a dummy Argon2id verify; identical body for both failures                                                                                                             | `login.test.ts`                                                          |
| Registration         | Normalized-email unique index; concurrent duplicates create one user; 409 reveals existing emails (accepted decision)                                                                      | `registration.test.ts`, `database-invariants.test.ts`                    |
| Passwords            | Argon2id, 19 MiB, t=2, p=1; never trimmed                                                                                                                                                  | `registration.test.ts`                                                   |
| Rate limits          | Per address and per account windows; forged `X-Forwarded-For`, `Forwarded`, `X-Real-IP` do not open new buckets                                                                            | `rate-limits.test.ts`                                                    |
| CORS                 | Exact allowlist, no wildcard, `credentials: false`, preflight `204` with `no-store` on all private paths                                                                                   | `security.test.ts`, `route-security.test.ts`, `env.test.ts`              |
| Headers              | Helmet defaults, no `X-Powered-By`, `X-Request-Id` validated or replaced                                                                                                                   | `security.test.ts`                                                       |
| Bodies               | 100 kB JSON limit, applied to the **inflated** size (a 4.9 kB gzip or deflate body of 5 MB is `413`); malformed JSON `400` before authentication; bad charset or encoding `415`            | `route-security.test.ts`, `errors.test.ts`                               |
| Queries              | Strict schemas; repeated parameters refused (`must be given only once`); text search words stripped of operators                                                                           | per-module validation tests                                              |
| Privacy              | Logs carry method, path, status, request id and safe error name/code only; bodies, queries, tokens, borrower data, note text never logged                                                  | `security.test.ts`, `log-safety.test.ts` and the module log-safety tests |

**Deleted accounts.** Authentication proves the session, not that the user record exists. The
PR #12 export profile guard and its five-download suite are kept; `/auth/me` now sends the same
challenge. Other routes still do not load the user: their reads and writes are scoped to an owner
id whose records nothing deletes, and account deletion is not a product feature. This should be
revisited (revoke all sessions on deletion) when account deletion is designed.

**Reverse proxy.** `trust proxy` is off and stays off in this PR. Behind a proxy every client would
share the proxy's address bucket (a denial-of-service and throttling-bypass trade-off documented in
decisions). PR #14 must set `trust proxy` to the exact hop count or proxy addresses of the chosen
host, never `true`, then verify through the real proxy that a forged `X-Forwarded-For` does not
change the bucket and that the rate limiter's `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` warning is gone.

**Account-based throttling.** 10 failed logins per account per 15 minutes lets anyone who knows an
email delay that user's sign-in for up to 15 minutes. This is the documented trade-off against
unlimited guessing; the per-address limit (30) caps how many accounts one address can delay.

## 4. MongoDB integrity and concurrency

`test/integration/database-invariants.test.ts` reads the indexes MongoDB actually holds after
`syncIndexes` and pins every unique, partial and TTL index, and that every index of an owner-scoped
collection leads with `ownerId`:

| Invariant            | Safeguard (as built)                                                                     | Race / negative proof                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Registration email   | `users {email}` unique                                                                   | `registration.test.ts` concurrent duplicates; driver-level duplicate refused                                             |
| Refresh tokens       | `{tokenHash}` unique; `{sessionId}` unique where `status: active`; TTL                   | driver-level second active token refused; `sessions.test.ts` concurrent refresh                                          |
| Location names       | `{ownerId, normalizedName}` unique                                                       | `locations.test.ts` concurrent creates and renames; other reader may reuse                                               |
| Group names          | `{ownerId, normalizedName}` unique where `deletedAt: null`                               | `group-races.test.ts`, `group-indexes.test.ts` (deleted namesakes coexist)                                               |
| Memberships          | `$addToSet` / `$pull` on the active owned group                                          | `group-races.test.ts` (concurrent adds/removes, deleted group never resurrected)                                         |
| Book/copy format     | `hasPhysicalCopyHistory` reservation on the book document                                | `copy-races.test.ts`; stranded-flag failure mode in `operations.md`                                                      |
| Reading sessions     | `{ownerId, bookId}` unique where `status: in_progress`; revision CAS                     | `reading-races.test.ts` (20 concurrent starts, CAS, no reopening)                                                        |
| Wishlist acquisition | Conditional `wanted → acquired` update                                                   | `wishlist-races.test.ts` (20 acquisitions over two books, idempotent repeat)                                             |
| Loans                | `{ownerId, copyId}` unique where `returnedOn: null` (also matches missing); revision CAS | `loans-races.test.ts` (25 concurrent lends per round, return/PATCH races, 5-attempt exhaustion), `loans-indexes.test.ts` |
| Notes                | Owner and not-deleted filter repeated in every write                                     | `notes-races.test.ts` (PATCH vs DELETE never resurrects)                                                                 |
| Export               | Record and byte guards before any byte is sent; cursors closed                           | `export-limits.test.ts` (exact boundaries, multi-byte, five downloads, cursor closure)                                   |

Book deletion never removes children, and loans stay listed and returnable after their copy or book
is deleted (`loans-races.test.ts`, `loans-history.test.ts`). The accepted non-transactional windows
(a child added while its parent is deleted stays hidden or historical) and the unreconciled
historical loan intervals (PR #10) are unchanged and remain documented in `decisions.md`.

## 5. Destructive test safety

See HA-01. Both destructive commands now refuse anything but one local host and their own database
before connecting. CI keeps `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/book-tracker-test` and
`MONGODB_SMOKE_URI=mongodb://127.0.0.1:27017/book-tracker-smoke`, which pass the guard. Production
`MONGODB_URI` validation (`src/config/env.ts`) is unchanged.

## 6. Failure, lifecycle and operations

- `/health` stays `200` and `/ready` turns `503` (with `no-store` and the safe envelope) during a
  real `mongoose.disconnect()`, and `200` again after reconnecting (`readiness.test.ts`), in addition
  to the mocked connection states in `health.test.ts`.
- Startup validation names only the variable and rule; the JWT secret must decode to ≥ 32 bytes
  with ≥ 16 distinct byte values (`env.test.ts`). The MongoDB URI is never logged (`mongo.test.ts`).
- Shutdown (`server.ts`): stop retrying, close HTTP (in-flight requests finish), await a pending
  connection attempt (bounded by the 5 s server selection timeout), disconnect, all under a 10 s
  forced exit; errors logged through the safe serializer. No change needed. Process supervision,
  probes and timeouts on the host belong to PR #14.
- `no-store` covers all twelve private prefixes for success, errors raised before routing, auth
  failures and preflight (`route-security.test.ts`, existing module tests). Request ids survive
  every failure path asserted above.
- Dashboard and exports write nothing (`dashboard-access.test.ts`, `export-access.test.ts`); every
  foreign-id probe leaves both readers' raw records byte-identical.
- Dependencies: `npm audit --omit=dev` 0 vulnerabilities. CI permissions are `contents: read`;
  actions are pinned to major versions (`actions/checkout@v7`, `actions/setup-node@v7`); Node
  is pinned by `.nvmrc` with `engine-strict`; the Bruno CLI is pinned to `4.3.0`. CI now runs
  `npm audit --omit=dev --audit-level=high` in the verify job. No dependency was changed.

## 7. Rejected false alarms

- **"Category names allow duplicates because the partial index uses `deletedAt: null`."** MongoDB
  accepts the `null` equality in a partial filter and it matches active groups (and missing fields);
  verified on real MongoDB (`group-indexes.test.ts`, `database-invariants.test.ts`).
- **"A gzip body bypasses the 100 kB limit."** The limit applies to the inflated stream (§3). An
  early probe answered `400` only because the probe itself sent a JSON-serialized Buffer.
- **"Case-variant paths escape `no-store`."** They route and get `no-store` (HA-08).
- **"Concurrent refresh can leave two active tokens."** The partial unique index on
  `{ sessionId }` where `status: active` forbids it at the database level.
- **"Loan PATCH can reopen a returned loan."** `returnedOn` is not nullable in the PATCH schema and
  `problemWithReturnDateCorrection` refuses setting it on an active loan.
- **"Notes can be moved to another book or session."** `bookId`, `readingSessionId` and `kind` are
  immutable in the model and absent from the PATCH schema.

## 8. Query and index measurements

Measured with the MongoDB profiler on the real endpoints (`query-scalability.test.ts`;
`QUERY_PLAN_REPORT=1` prints the full table) for a reader with **300 books (20 deleted), 300 copies,
1,000 reading sessions, 2,000 notes, a 300-member category and collection, 200 wishes and 500
loans**, a second reader with the same amount of noise, and a tiny third reader. MongoDB 7.0.32,
local. Docs = documents examined, Keys = index keys examined.

| Query (endpoint)                   | Dominant operation and plan                                      | Keys  | Docs  | Returned | In-memory sort  |
| ---------------------------------- | ---------------------------------------------------------------- | ----- | ----- | -------- | --------------- |
| `GET /books?page=2`                | find, `owner_active_recent`; count is `COUNT_SCAN`               | 40    | 40    | 20       | no              |
| `GET /books?sort=title_asc&page=3` | find, `owner_active_title`                                       | 60    | 60    | 20       | no              |
| `GET /books?q=…`                   | text, `owner_active_text`                                        | 280   | 280   | 20       | yes             |
| `GET /books/duplicate-check`       | find, `owner_active_title`                                       | 3     | 1     | 1        | yes             |
| `GET /books/:id/copies`            | find, `owner_book_active_recent`                                 | 1     | 1     | 1        | no              |
| `GET /reading-sessions?page=3`     | aggregate, `owner_recent`, active-book `$lookup` per session     | 2,000 | 2,000 | 20       | no              |
| `GET /books/:id/reading-sessions`  | find, `owner_book_recent`                                        | 4     | 4     | 4        | no              |
| `GET /notes?page=5`                | aggregate, `owner_active_recent`, `$lookup` per note             | 4,000 | 4,000 | 20       | no              |
| `GET /notes?q=…`                   | aggregate, `owner_active_text`, `$lookup` per hit                | 4,000 | 4,000 | 20       | yes             |
| `GET /notes?chapter=…`             | aggregate, an owner-led note index (planner choice)              | 2,168 | 2,167 | 20       | yes             |
| `GET /categories/:id/books?page=3` | group by id, then find of all 280 visible members                | 281   | 281   | 20       | no              |
| `GET /wishlist`                    | find, `owner_active_status_recent`                               | 20    | 20    | 20       | no              |
| `GET /wishlist?sort=priority`      | find, `owner_active_priority`                                    | 26    | 26    | 20       | no              |
| `GET /loans` (active)              | find, `owner_returned_recent`                                    | 20    | 20    | 20       | no              |
| `GET /loans?status=returned`       | count, `owner_recent` with a `returnedOn` filter                 | 500   | 500   | 1        | no              |
| `GET /dashboard/summary`           | 10 queries; largest: notes count 2,300, sessions tally 1,300     | 2,301 | 2,300 | 2        | no              |
| `GET /dashboard/recent-activity`   | 5 limited reads; newest wishes via `owner_active_title` + top-20 | 2,020 | 2,020 | 20       | wishes only     |
| `GET /export/archive`              | 10 cursors; notes section via `owner_active_recent` + sort       | 2,000 | 2,000 | 2,000    | 7 of 9 sections |

Observations:

- **No collection scans; every scan is led by `ownerId`** (or `_id` for an owned point lookup). The
  noise reader's ~4,300 documents are never examined. Asserted for 27 endpoint query shapes; the assertions
  do not pin one index where MongoDB 7 and 8 may choose differently.
- **Paged finds examine about `page × limit`** documents (asserted for books, title sort, wishlist and
  active loans). Totals are counted before paging; counts on index prefixes are `COUNT_SCAN`.
- **Query counts are constant**: identical for the 300-book and the 3-book reader on every endpoint
  (cursor batches excluded), so there is no N+1 in the dashboard, export, group, notes, reading or
  loan reads.
- **Linear in the owner's data**: global notes and reading history (one `$lookup` per record before
  paging, by design so totals are exact), dashboard counts, text search sorting, and the export's
  in-memory sorts of books, locations, copies, notes, wishes, categories and collections (no
  `{ ownerId, createdAt }` index for those collections; adding seven indexes for an occasional export
  was judged not worth the write cost). An archive with 25,000 small notes stopped at a 50-record
  limit in about 70 ms locally. See HA-05.
- **Measured alternative, not implemented:** read the owner's active book ids once (covered by
  `owner_active_recent`), then page notes or sessions with `bookId: { $in: … }` and count with a
  `COUNT_SCAN` over `owner_book_active_recent`. That would make the global lists O(page) instead of
  O(records), at the cost of a second query and a snapshot of active books per request. Worth doing
  only if libraries grow well beyond personal scale.
- Group member pages load every visible member (`listActiveBooksInMembershipOrder`), as documented;
  280 members cost 28 ms.

## 9. Test strategy added

| File                                                                      | Protects                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `test/route-inventory.ts`, `route-security.test.ts`                       | Every route classified; private routes refuse bad credentials; `no-store` on preflight and malformed JSON; inflated-size body limit |
| `integration/cross-owner-isolation.test.ts`                               | Foreign = missing for every owner-scoped reference; no writes; malformed ids; revoked sessions                                      |
| `integration/planted-references.test.ts`                                  | Inconsistent cross-owner rows never leak content into any view                                                                      |
| `integration/database-invariants.test.ts`                                 | Unique, partial and TTL indexes as built; `ownerId` leads every owner-scoped index                                                  |
| `integration/query-scalability.test.ts`                                   | Owner-led plans, no scans, bounded paging, constant query counts (profiler)                                                         |
| `integration/readiness.test.ts`                                           | Liveness and readiness across a real disconnect and reconnect                                                                       |
| `test-database-target.test.ts`, `integration/test-database-guard.test.ts` | Destructive test target guard, without connecting and end to end                                                                    |
| `integration/export-limits.test.ts` (extended), `archive-cursor.test.ts`  | Cursor closure on early stop                                                                                                        |
| `security.test.ts`, `rate-limits.test.ts` (extended)                      | Limiter diagnostics through the safe logger; forged forwarding headers                                                              |
| `bruno/Security/` (20 requests)                                           | Representative runnable cross-reader checks                                                                                         |

## 10. Mutation checks

Each mutation removed one protection, ran only the tests meant to catch it, and restored the file
(checksums verified afterwards). 21 of 22 were caught.

| ID  | Mutation                                                              | Result   | Caught by                                                                                                                                                |
| --- | --------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Owner filter removed from single-book lookups (`activeBookOwnedBy`)   | Caught   | cross-owner probes GET, PATCH, DELETE `/books/:bookId`                                                                                                   |
| M02 | Owner filter removed from loan lookups (`loanOwnedBy`)                | Caught   | cross-owner probes GET, PATCH, return of `/loans/:loanId`                                                                                                |
| M03 | Owner filter removed from group member books                          | Caught   | `planted-references.test.ts` (both tests)                                                                                                                |
| M04 | Active-book join removed from the global notes list                   | Caught   | `planted-references.test.ts`                                                                                                                             |
| M05 | Owner filter removed from the book list                               | Caught   | `planted-references.test.ts`, `query-scalability.test.ts` (collection scan)                                                                              |
| M06 | `unique` removed from the active-loan partial index                   | Caught   | `database-invariants.test.ts`                                                                                                                            |
| M07 | Revision guard removed from loan PATCH                                | Caught   | `loans-races.test.ts` (PATCH and return race)                                                                                                            |
| M08 | `status: 'wanted'` guard removed from wish acquisition                | Caught   | `wishlist-races.test.ts` (twenty acquisitions)                                                                                                           |
| M09 | `returnedOn: null` removed from the return write, revision guard kept | Survived | Equivalent under the revision CAS: every loan write increments `revision`, and the return re-reads `returnedOn` first, so the filter is defence in depth |
| M10 | Session check removed from authentication                             | Caught   | revoked-session matrix (all 67 routes)                                                                                                                   |
| M11 | Bearer challenge removed from `rejectAsUnauthenticated`               | Caught   | `route-security.test.ts` (134 tests)                                                                                                                     |
| M12 | `*.password` redaction removed                                        | Caught   | `security.test.ts`                                                                                                                                       |
| M13 | Rate-limiter `logger` removed (console again)                         | Caught   | `security.test.ts`                                                                                                                                       |
| M14 | `trust proxy` enabled                                                 | Caught   | `rate-limits.test.ts` forged forwarding headers                                                                                                          |
| M15 | `/export` dropped from the `no-store` prefixes                        | Caught   | `route-security.test.ts` (15 export tests)                                                                                                               |
| M16 | Authentication removed from `GET /loans`                              | Caught   | `route-security.test.ts`                                                                                                                                 |
| M17 | Local-host check removed from the database guard                      | Caught   | `test-database-target.test.ts`, `api-smoke.test.ts` (12 tests)                                                                                           |
| M18 | Integration setup connects with the raw URI                           | Caught   | `test-database-guard.test.ts` (sentinel deleted)                                                                                                         |
| M19 | Export record limit not enforced                                      | Caught   | `export-limits.test.ts` (7 tests)                                                                                                                        |
| M20 | Archive cursor not closed                                             | Caught   | `export-limits.test.ts` (all five downloads)                                                                                                             |
| M21 | A book index no longer led by `ownerId`                               | Caught   | `database-invariants.test.ts`                                                                                                                            |
| M22 | Revision guard removed from reading-session PATCH                     | Caught   | `reading-races.test.ts` (2 tests)                                                                                                                        |

Before-fix failures of the four fixed findings were also observed directly: the guard test against
the previous `setup.ts` (child run exited 0 and deleted the sentinel), the five cursor tests, the
deleted-user challenge assertion and the console assertion.

## 11. Residual risks and follow-ups

| Item                                                                                            | Owner                       |
| ----------------------------------------------------------------------------------------------- | --------------------------- |
| Configure `trust proxy` for the real proxy hops and verify forged forwarding headers through it | PR #14                      |
| Shared rate-limit store before running more than one API instance                               | PR #14                      |
| Authenticated request throttling (edge or app) and a per-reader quota decision (HA-05)          | PR #14 / product decision   |
| Build indexes before traffic (`syncIndexes` is a test-only step); controlled rollout            | PR #14                      |
| Server timeouts, process supervision, probes, backups and restore drills                        | PR #14                      |
| Revoke sessions when account deletion is designed (only exports and `/auth/me` load the user)   | Account deletion feature    |
| Pin GitHub Actions to commit SHAs if the supply-chain policy requires it                        | PR #14 (optional)           |
| Browser refresh-token storage (HttpOnly cookie, CSRF, CORS change)                              | Before the frontend auth PR |
| O(page) global notes and reading lists if libraries grow far beyond personal scale (§8)         | Later, on measurement       |
| Historical loan intervals are not reconciled across loans of one copy (PR #10)                  | Needs a product policy      |

### Status of the PR #14 follow-ups (recorded in PR #14)

| Follow-up                              | State after PR #14                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trust proxy` for the real proxy hops  | `TRUST_PROXY_HOPS` (default 0) implemented and tested through a local appending proxy; **the real host's hop count is pending the first approved staging deployment** |
| Shared rate-limit store                | Not added: exactly one instance is a documented deployment constraint, logged at start; a shared store is a future, approved decision                                 |
| Authenticated throttling / HA-05 quota | Per-reader limit implemented, **off by default** pending the owner's value; no stored-record quota                                                                    |
| Indexes before traffic                 | Production never builds indexes on connect; `/ready` requires them; `npm run db:indexes` (read-only, additive `--apply`); tested on disposable databases              |
| Timeouts, probes, supervision          | HTTP timeout policy, draining shutdown and subprocess lifecycle tests; host grace periods documented, **host behaviour pending staging**                              |
| Backups and restore drills             | `npm run db:backup` and `npm run db:restore-rehearsal` with CI drill on MongoDB 8.0; **no backup of a shared database exists yet**                                    |
| Pin GitHub Actions to commit SHAs      | Not done; still optional                                                                                                                                              |
