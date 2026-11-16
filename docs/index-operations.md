# Index operations

MongoDB indexes enforce several of the API's invariants, not only its speed. The unique ones decide
races that application code cannot: one active loan per copy, one in-progress reading session per
book, one active refresh token per session, one account per email and unique names per reader. An
API serving traffic without them can, for example, lend the same copy twice under concurrent
requests. This document is the release-blocking procedure for preparing indexes on any shared
database (staging or production).

Status: **tooling implemented and tested on disposable local databases only.** No command in this
document has been run against Atlas or any shared database. Every step below on a real database
needs the owner's approval (see [release-checklist.md](release-checklist.md)).

## Rules

1. **Never run `syncIndexes()`, `cleanIndexes()` or `dropIndex` against a shared database.**
   `syncIndexes()` drops every index the current schemas do not define. It is used only by the
   integration test setup against the guarded local `book-tracker-test` database. A unit test
   (`test/index-safety.test.ts`) fails if application or operator code references any of these.
2. **Serving traffic never builds or changes an index.** In production (`NODE_ENV=production`) the
   API connects with `autoIndex: false` and `autoCreate: false`. Development and tests keep
   Mongoose's automatic, additive builds for convenience.
3. **The API reports ready only after a read-only check finds every required index.** After
   connecting, `src/db/index-readiness.ts` compares MongoDB's indexes with the schemas
   (`Model.diffIndexes()`, which only lists indexes). Until nothing is missing or conflicting,
   `/api/v1/ready` answers `503 SERVICE_UNAVAILABLE` with the message
   `Service is not ready: required database indexes are not verified`, and the log names each
   problem (collection, index name, `missing` or `conflicting`; never data or the URI). The check
   repeats every 30 seconds, so building the indexes makes the API ready without a restart. Hosts
   that gate traffic on the readiness path (Render, Railway) therefore never route to an instance
   whose invariants are not enforced.
4. **Index changes are additive and manual.** `npm run db:indexes -- --apply` only builds missing
   indexes. It refuses to start while any required index conflicts with an existing one, never
   drops, hides or replaces an index, and stops on documents that violate a unique index instead
   of deleting anything.
5. **No index command runs from CI, deployment hooks, a pre-deploy command or request handling.**

## Commands

Both read `MONGODB_URI` from the environment, never from `.env`, and print only database,
collection and index names. Run them from a checkout of the exact commit being released, after
`npm ci`.

| Command                                                   | Effect                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run db:indexes`                                      | Read-only diff. Exit `0` if every required index exists; `1` if any is `missing` or `conflicting`. `unexpected` indexes (not in the schemas) are listed, not fatal |
| `npm run db:indexes -- --apply --confirm-database=<name>` | Builds missing indexes only. `<name>` must equal the database named in `MONGODB_URI`, so a URI pasted from the wrong environment is refused before any write       |

`MONGODB_URI` must name the database explicitly (`.../book-tracker?...`); a URI without one is
refused, because the driver would silently use a database called `test`.

Use a database user that can create indexes (`dbAdmin` on the application database, or a custom
role with `createIndex` and `listIndexes`) for `--apply` only, and the API's least-privilege
`readWrite` user for the read-only check. Remove the temporary privilege afterwards.

## Required indexes

Derived from the Mongoose schemas (`requiredIndexesOf()` in `src/db/index-verification.ts`); a
unit test fails if this table and the schemas disagree. `_id` indexes are implicit and not
listed. **Bold** rows enforce an invariant; the others serve owner-scoped queries.

| Collection        | Index                               | Keys                                                                        | Options                                                              |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `users`           | **`email_1`**                       | `{ email: 1 }`                                                              | unique                                                               |
| `sessions`        | `userId_1`                          | `{ userId: 1 }`                                                             | —                                                                    |
| `sessions`        | **`expiresAt_1`**                   | `{ expiresAt: 1 }`                                                          | TTL `expireAfterSeconds: 0`                                          |
| `refreshtokens`   | **`tokenHash_1`**                   | `{ tokenHash: 1 }`                                                          | unique                                                               |
| `refreshtokens`   | **`sessionId_1`**                   | `{ sessionId: 1 }`                                                          | unique, partial `{ status: 'active' }`                               |
| `refreshtokens`   | **`expiresAt_1`**                   | `{ expiresAt: 1 }`                                                          | TTL `expireAfterSeconds: 0`                                          |
| `books`           | `owner_active_recent`               | `{ ownerId: 1, deletedAt: 1, createdAt: -1, _id: -1 }`                      | —                                                                    |
| `books`           | `owner_active_title`                | `{ ownerId: 1, deletedAt: 1, normalizedTitle: 1, _id: 1 }`                  | —                                                                    |
| `books`           | `owner_active_isbn`                 | `{ ownerId: 1, deletedAt: 1, normalizedIsbn: 1 }`                           | partial `{ normalizedIsbn: { $exists: true } }`                      |
| `books`           | `owner_active_text`                 | `{ ownerId: 1, deletedAt: 1, title: 'text', authors: 'text' }`              | `default_language: 'none'` (search fails without it)                 |
| `locations`       | **`owner_unique_name`**             | `{ ownerId: 1, normalizedName: 1 }`                                         | unique                                                               |
| `physicalcopies`  | `owner_book_active_recent`          | `{ ownerId: 1, bookId: 1, deletedAt: 1, createdAt: -1, _id: -1 }`           | —                                                                    |
| `physicalcopies`  | `owner_location_active`             | `{ ownerId: 1, locationId: 1, deletedAt: 1 }`                               | —                                                                    |
| `readingsessions` | `owner_book_recent`                 | `{ ownerId: 1, bookId: 1, createdAt: -1, _id: -1 }`                         | —                                                                    |
| `readingsessions` | `owner_status_recent`               | `{ ownerId: 1, status: 1, createdAt: -1, _id: -1 }`                         | —                                                                    |
| `readingsessions` | `owner_recent`                      | `{ ownerId: 1, createdAt: -1, _id: -1 }`                                    | —                                                                    |
| `readingsessions` | **`owner_book_single_in_progress`** | `{ ownerId: 1, bookId: 1 }`                                                 | unique, partial `{ status: 'in_progress' }`                          |
| `notes`           | `owner_book_active_recent`          | `{ ownerId: 1, bookId: 1, deletedAt: 1, createdAt: -1, _id: -1 }`           | —                                                                    |
| `notes`           | `owner_active_recent`               | `{ ownerId: 1, deletedAt: 1, createdAt: -1, _id: -1 }`                      | —                                                                    |
| `notes`           | `owner_session_active_recent`       | `{ ownerId: 1, readingSessionId: 1, deletedAt: 1, createdAt: -1, _id: -1 }` | —                                                                    |
| `notes`           | `owner_active_text`                 | `{ ownerId: 1, deletedAt: 1, title, content, commentary, chapter: 'text' }` | `default_language: 'none'`                                           |
| `categories`      | **`owner_active_unique_name`**      | `{ ownerId: 1, normalizedName: 1 }`                                         | unique, partial `{ deletedAt: null }`                                |
| `categories`      | `owner_active_alphabetical`         | `{ ownerId: 1, deletedAt: 1, normalizedName: 1, _id: 1 }`                   | —                                                                    |
| `categories`      | `owner_active_books`                | `{ ownerId: 1, deletedAt: 1, bookIds: 1 }`                                  | —                                                                    |
| `bookcollections` | **`owner_active_unique_name`**      | `{ ownerId: 1, normalizedName: 1 }`                                         | unique, partial `{ deletedAt: null }`                                |
| `bookcollections` | `owner_active_alphabetical`         | `{ ownerId: 1, deletedAt: 1, normalizedName: 1, _id: 1 }`                   | —                                                                    |
| `bookcollections` | `owner_active_books`                | `{ ownerId: 1, deletedAt: 1, bookIds: 1 }`                                  | —                                                                    |
| `wishlistitems`   | `owner_active_status_recent`        | `{ ownerId: 1, deletedAt: 1, status: 1, createdAt: -1, _id: -1 }`           | —                                                                    |
| `wishlistitems`   | `owner_active_title`                | `{ ownerId: 1, deletedAt: 1, normalizedTitle: 1, _id: 1 }`                  | —                                                                    |
| `wishlistitems`   | `owner_active_priority`             | `{ ownerId: 1, deletedAt: 1, priorityRank: 1, createdAt: -1, _id: -1 }`     | —                                                                    |
| `wishlistitems`   | `owner_active_text`                 | `{ ownerId: 1, deletedAt: 1, title, authors, note: 'text' }`                | `default_language: 'none'`                                           |
| `loans`           | **`owner_copy_single_active`**      | `{ ownerId: 1, copyId: 1 }`                                                 | unique, partial `{ returnedOn: null }` (also matches a missing date) |
| `loans`           | `owner_copy_recent`                 | `{ ownerId: 1, copyId: 1, createdAt: -1, _id: -1 }`                         | —                                                                    |
| `loans`           | `owner_recent`                      | `{ ownerId: 1, createdAt: -1, _id: -1 }`                                    | —                                                                    |
| `loans`           | `owner_returned_recent`             | `{ ownerId: 1, returnedOn: 1, createdAt: -1, _id: -1 }`                     | —                                                                    |

A **conflicting** index has a required name but other keys or options: for example
`owner_copy_single_active` without `unique`, without its partial filter, or `sessions.expiresAt_1`
with another TTL. It looks present but does not enforce the rule, so it blocks readiness exactly
like a missing one.

## Operator sequence for a shared database

Before the first deployment and before every release whose diff touches a `*.model.ts` index:

1. **Backups first.** Confirm a verified backup from the last 24 hours and a passing restore
   rehearsal ([backup-and-restore.md](backup-and-restore.md)).
2. **Read-only inventory.** `MONGODB_URI=<least-privilege URI> npm run db:indexes`. Record the
   output (names only) in the release notes.
3. **Approval.** The owner approves the exact list of indexes to build and a window. On a database
   with data, builds take locks briefly at start and end and use CPU and I/O; Atlas M0/Flex have
   small throughput budgets, so choose a quiet time.
4. **Build.** `MONGODB_URI=<index-builder URI> npm run db:indexes -- --apply --confirm-database=<name>`.
5. **Verify.** Run the read-only check again (exit `0`). In `mongosh`, `db.loans.getIndexes()`
   must show `owner_copy_single_active` with `unique: true` and the partial filter.
6. **Deploy** the compatible application version; the host's health check on `/api/v1/ready`
   passes only once step 5 holds.
7. **Smoke** with the non-destructive checklist in [deployment-runbook.md](deployment-runbook.md).

**First deployment on an empty database:** the collections do not exist yet; step 4 creates them
together with their indexes in seconds. Do it before the first deploy, otherwise the first instance
stays not ready (by design) and the host cancels the deploy.

## When a build fails

- **`existing_documents_violate_a_unique_index`**: documents already break the invariant (for
  example two active loans for one copy, possible only if the index was missing while traffic was
  served). **Stop.** Do not delete anything, and keep the API not ready or writes stopped. Find the
  offending groups read-only, e.g.
  `db.loans.aggregate([{ $match: { returnedOn: null } }, { $group: { _id: { ownerId: '$ownerId', copyId: '$copyId' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`,
  record them, and decide each case with the owner; reconcile through the API's own operations
  (for example returning one loan) where possible, then build again.
- **`conflicting`**: an index with the required name has other options. `--apply` refuses to run.
  Replacing it is a manual, reviewed change: build the correct index under a temporary name first
  so the invariant stays enforced, then drop the wrong one, then rename by rebuilding if needed.
  Never drop a unique index before its replacement exists.
- **`unexpected`**: an index the schemas do not define (an operator's index or a leftover from an
  older release). Not fatal; decide later whether to keep it. Nothing drops it automatically.

## Rolling back

- Code rollbacks never need an index rollback. New indexes are additive, and older code ignores
  indexes it does not query, so **do not drop a newly built unique index to roll back code**.
- If a release removes an index from a schema, the old index shows as `unexpected` and keeps
  working; drop it only in a later, separately approved change once no deployed version relies
  on it.
- If a release changes an index's options, ship it as a new index name, build it before deploying,
  and treat the old one as `unexpected` afterwards.

## Evidence (local, disposable databases)

- `test/integration/index-verification.test.ts`: empty database reports all 35 missing and creates
  nothing; a dropped `owner_copy_single_active` is named; non-unique, partial-less, wrong partial
  and wrong TTL variants are `conflicting`; an extra index is `unexpected`, not blocking, not
  dropped; production connection options build nothing on connect; `--apply` builds only what is
  missing, refuses while a conflict exists, and stops without deleting on duplicate active loans.
- `test/integration/index-readiness.test.ts`: `/ready` stays `503` while
  `owner_book_single_in_progress` is missing and turns `200` after it is built, with no restart;
  a conflicting refresh-token index never becomes ready.
- `test/integration/db-indexes-command.test.ts`: the command's exit codes, refusals, confirmation
  and that it never prints the URI.
- `test/integration/process-lifecycle.test.ts`: the real server process in production mode stays
  not ready with a missing unique index and does not build it.

CI runs these against MongoDB 8.0; local runs used MongoDB 7.0. **Pending:** the same read-only
check against the first approved staging database.
