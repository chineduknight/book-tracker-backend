# Book Tracker API

Backend for a personal library and reading tracker.

## Problem

Readers who own many books lose track of what they own, where each copy is, who borrowed it, and
what they thought of it. This API lets each user keep a private library: book titles, the physical
copies they own, reading sessions (including rereads), searchable general and chapter notes, and
lending history. Ebooks can be catalogued without storing any files.

The API currently covers accounts and sessions, the private book catalogue, storage locations and
physical copies, reading sessions with rereads, notes and highlights with owner-scoped text
search, categories and collections for organizing the catalogue, a wishlist of books to obtain,
lending of physical copies with full history, and a derived Home dashboard with reading
statistics. Data export is still to come (see [Upcoming PRs](#upcoming-prs)).

## Stack

| Concern         | Choice                                                        |
| --------------- | ------------------------------------------------------------- |
| Runtime         | Node.js 26.x LTS (`.nvmrc`, `engines`, CI)                    |
| Language        | TypeScript (strict), ES modules                               |
| HTTP            | Express 5                                                     |
| Database        | MongoDB via Mongoose                                          |
| Validation      | Zod (environment, request bodies, query and route parameters) |
| Logging         | pino / pino-http (structured JSON, sensitive values redacted) |
| Tests           | Vitest + Supertest; integration tests against a real MongoDB  |
| API docs        | [Bruno](bruno/README.md) collection (`.bru` files)            |
| Lint / format   | ESLint (typescript-eslint, type-aware) + Prettier             |
| Package manager | npm with committed `package-lock.json`                        |

## Engineering standards and API contract

- [AGENTS.md](AGENTS.md) holds the engineering rules for every change, whether written by a
  person or a coding agent. `CLAUDE.md` imports it so Claude Code loads the same rules.
- [docs/api-contract.md](docs/api-contract.md) defines shared HTTP behaviour: status codes,
  envelopes, errors, pagination, dates and IDs, plus every response the API currently returns.

Each endpoint's public response schema lives with its module as an explicit TypeScript DTO
(for example [`src/modules/health/health.dto.ts`](src/modules/health/health.dto.ts)) built on the
shared envelope types in [`src/shared/api-response.ts`](src/shared/api-response.ts). Executable
examples and assertions for each endpoint live in the [Bruno collection](bruno/README.md), and
HTTP integration tests in `test/` check the same contract.

## Getting started

Prerequisites: Node.js 26 (`nvm use`) and a MongoDB instance (a local `mongod` or an Atlas
cluster you create yourself).

```bash
nvm use                 # Node 26.x; npm enforces this via engine-strict
npm ci
cp .env.example .env    # adjust MONGODB_URI if needed
# Generate the access-token signing secret straight into .env (it is never printed):
echo "JWT_ACCESS_TOKEN_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")" >> .env
npm run dev             # http://localhost:3000/api/v1/health
```

`.env.example` leaves `JWT_ACCESS_TOKEN_SECRET` empty on purpose, so the API refuses to start
until you generate one; there is no built-in fallback secret. The appended line overrides the
empty one (the last value in an env file wins).

The server starts even if MongoDB is unreachable: `/health` responds immediately and `/ready`
returns 503 until a connection is established (connection attempts are retried every 5s).

## Environment variables

Validated with Zod at startup. Invalid configuration aborts with a list of offending variable
names; values are never printed.

| Variable                  | Required          | Default                 | Notes                                                                                                 |
| ------------------------- | ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`             | yes               | —                       | `mongodb://` or `mongodb+srv://`. Keep credentials in `.env`                                          |
| `NODE_ENV`                | no                | `development`           | `development` \| `test` \| `production`                                                               |
| `PORT`                    | no                | `3000`                  | 1–65535                                                                                               |
| `CORS_ORIGIN`             | no                | `http://localhost:5173` | Comma-separated exact origins. `*` is rejected                                                        |
| `LOG_LEVEL`               | no                | `info`                  | `fatal` `error` `warn` `info` `debug` `trace` `silent`                                                |
| `JWT_ACCESS_TOKEN_SECRET` | yes               | —                       | Signs access tokens. base64url, at least 32 random bytes; see Getting started                         |
| `MONGODB_TEST_URI`        | integration tests | —                       | e.g. `mongodb://127.0.0.1:27017/book-tracker-test`; tests always use the `book-tracker-test` database |

`.env` and other `.env.*` files are git-ignored; only `.env.example` (fake values) is committed.

## Scripts

| Command                    | What it does                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm run dev`              | Watch mode via `tsx`, loads `.env`, pretty logs                                                          |
| `npm run build`            | Compile `src/` → `dist/` with `tsc`                                                                      |
| `npm start`                | Run the compiled server (`dist/server.js`), loads `.env` if present                                      |
| `npm run typecheck`        | Type-check sources, tests and configs                                                                    |
| `npm run lint`             | ESLint                                                                                                   |
| `npm run format`           | Prettier write (`format:check` to verify)                                                                |
| `npm test`                 | Unit and HTTP tests without a database (`test:watch` for watch mode)                                     |
| `npm run test:integration` | MongoDB-backed tests; requires `MONGODB_TEST_URI` and fails without it                                   |
| `npm run api:test`         | Run the Bruno collection against the local API                                                           |
| `npm run api:smoke`        | Build, start a fresh API on port 3100 against `book-tracker-smoke`, run the whole Bruno collection, stop |

## API

All routes are under `/api/v1`. Success bodies are `{ "data": ... }`; errors are
`{ "error": { "code", "message", "requestId", "details?" } }`. Every response carries an
`X-Request-Id` header (a safe caller-supplied value is echoed, otherwise a UUID is generated).
The [API contract](docs/api-contract.md) lists every status and body, including `HEAD`, CORS
preflight and request-body errors.

| Method                        | Path                                           | Purpose                                                                   |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| GET                           | `/api/v1/health`                               | Liveness. Always 200 while the process serves HTTP                        |
| GET                           | `/api/v1/ready`                                | Readiness. 200 when MongoDB is connected, otherwise 503                   |
| POST                          | `/api/v1/auth/register`                        | Create an account and start a session (201)                               |
| POST                          | `/api/v1/auth/login`                           | Start a session with email and password                                   |
| POST                          | `/api/v1/auth/refresh`                         | Exchange a refresh token for a new token pair                             |
| POST                          | `/api/v1/auth/logout`                          | Revoke the session that owns a refresh token (204)                        |
| GET                           | `/api/v1/auth/me`                              | The authenticated user (bearer access token)                              |
| POST                          | `/api/v1/books`                                | Add a book to the reader's catalogue (201 + `Location`)                   |
| GET                           | `/api/v1/books`                                | List, search, filter and sort the reader's books (paginated)              |
| GET                           | `/api/v1/books/duplicate-check`                | Suggest existing books with the same title or ISBN                        |
| GET                           | `/api/v1/books/:bookId`                        | One of the reader's books                                                 |
| PATCH                         | `/api/v1/books/:bookId`                        | Change fields; `null` clears an optional field                            |
| DELETE                        | `/api/v1/books/:bookId`                        | Soft-delete a book (204)                                                  |
| POST                          | `/api/v1/locations`                            | Create a named storage location (201 + `Location`)                        |
| GET                           | `/api/v1/locations`                            | List the reader's locations alphabetically (paginated)                    |
| GET                           | `/api/v1/locations/:locationId`                | One of the reader's locations                                             |
| PATCH                         | `/api/v1/locations/:locationId`                | Rename a location or change/clear its description                         |
| POST                          | `/api/v1/books/:bookId/copies`                 | Add a physical copy to a physical book (201 + `Location`)                 |
| GET                           | `/api/v1/books/:bookId/copies`                 | List a book's copies, filter by location or condition                     |
| GET                           | `/api/v1/copies/:copyId`                       | One physical copy                                                         |
| PATCH                         | `/api/v1/copies/:copyId`                       | Change label, condition, note or location; `null` clears                  |
| DELETE                        | `/api/v1/copies/:copyId`                       | Soft-delete a copy (204)                                                  |
| POST                          | `/api/v1/books/:bookId/reading-sessions`       | Start a reading, or record an earlier completed one (201 + `Location`)    |
| GET                           | `/api/v1/books/:bookId/reading-sessions`       | One book's reading history (paginated)                                    |
| GET                           | `/api/v1/books/:bookId/reading-overview`       | Derived reading status (`unread`, `reading`, `completed`) and sessions    |
| GET                           | `/api/v1/reading-sessions`                     | All of the reader's reading history (paginated)                           |
| GET                           | `/api/v1/reading-sessions/:sessionId`          | One reading session                                                       |
| PATCH                         | `/api/v1/reading-sessions/:sessionId`          | Record progress, finish, or correct a session                             |
| POST                          | `/api/v1/books/:bookId/notes`                  | Add a note or highlight, optionally linked to a session (201)             |
| GET                           | `/api/v1/books/:bookId/notes`                  | One book's notes: filter by kind, chapter, session or words               |
| GET                           | `/api/v1/notes`                                | All of the reader's notes, with the same filters plus `bookId`            |
| GET                           | `/api/v1/notes/:noteId`                        | One note or highlight                                                     |
| PATCH                         | `/api/v1/notes/:noteId`                        | Change text, title, commentary, chapter or page; `null` clears            |
| DELETE                        | `/api/v1/notes/:noteId`                        | Soft-delete a note (204)                                                  |
| GET                           | `/api/v1/categories/presets`                   | Read-only starter category names (nothing is created)                     |
| POST                          | `/api/v1/categories`                           | Create a category, unique per reader by normalized name (201)             |
| GET                           | `/api/v1/categories`                           | List the reader's categories alphabetically (paginated)                   |
| GET                           | `/api/v1/categories/:categoryId`               | One category                                                              |
| PATCH                         | `/api/v1/categories/:categoryId`               | Rename or change/clear the description                                    |
| DELETE                        | `/api/v1/categories/:categoryId`               | Soft-delete a category; books are untouched (204)                         |
| PUT                           | `/api/v1/categories/:categoryId/books/:bookId` | Add a book to the category (idempotent, 204)                              |
| DELETE                        | `/api/v1/categories/:categoryId/books/:bookId` | Remove a book from the category (idempotent, 204)                         |
| GET                           | `/api/v1/categories/:categoryId/books`         | The category's visible books in membership order (paginated)              |
| POST, GET, PATCH, DELETE, PUT | `/api/v1/collections...`                       | The same endpoints for reader-curated collections                         |
| GET                           | `/api/v1/books/:bookId/organization`           | The categories and collections containing one book                        |
| POST                          | `/api/v1/wishlist`                             | Record a book the reader wants (201 + `Location`)                         |
| GET                           | `/api/v1/wishlist`                             | List and search wishes by status, priority and words (paginated)          |
| GET                           | `/api/v1/wishlist/:wishlistItemId`             | One wishlist item                                                         |
| PATCH                         | `/api/v1/wishlist/:wishlistItemId`             | Edit descriptive fields; `null` clears                                    |
| PUT                           | `/api/v1/wishlist/:wishlistItemId/acquisition` | Link an owned book and mark the wish acquired (idempotent)                |
| DELETE                        | `/api/v1/wishlist/:wishlistItemId`             | Soft-delete a wishlist item (204)                                         |
| POST                          | `/api/v1/copies/:copyId/loans`                 | Lend a physical copy; one active loan per copy (201 + `Location`)         |
| GET                           | `/api/v1/copies/:copyId/loans`                 | One copy's lending history (paginated)                                    |
| GET                           | `/api/v1/copies/:copyId/loan-overview`         | Derived availability and the active loan                                  |
| GET                           | `/api/v1/loans`                                | All loans: active (default), returned, overdue or all (paginated)         |
| GET                           | `/api/v1/loans/:loanId`                        | One loan, also after its copy or book was deleted                         |
| PATCH                         | `/api/v1/loans/:loanId`                        | Correct borrower details and dates; never reopens                         |
| PUT                           | `/api/v1/loans/:loanId/return`                 | Record the return (idempotent for the same date)                          |
| GET                           | `/api/v1/dashboard/summary`                    | Derived library counts; overdue loans as of `asOf` (UTC today by default) |
| GET                           | `/api/v1/dashboard/reading-statistics`         | Reading buckets, lifetime completions and rereads, overall and by format  |
| GET                           | `/api/v1/dashboard/recent-activity`            | The newest recorded books, sessions, notes, wishes and loans (ids only)   |

Authentication uses bearer tokens in JSON: a 15-minute access token and a single-use refresh
token for a 30-day session. Token storage for a future browser frontend is **not decided yet**;
see [docs/decisions.md](docs/decisions.md#authentication-decisions).

Executable examples live in the [Bruno collection](bruno/README.md):
open `bruno/` in the Bruno app and select the `local` environment, or run `npm run api:test`.

## Architecture

A modular monolith: one deployable Express app, with code grouped by business module.

```
src/
├── app.ts                 # Express assembly: middleware, /api/v1 router, 404 + error handlers
├── server.ts              # Process entry: config, listen, DB connect, graceful shutdown
├── config/                # env.ts (Zod-validated env), logger.ts (pino + redaction)
├── db/                    # mongo.ts (connect with retry, readiness, disconnect)
├── middleware/            # request id + logging, 404 and centralised error handling
├── modules/auth/          # register, login, sessions, tokens, rate limits, auth middleware
├── modules/books/         # book catalogue: model, schemas, DTOs, service, routes
├── modules/copies/        # physical copies of physical books
├── modules/locations/     # reader-owned storage locations
├── modules/reading/       # reading sessions, rereads and the derived reading overview
├── modules/notes/         # notes and highlights, optional session links, text search
├── modules/categories/    # subject categories: unique names per reader, ordered memberships
├── modules/collections/   # reader-curated collections, mirroring categories
├── modules/organization/  # one book's categories and collections (reverse lookup)
├── modules/wishlist/      # wanted books, priorities, search and acquisition links to owned books
├── modules/loans/         # lending of physical copies: one active loan per copy, full history
├── modules/dashboard/     # read-only derived summary, reading statistics and recent activity
├── modules/health/        # liveness and readiness routes + response DTOs
├── modules/users/         # user model, public UserDto, user service
└── shared/                # AppError, response envelopes, request validation, safe errors
test/                      # Vitest + Supertest without a database
test/integration/          # Vitest + Supertest against a real MongoDB (book-tracker-test)
bruno/                     # Bruno collection (API docs + executable examples)
scripts/                   # api-smoke.ts: fresh API instance + whole Bruno collection
docs/                      # architecture, decisions, API contract, operations runbook
AGENTS.md                  # engineering standards (CLAUDE.md imports it)
```

See [docs/architecture.md](docs/architecture.md), [docs/decisions.md](docs/decisions.md) and the
[operations runbook](docs/operations.md).

## Running the integration tests

The integration suite needs a MongoDB server. It connects to the `book-tracker-test` database
whatever the URI names, and deletes users and sessions between tests, so never point it at data
you want to keep.

```bash
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/book-tracker-test npm run test:integration
```

No local MongoDB? A throwaway container works:
`docker run --rm -d -p 27017:27017 --name book-tracker-test-mongo mongo:8.0`.
CI runs the same suite against a `mongo:8.0` service container, then starts the built API and
runs the Bruno collection against it.

## Current scope

Included: scaffold, config validation, MongoDB lifecycle, health/readiness, security baseline
(helmet, CORS allowlist, 100 kB JSON limit), structured logging with redaction, error handling,
authentication and user accounts (register, login, refresh, logout, current user), the private
book catalogue (create, list, search, filter, sort, update, soft delete, duplicate suggestions),
storage locations and physical copies, reading sessions with rereads and a derived reading
overview, notes and highlights (Markdown source, optional session link, owner-scoped text search,
soft delete), categories and collections (opt-in presets, per-reader unique names, idempotent
ordered memberships, soft delete), a wishlist (priorities, search, explicit acquisition linking an
owned book, soft delete), lending (one active loan per copy enforced by the database, returns,
overdue view, history that survives copy deletion), a read-only dashboard (summary, reading
statistics, recent activity), tests, CI, Bruno.

Not included yet: email verification, password reset, OAuth, export, loan reminders, wish un-acquire,
nested categories,
membership reordering, automatic classification, book or note restore, location deletion,
reading-session deletion, UI, deployment.

## Upcoming PRs

1. **Export & data portability**: full per-user data export.
2. **Backend hardening** across modules.
3. **Deployment and operations.**
