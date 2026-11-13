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
  for errors. Unexpected errors are reported as a generic 500.
- **Error logging is allowlisted:** errors are always logged under `err`, which the logger reduces
  to the error class name and a machine-readable code (for example `ECONNREFUSED`). Messages,
  stacks and causes are never logged because they can embed credentials or MongoDB connection
  strings, and field redaction cannot see inside them. Use the request id to correlate.
- **Liveness vs readiness:** `/health` never depends on MongoDB; `/ready` is 200 only while the
  Mongoose connection is fully connected.
- **Search:** owner-scoped MongoDB text indexes. No separate search service unless it becomes
  necessary.
- **TypeScript 6.0, not 7.x:** typescript-eslint (type-aware linting) supports TypeScript below
  6.1 only. Upgrade once it supports 7.x.
- **CORS without credentials:** the API is expected to use bearer tokens, so cookies are not
  enabled cross-origin. Revisit if cookie-based sessions are chosen in the auth PR.
