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

## Runtime lifecycle

- `server.ts` starts HTTP first, then connects to MongoDB in the background with retries.
  `/health` is live immediately; `/ready` turns 200 once Mongoose reports `connected`.
- On `SIGTERM`/`SIGINT` it stops retrying, closes the HTTP server (in-flight requests finish),
  waits for any pending connection attempt, then disconnects Mongoose. A 10 s timer forces exit
  if shutdown hangs.
- Unhandled rejections and uncaught exceptions are logged as `fatal` and exit with code 1. Like all
  logged errors, they are reduced to name and code (see [decisions.md](decisions.md)).

## Future data model (design notes, not implemented)

`User`, `Session` and `RefreshToken` exist (see above); the remaining models are design notes.

```
User 1─* Book 1─* Copy 1─* Loan          (at most one active Loan per Copy)
          │
          ├─* ReadingSession              (one per read; rereads add sessions)
          └─* Note                        (general or chapter-scoped; optional session link)
```

- Every collection carries `ownerId`, and indexes lead with it (for example
  `{ ownerId: 1, bookId: 1 }`).
- `Loan`: partial unique index on `{ copyId: 1 }` where `returnedAt` is null.
- `Note`: text index for owner-scoped search, always filtered by `ownerId`.
- `Book.format` distinguishes physical books from ebook catalogue entries; there is no file reference.
