# Product invariants and decisions

These rules constrain every future module. Changing one needs an explicit decision recorded here.

## Invariants

1. **User data isolation.** Every record belongs to exactly one user (`ownerId`). Every query
   filters by the authenticated user's id taken from the verified token, never from a
   client-supplied `userId` in the path, query or body. Requests for another user's record return
   404, so record existence is not revealed.

2. **Title is separate from copy.** A _book_ is a catalogue entry (title, authors, format,
   optional ISBN, optional external cover URL). A _copy_ is one physical item the user owns. One
   book can have many copies, and several copies may share the same location (for example
   "Home"). Copy-level facts (location, condition, loans) live on the copy, not the book.

3. **Reading history is preserved.** Each read of a book is its own _reading session_. Rereading
   creates a new session; it never overwrites or resets an earlier one.

4. **Loan availability is derived.** A copy is "on loan" if and only if it has an active loan
   (no return date). There is no separately stored `isAvailable` flag that could drift. At most
   one active loan per copy, enforced in the database by a partial unique index and covered by
   concurrency tests. Returned loans are kept as history.

5. **Completion fields are optional.** Notes, ratings, completion dates and summaries may be left
   empty. Validation must accept missing values; nothing is required just to mark progress.

6. **No file storage in v1.** The API stores no uploaded images, PDFs or ebook files. Covers are
   external URLs only. An ebook is a catalogue entry with `format: "ebook"`, not a stored file.

7. **Data is exportable and history is not silently lost.** Users can export everything they own
   in a portable format. Reading notes and history are never deleted as a side effect of another
   operation (for example removing a copy). Deleting them requires an explicit user action.

## Technical decisions

- **Modular monolith, MongoDB + Mongoose, Express, Zod.** See [architecture.md](architecture.md).
- **Bruno instead of Swagger/OpenAPI** for API documentation and executable examples, committed
  as `.bru` files beside the code.
- **Response envelope:** `{ data }` for success, `{ error: { code, message, requestId, details? } }`
  for errors. Unexpected errors are reported as a generic 500. Status codes, envelopes,
  pagination, dates and IDs are specified in the [API contract](api-contract.md); the envelope
  types live in `src/shared/api-response.ts`.
- **Error logging is allowlisted:** errors are always logged under `err`, which the logger reduces
  to the error class name and a machine-readable code (for example `ECONNREFUSED`). Messages,
  stacks and causes are never logged because they can embed credentials or MongoDB connection
  strings, and field redaction cannot see inside them. Use the request id to correlate.
- **Liveness vs readiness:** `/health` never depends on MongoDB; `/ready` is 200 only while the
  Mongoose connection is fully connected.
- **Search:** owner-scoped MongoDB text indexes. No separate search service unless it becomes
  necessary.
- **Node.js 26.x LTS:** the original brief specified 24.x, but Node 26 entered Active LTS on
  2026-10-28 (Node 24 is now Maintenance LTS), so the project starts on 26 for the longer support
  window. Pinned in `.nvmrc`, `engines` (with `engine-strict`) and CI via `.nvmrc`.
- **TypeScript 6.0, not 7.x:** typescript-eslint (type-aware linting) supports TypeScript below
  6.1 only. Upgrade once it supports 7.x.
- **CORS without credentials:** the API uses bearer tokens, so cookies are not enabled
  cross-origin. Revisit together with the browser token-storage decision below.

## Authentication decisions

Details and exact responses are in the [API contract](api-contract.md#authentication-and-session-tokens).

- **Bearer tokens in JSON:** register and login return a 15-minute HS256 JWT access token and an
  opaque refresh token in the response body; refresh and logout take the refresh token in the
  request body. This suits API clients and Bruno and avoids designing cookie, CSRF and CORS
  behaviour before the frontend's hosting model is known.
- **Browser token storage is not decided.** The frontend must not keep refresh tokens in
  `localStorage` or `sessionStorage`. Before production web sign-in, choose a design (likely an
  HttpOnly, Secure, SameSite refresh cookie with CSRF protection and an explicit CORS change).
- **Passwords:** Argon2id via `@node-rs/argon2` with the OWASP minimum parameters
  (19 MiB memory, 2 iterations, parallelism 1); about 12 ms per hash on a developer laptop.
  The parameters are stored in each hash, so they can be raised later without breaking logins.
  Passwords are never trimmed or altered.
- **Server-side sessions:** each login creates a fixed-size session record (user, absolute
  30-day expiry, revocation fields). Every refresh token the session issues gets its own record
  (SHA-256 digest, `active` or `consumed`, expiry equal to the session's). Rotation consumes the
  presented token with one atomic `findOneAndUpdate` (`active` → `consumed`), so concurrent
  refreshes cannot both succeed; a partial unique index allows only one `active` token per
  session. Protected routes also check that the session is active, so logout is immediate.
- **Refresh-token reuse revokes the session.** A reused token proves a copy exists somewhere, so
  the whole session is revoked. The cost: a client that sends two refreshes concurrently loses
  its session. Only digests of tokens a session actually issued can trigger revocation, so a
  guessed token cannot revoke anyone else's session. Consumed-token records are kept until the
  session expires, so detection covers the whole session lifetime; a TTL index then deletes them
  with the session, so storage is bounded by the session lifetime and the refresh rate limits.
- **Registration reveals existing emails** through `409 CONFLICT`. Accepted for the MVP;
  revisit when email verification is added. Registration is throttled per address.
- **No email verification yet.** Accounts are active immediately; email ownership is unproven.
- **Throttling is in memory, per instance** (`express-rate-limit`). With several instances each
  keeps its own counters, so effective limits multiply; move to a shared store before scaling
  out. Behind a reverse proxy, configure Express `trust proxy` or every client shares one
  address bucket.

## Book catalogue decisions

- **A book is a catalogue entry, not a copy.** Physical copies, condition, location and loans
  belong to later modules. Books store no reading status; a book with no reading sessions is
  unread, and acquisition dates are never used to infer past reading.
- **Soft deletion preserves history.** Deleting a book sets `deletedAt` and hides it from every
  book endpoint; the record stays so that future reading sessions, notes, copies and loans that
  reference it are never destroyed or orphaned by a catalogue delete (invariant 7). Future modules
  must not cascade-delete history when a book is deleted. Restore and permanent purge are not
  implemented; purging will need its own explicit, user-initiated design.
- **Duplicates are allowed and only suggested.** No unique index on title or ISBN; the
  duplicate check matches normalized title (case and whitespace, punctuation kept) and ISBN
  (case, spaces, hyphens) and never blocks creation.
- **ISBNs are stored as entered** (trimmed). They are not validated as ISBN-10/13 checksums,
  because readers catalogue older and regional editions with non-standard identifiers.
- **Search is MongoDB text search without language rules** (`default_language: 'none'`): whole
  words, any word matches, no stemming or stop words, so short titles such as "It" are findable
  and non-English titles are not mangled. No external search service.
- **Owner scoping is enforced in every query and by the indexes.** All book indexes lead with
  `ownerId, deletedAt`; the text index is compound with that prefix, so MongoDB refuses a text
  search that is not scoped to one owner.
- **Title sort uses a lowercased normalized title** in code-point order. Locale-aware collation
  can be added later with a collated index if readers need it.
