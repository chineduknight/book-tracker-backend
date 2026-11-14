# Architecture

## Why a modular monolith

One user-facing product, one small team, one database: a single deployable keeps operations,
transactions and local development simple. Organising code by business module (not by technical
layer) keeps boundaries clear enough to extract a module later if it is ever needed.

## Layout and boundaries

```
src/
├── server.ts       process lifecycle only: config → listen → connect DB → graceful shutdown
├── app.ts          builds the Express app; no I/O, so tests can use it directly
├── config/         validated environment and logger (no business logic)
├── db/             Mongoose connection lifecycle and readiness check
├── middleware/     cross-cutting HTTP concerns (request id/logging, 404, errors)
├── shared/         small primitives used by every module (AppError, response shapes)
└── modules/<name>/ one folder per business module
```

Rules for modules:

- A module owns its routes, request validation (Zod), public response DTOs (for example
  `modules/health/health.dto.ts`), service logic and Mongoose models. DTOs follow the shared
  envelopes in `shared/api-response.ts` and the [API contract](api-contract.md).
- Modules are mounted under `/api/v1` in `app.ts`.
- Other modules use a module through its exported service functions, never by reaching into its
  models directly.
- Every service function takes the authenticated owner id as an explicit argument and includes it
  in every query.
- Handlers throw `AppError` for expected failures; the central error handler serialises them.

Request flow: `request-logger (request id) → helmet → cors → json (100 kB) → /api/v1 router →
404 → error handler`.

## Authentication and ownership

- `modules/users` owns the `users` collection (unique index on the normalized email) and exposes
  `createUser`, `findUserCredentialsByNormalizedEmail` and `findUserById`. Only `UserDto` leaves
  the module, apart from the password hash that login needs.
- `modules/auth` owns registration, login, sessions (`sessions` collection), refresh-token
  history (`refreshtokens` collection), token issuance and
  the `requireAuthenticatedUser` middleware. `app.ts` creates the middleware once and passes it
  to every router that needs it.
- **Guarantee of `requireAuthenticatedUser`:** after it runs, `authenticatedUserOf(req)` returns
  a `userId` and `sessionId` taken from an HS256 access token this API signed (issuer, audience,
  type and expiry checked) whose session was active at that moment. It does not prove the user
  record still exists; handlers that load the user must handle a missing one.
- Future owner-scoped modules derive `ownerId` only from `authenticatedUserOf(req).userId` and
  never from the path, query or body.
- Indexes are declared on the schemas and built by Mongoose when the app connects. The
  integration tests build them before running; a production deployment should build them
  before traffic arrives.

## Book catalogue

- `modules/books` owns the `books` collection. Routes validate input with Zod, read the owner
  with `authenticatedUserOf(req).userId`, call a use case in `book.service.ts`, and serialize with
  `toPublicBook`.
- Every service query is built from `activeBooksOwnedBy(ownerId)` (`{ ownerId, deletedAt: null }`),
  and single-book operations add `_id`. Updates and deletes are single atomic
  `findOneAndUpdate`/`updateOne` calls with that filter, so there is no read-then-write
  authorisation gap.
- Indexes, all prefixed by `{ ownerId: 1, deletedAt: 1 }`:
  - `owner_active_recent` `{ createdAt: -1, _id: -1 }`: default and `oldest` listing.
  - `owner_active_title` `{ normalizedTitle: 1, _id: 1 }`: title sorts and title duplicates.
  - `owner_active_isbn` `{ normalizedIsbn: 1 }`, partial on `normalizedIsbn` existing: ISBN
    duplicates.
  - `owner_active_text` text on `title`, `authors`, `default_language: 'none'`: search.

  The integration tests assert, with `explain`, that each query shape uses its index.

## Locations and physical copies

- `modules/locations` owns the `locations` collection and exposes
  `requireLocationOwnedByUser` for other modules. Unique index `owner_unique_name`
  `{ ownerId: 1, normalizedName: 1 }` enforces per-reader names and serves the alphabetical list.
- `modules/copies` owns the `physicalcopies` collection and serves both `/books/:bookId/copies`
  and `/copies/:copyId` from one router, mounted before the books router so book-scoped copy
  routes are handled once. It never reads the books or locations collections directly: it calls
  `reserveBookForPhysicalCopy`, `isActiveBookOwnedByUser` and `requireActiveBookOwnedByUser`
  from the books service and `requireLocationOwnedByUser` from the locations service.
- A copy is visible only when `{ _id, ownerId, deletedAt: null }` matches **and** its parent
  book is active and owned by the reader; single-copy writes are atomic updates with the same
  copy filter after that visibility check.
- Copy indexes: `owner_book_active_recent`
  `{ ownerId: 1, bookId: 1, deletedAt: 1, createdAt: -1, _id: -1 }` for a book's copies (with
  optional location/condition filters applied on top), and `owner_location_active`
  `{ ownerId: 1, locationId: 1, deletedAt: 1 }` for future location views. Neither is unique.
- **Book/copy coordination:** see [decisions.md](decisions.md#physical-copy-and-location-decisions).
  The book document's internal `hasPhysicalCopyHistory` flag is the single point that copy
  creation and the ebook format change both update atomically.

## Reading sessions

- `modules/reading` owns the `readingsessions` collection and serves
  `/books/:bookId/reading-sessions`, `/books/:bookId/reading-overview` and `/reading-sessions`
  from one router, mounted before the books router.
- It calls the books service for every book check: `requireLengthsOfActiveBook` and
  `findLengthsOfActiveBook` (visibility plus page and chapter counts for progress validation),
  `requireActiveBookOwnedByUser`, and `keepDocumentsOfActiveBooks`, an aggregation stage owned by
  the books module that joins only the owner's active books. The reading module never queries the
  books collection itself.
- Indexes: `owner_book_recent` `{ ownerId, bookId, createdAt: -1, _id: -1 }` (one book's history
  and the overview), `owner_status_recent` `{ ownerId, status, createdAt: -1, _id: -1 }` (global
  history by status), `owner_recent` `{ ownerId, createdAt: -1, _id: -1 }` (unfiltered global
  history) and the partial unique `owner_book_single_in_progress`.
- PATCH uses compare-and-set on the internal `revision` field; see
  [decisions.md](decisions.md#reading-decisions).

## Notes and highlights

- `modules/notes` owns the `notes` collection and serves `/books/:bookId/notes` and `/notes` from
  one router, mounted before the books router.
- It never reads the books or readingsessions collections itself: it calls
  `requireActiveBookOwnedByUser`, `isActiveBookOwnedByUser` and `keepDocumentsOfActiveBooks` from
  the books service, and `requireBookIdOfVisibleReadingSession` from the reading service (the
  session's book id if the session belongs to the reader and its book is active, otherwise
  `404 "Reading session not found"`). The notes service compares that book id with the note's
  book to reject links across books.
- A note is visible only when `{ _id, ownerId, deletedAt: null }` matches **and** its book is one
  of the reader's active books. Single-note writes repeat the owner and not-deleted filter in one
  atomic `findOneAndUpdate`/`updateOne`, so a concurrent delete is never undone.
- `chapterKey` is an internal, derived copy of `chapter` (whitespace collapsed, NFC, lowercased)
  written in the same update as `chapter`, so the chapter filter can use plain equality.
- Indexes, all led by `ownerId`:
  - `owner_book_active_recent` `{ ownerId, bookId, deletedAt, createdAt: -1, _id: -1 }`: one
    book's notes, including its chapter filter.
  - `owner_active_recent` `{ ownerId, deletedAt, createdAt: -1, _id: -1 }`: the global list.
  - `owner_session_active_recent` `{ ownerId, readingSessionId, deletedAt, createdAt: -1, _id: -1 }`:
    notes of one reading session.
  - `owner_active_text` `{ ownerId: 1, deletedAt: 1 }` followed by text on `title`, `content`,
    `commentary` and `chapter`, `default_language: 'none'`. MongoDB refuses a `$text` query on a
    compound text index unless every prefix field has an equality condition, so a search cannot
    run without the owner and not-deleted filters.

  None is unique: identical notes are allowed. The integration tests assert each query shape's
  index with `explain`, and that unscoped text searches are refused.

## Categories and collections

- `modules/categories` owns the `categories` collection and `modules/collections` owns
  `bookcollections` (the model is `BookCollection` to keep it apart from MongoDB collections).
  The two modules are deliberate mirrors: same schema shape, same service functions, same routes
  under `/categories` and `/collections`. They share only domain-neutral helpers
  (`toCaseInsensitiveKey`, the request schemas, `toPaginationMeta`); there is no generic group
  framework, so each module can diverge later without untangling an abstraction.
- Membership is an ordered `bookIds` array on the group document. Adding and removing are single
  atomic updates (`$addToSet`, `$pull`) on `{ _id, ownerId, deletedAt: null }`, so concurrent
  changes never overwrite each other and a deleted group is never written to. Group soft deletion
  is the same kind of update.
- Neither module reads the books collection. Both call the books service:
  `requireActiveBookOwnedByUser` before every membership write and
  `listActiveBooksInMembershipOrder`, which loads the owner's active books among a group's
  `bookIds`, keeps them in membership order (`book.membership.ts`) and pages them, so hidden
  books are dropped before counting.
- `modules/organization` is a narrow composition layer for `GET /books/:bookId/organization`: it
  checks the book through the books service, then asks each group module for the active groups
  containing it (`findCategoriesContainingBook`, `findCollectionsContainingBook`). It is mounted
  before the books router, like the other book-scoped routers, and avoids a books → groups →
  books import cycle.
- Indexes on both collections:
  - `owner_active_unique_name` `{ ownerId, normalizedName }`, **unique and partial** on
    `deletedAt: null`: one active group per normalized name and owner; deleted groups free the name.
  - `owner_active_alphabetical` `{ ownerId, deletedAt, normalizedName, _id }`: the list.
  - `owner_active_books` `{ ownerId, deletedAt, bookIds }` (multikey): the groups containing a book.

  The integration tests assert the index definitions and, on seeded data, that the list and
  reverse lookup use them.

## Runtime lifecycle

- `server.ts` starts HTTP first, then connects to MongoDB in the background with retries.
  `/health` is live immediately; `/ready` turns 200 once Mongoose reports `connected`.
- On `SIGTERM`/`SIGINT` it stops retrying, closes the HTTP server (in-flight requests finish),
  waits for any pending connection attempt, then disconnects Mongoose. A 10 s timer forces exit
  if shutdown hangs.
- Unhandled rejections and uncaught exceptions are logged as `fatal` and exit with code 1. Like all
  logged errors, they are reduced to name and code (see [decisions.md](decisions.md)).

## Future data model (design notes, not implemented)

`User`, `Session`, `RefreshToken`, `Book`, `StorageLocation`, `PhysicalCopy`, `ReadingSession`,
`Note`, `Category` and `BookCollection` exist (see above); `Loan` is still a design note.

```
User 1─* Book 1─* Copy 1─* Loan          (at most one active Loan per Copy)
          │
          ├─* ReadingSession              (one per read; rereads add sessions)
          ├─* Note                        (note or highlight; optional link to one session)
          └─< Category / BookCollection   (many-to-many through the group's bookIds array)
```

- Every collection carries `ownerId`, and indexes lead with it (for example
  `{ ownerId: 1, bookId: 1 }`).
- `Loan`: partial unique index on `{ copyId: 1 }` where `returnedAt` is null.
- `Book.format` distinguishes physical books from ebook catalogue entries; there is no file reference.
