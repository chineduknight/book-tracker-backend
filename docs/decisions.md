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
- **Request logs keep resource ids, never content.** The request logger records method, URL path
  (which contains ids such as `/api/v1/books/{id}`), status and request id. Ids are opaque and
  are what make a "not found" report traceable, so they are logged on purpose. Query strings,
  headers and bodies are never logged, so titles, search terms, location names, notes and
  credentials never are.
- **Private data responses are not cacheable.** `/auth`, `/books`, `/copies` and `/locations`
  responses send `Cache-Control: no-store` (set before CORS and the body parser so every
  response is covered), protecting shared computers and back/forward caches. CORS exposes
  `Location` so browser clients can read the URL of a created resource.

## Physical copy and location decisions

- **A copy is one physical item of a physical book.** Label, condition, storage note and
  location live on the copy, never on the book. A book can have many copies, and many copies can
  share a location. Copies of ebooks are refused (`409 BOOK_NOT_PHYSICAL`).
- **A book with physical-copy history can never become an ebook** (`409
BOOK_HAS_PHYSICAL_COPIES`), even after its copies are deleted, because future loans may refer
  to those copies.
- **Coordination without transactions.** MongoDB transactions need a replica set; local
  development and CI use a standalone server. Instead the parent book document is the single
  coordination point: adding a copy first sets an internal `hasPhysicalCopyHistory: true` on the
  book with one atomic update that only matches an active physical book owned by the reader, and
  only then inserts the copy; changing the format to ebook is one atomic update that only matches
  while that flag is unset. MongoDB applies the two single-document updates in some order, so
  whichever runs second fails and a copy can never be persisted on an ebook. The flag is never
  cleared.
  - **Accepted trade-off:** if the copy insert fails after the flag was set (for example the
    database becomes unreachable between the two writes), the book stays locked to physical even
    though it may have no copy. This fails closed (it can only refuse a format change, never
    allow a wrong one), needs no cleanup to stay correct, and is rare. Switching to multi-document
    transactions would remove it at the cost of requiring a replica set everywhere.
- **Deleting a book keeps its copies.** Copy records, including their location, stay unchanged;
  every copy endpoint hides them while the parent book is deleted. A copy created while its book
  is being deleted concurrently may be persisted, but it is hidden in the same way.
- **Copy writes and book deletion are not one atomic step.** Copy PATCH and DELETE check that the
  parent book is active and then write the copy; a book deletion landing between the two still
  lets that one write complete. The copy remains hidden afterwards and no history is lost.
  Strictly excluding writes after deletion would need transactions or extra coordination;
  revisit this when book restore, loans or long-lived history make it matter.
- **Recovery for a stranded `hasPhysicalCopyHistory` flag** is an operator procedure, not an API
  feature: see [operations.md](operations.md). There is deliberately no user-facing reset.
- **Copies are soft-deleted** for future lending history; there are no stored lending flags.
- **Locations are per reader, unique by normalized name** (whitespace collapsed, NFC, lowercased)
  through a unique index, so concurrent creates and renames cannot produce duplicates. A missing
  location and another reader's location are indistinguishable.
- **Locations cannot be deleted yet.** Copies reference them and a safe archive or reassignment
  policy is not designed; a destructive delete would be misleading.
- **Unassigned is `null`.** A copy without a location returns `locationId: null`; no default
  location is invented.

## Reading decisions

- **A reading session is one reading of a book**, attached to the book (not a copy), for
  physical books and ebooks alike. Rereading creates a new session; earlier sessions and their
  details are never overwritten. Nothing creates a session implicitly.
- **Reading status is derived, never stored.** Books have no `readingStatus` or counters; the
  overview computes `unread`, `reading` or `completed` from sessions. The Book DTO is unchanged.
- **Completion is explicit and its details are optional** (invariant 5). Reaching the last page or
  100% does not complete a session, and finishing never fills in `completedOn`.
- **Completed is final.** A completed session can be corrected (rating, summary, dates, progress)
  but never reopened; a reread is a new session. There is no session deletion endpoint, so history
  cannot disappear by accident.
- **One in-progress session per book** is enforced by the partial unique index
  `owner_book_single_in_progress` (`{ ownerId, bookId }` where `status: 'in_progress'`); a
  duplicate-key error becomes `409 READING_SESSION_IN_PROGRESS`, not a pre-check.
- **Progress is a single snapshot** (`pages`, `chapters` or `percent`), never converted between
  units. New progress is checked against the book's current page or chapter count when it is set;
  stored progress is not rewritten if the book's counts change later, so history may exceed a
  reduced count.
- **Dates are calendar days** (`YYYY-MM-DD`), validated as real Gregorian dates and stored as
  sent, with no time zone conversion.
- **Concurrent PATCHes use compare-and-set on a revision counter.** The service reads the session,
  validates the merged result (date order, completion-only dates, no reopening) and writes only if
  the session's `revision` is unchanged, incrementing it. A concurrent change makes it re-read and
  re-validate (up to five attempts, then `409 READING_SESSION_UPDATE_CONFLICT`). This keeps
  cross-field rules true without transactions.
- **Deleted books hide their sessions without deleting them.** Global history filters out
  sessions of deleted books inside one aggregation (an owner-scoped `$lookup` provided by the books
  service) before counting and paging, so totals are exact. A session started while its book is
  being deleted may be stored but stays hidden, matching the copy policy.
- **Repeatable API smoke runs use a fresh API instance.** `npm run api:smoke` builds, resets the
  dedicated `book-tracker-smoke` database, starts the API on its own port with a generated signing
  secret, runs the whole Bruno collection and stops the API. Each run therefore starts with fresh
  in-memory rate limits, without weakening the limits themselves. CI uses the same script.
  Because it drops a database, it only accepts a single local `mongodb://` host with the smoke
  database and an allowlist of options (no SRV, remote hosts, replica-set discovery or proxies;
  `directConnection=true` is enforced), refuses a busy port before resetting anything, waits for
  the API process it started to report listening before trusting `/ready`, and prints only safe
  error names and codes.
  A local address is not proof that the database is disposable: an SSH tunnel or port forward on
  `localhost` can reach a remote server. Run the smoke command only against a MongoDB you know is
  a throwaway local instance (as in CI); the runner cannot detect a tunnel.

## Notes decisions

- **One `Note` model with an immutable `kind`.** `note` (the reader's own writing) and
  `highlight` (a quotation) share fields, storage, search and endpoints; the distinction is the
  explicit `kind`, never a guess from the text. A highlight is limited to 5,000 characters and a
  note to 20,000, also when the content is edited later.
- **Notes belong to the book, not to a copy or a file.** They work for physical books and ebooks
  alike. `chapter` is a free-text label and `pageNumber` a reference; neither points into an ebook
  file or is compared with the book's current page count (editions differ and books change).
- **Markdown is stored as source and never rendered.** Note `content` and `commentary` are
  Markdown source; a highlight's `content` is plain text. The API stores the strings verbatim
  apart from trimming surrounding whitespace (no collapsing, quote normalization or HTML
  sanitization, which would silently change what the reader wrote) and never returns HTML. Safe
  rendering, including refusing raw embedded HTML, is the client's responsibility. The backend
  never fetches, parses or executes note text.
- **A session link is optional and permanent.** `readingSessionId` may reference only a visible
  session of the reader **for the same book** (in progress or completed); another book's session
  is `409 READING_SESSION_BOOK_MISMATCH`, anything else `404`. It cannot be changed after creation,
  so thoughts stay attributed to the reading they came from, including across rereads. The notes
  module verifies the link through a reading-service export, not the reading model.
- **Deletion is explicit and soft.** `DELETE /notes/:id` sets `deletedAt`; the record is kept for
  a future export, audit or restore policy, but there is no restore endpoint yet. Deleting a book
  or completing a session never deletes or changes notes (invariant 7); a deleted book's notes are
  hidden everywhere.
- **Edits write only the named fields.** PATCH is one atomic owner- and not-deleted-scoped update
  that sets or unsets exactly the fields in the request (and `chapterKey` with `chapter`), so
  concurrent edits of different fields both persist and a concurrent delete is never undone. Two
  edits of the same field: the last write wins, which is acceptable for a single reader's notes and
  needs no revision counter (unlike reading sessions, notes have no cross-field rules).
- **Search uses one compound text index** with the equality prefix `{ ownerId, deletedAt }` over
  `title`, `content`, `commentary` and `chapter`, `default_language: 'none'` (no stemming or stop
  words, so any language works the same; case- and diacritic-insensitive). MongoDB rejects a
  `$text` query that lacks equality on the prefix, so search cannot escape owner and deletion
  scoping. Quotes and hyphens are replaced with spaces before searching (the shared
  `toTextSearchWords`), so client input never becomes a phrase or negation operator, and no regex
  is ever built from it. Results are ordered by creation time, never by text score.
- **No chapter index.** The planned `{ ownerId, bookId, deletedAt, chapterKey, createdAt, _id }`
  index was left out: one book's notes are a small range of `owner_book_active_recent`, which
  already returns them in order, so the chapter equality is applied on that range without an
  in-memory sort (asserted with `explain`). A global chapter filter scans the reader's notes via
  `owner_active_recent`, which is acceptable at personal-library scale. Revisit if a reader's notes
  per book grow into the tens of thousands.
- **Deleted books are filtered before paging.** `GET /notes` runs one aggregation that matches
  the reader's non-deleted notes, sorts, joins only active books through the books service's
  `keepDocumentsOfActiveBooks`, and pages with `$facet`, so totals are exact and pages have no
  gaps. A note created while its book is being deleted may be stored but stays hidden, matching
  the copy and reading policies; there are no transactions.
- **Requested filters must exist.** A missing, deleted or foreign `bookId` or `readingSessionId`
  filter returns `404` rather than an empty page, consistent with book-scoped endpoints.

## Organization decisions

- **Categories classify, collections curate.** A category describes what a book is
  (`Philosophy`); a collection is a shelf the reader assembles (`To Read in 2027`). Both group
  books, not copies, sessions or notes, and both are many-to-many. They behave identically and
  are kept as two separate, mirrored modules rather than one `type` field or a generic framework,
  so the product can let them diverge (for example nesting categories) without a migration.
- **Starter categories are suggestions, not data.** `GET /categories/presets` returns a fixed
  list; registration creates no categories, listing creates none, and a deleted category is never
  resurrected by a suggestion. Only an explicit create materializes a category. This keeps account
  data predictable and lets a reader ignore presets entirely.
- **Membership lives in an ordered `bookIds` array on the group.** At the expected scale (a few
  hundred books per reader) a bounded array with atomic `$addToSet`/`$pull` is simpler and safer
  than a join collection: one document, no read-modify-save race, insertion order for free. Adding
  an existing member does not move it; removing and re-adding appends. There is no reorder
  endpoint yet. A separate membership collection becomes preferable if groups grow by orders of
  magnitude or need per-membership data; `listActiveBooksInMembershipOrder` is the one place that
  would change.
- **Group DTOs carry no memberships and no counts.** A group's books come from its own books
  endpoint, whose `total` counts visible books at request time; a cached `bookCount` would drift
  when books are deleted.
- **Names are unique per reader and kind among active groups**, by normalized name (whitespace
  collapsed, NFC, lowercased) through a **partial unique index** on `deletedAt: null`. Deleting a
  group frees its name while the old record stays. Verified on real MongoDB: a second active
  namesake is refused, several deleted namesakes coexist, and the index serves the lookup.
- **Group deletion is soft and never cascades** (invariant 7): the group and its memberships are
  hidden, books and everything attached to them are untouched. Deleting a book hides it from its
  groups; the membership id may remain stored and is filtered out whenever the group's books are
  read, before counting and paging.
- **Membership writes check the book, then update the group atomically.** The book check is a
  separate read, so a book deleted in between can leave a hidden membership; it is never shown.
  A group deleted in between is never written to, because the update matches only active groups.
  This is the same non-transactional policy as copies, reading sessions and notes.
- **`updatedAt` of a group reflects its last change, memberships included.** Membership writes
  use the normal Mongoose timestamps, so an idempotent no-op PUT also advances it; this is
  accepted as simpler and more honest than hiding membership changes from `updatedAt`.

## Wishlist decisions

- **A wish is not a book.** `WishlistItem` is its own record: it never appears in the catalogue,
  is not counted as owned, and has no copies, sessions, notes or group memberships. Duplicates
  are allowed (of other wishes and of owned books, by title or ISBN) because a reader may want
  another edition, format or copy; there is no unique index on title, ISBN or the acquired book.
- **Acquisition links an existing book; it never creates one.** Creating a book and a copy from a
  wish would need a multi-document write, which standalone MongoDB cannot make atomic. Instead
  the client adds the book with `POST /books` and then records the acquisition, which is one
  conditional write on the wish (`status: 'wanted'` → `'acquired'`, book id and timestamp
  together). Several wishes may be fulfilled by the same book. `preferredFormat` is an intention
  and is not compared with the acquired book's format.
- **Acquired is final.** There is no un-acquire or reopen; a mistaken acquisition needs a
  deliberately designed correction flow later. Descriptive fields stay editable on acquired items.
  Repeating the same book is idempotent and writes nothing (so `updatedAt` and `acquiredAt` stay
  put); a different book is `409 WISHLIST_ALREADY_ACQUIRED`.
- **Acquisition history outlives the book.** Deleting a book never changes wishes; an acquired
  item keeps its `acquiredBookId` as history even when that book is hidden. The client resolves
  the book before linking to it.
- **The book is checked before the item** on acquisition, mirroring membership writes, so two
  unknown ids report the book. The check and the write are separate operations: a book deleted in
  between can leave an acquired wish pointing at a hidden book, which is the accepted
  non-transactional policy (tested). A wish deleted in between is never acquired, because the
  write matches only active items.
- **The default list shows wanted items.** `status` defaults to `wanted` so fulfilled wishes
  leave the active view without being deleted; `acquired` and `all` are explicit.
- **Priority is stored twice on purpose.** `priority` is the public value and the filter key;
  `priorityRank` (`high` 0, `medium` 1, `low` 2) is the internal sort key written in the same
  update, so the priority sort uses a plain ascending index.
- **Deletion is soft** and explicit, keeping the record and any acquisition history.
