# Book Tracker REST API Contract (V1)

This document defines shared HTTP behavior. Every implemented endpoint must additionally have its own contract in the corresponding Bruno request: method/path, authentication, input validation, success status, exact success DTO, expected error statuses/codes, and representative examples. Bruno is our executable API documentation, not a replacement for typed DTOs or tests.

## General rules

- Base path: `/api/v1`.
- JSON responses use `Content-Type: application/json`; `204 No Content` has no body.
- All responses include an `X-Request-Id` header. Error responses also include `requestId` in the body if one was assigned.
- Responses under `/api/v1/auth`, `/api/v1/books`, `/api/v1/copies`, `/api/v1/locations`, `/api/v1/reading-sessions`, `/api/v1/notes`, `/api/v1/categories` and `/api/v1/collections` send `Cache-Control: no-store`, including errors raised before routing and CORS preflight, so private data is never kept in browser or shared caches.
- CORS exposes `X-Request-Id` and `Location` to allowed browser origins.
- **Logging:** request logs contain the method, the URL path (which includes resource ids such as `/api/v1/books/{id}`), the status and the request id. Query strings, headers and bodies are never logged, so titles, search terms, location names, notes, emails, passwords and tokens never reach the logs.
- Public IDs are strings named `id`, not MongoDB `_id`; never return `__v` or internal model fields.
- Timestamps use ISO 8601 UTC strings, e.g. `2026-11-13T10:30:00.000Z`. Calendar-only dates such as a loan due date use `YYYY-MM-DD` with an explicit business timezone policy; do not shift a date-only value by implicit UTC conversion.
- Do not expose password hashes, tokens (outside explicitly designed authentication responses), personal borrower details to unrelated users, stack traces, or internal database errors.
- Client requests must never determine the authenticated owner. Owner-scoped resources not owned by the requester are returned as `404`, not as different authorization responses that disclose existence.
- Arrays are `[]` rather than `null` when empty; optional fields have a documented omission/null policy, consistent for each DTO.

## Success responses

A single resource or operation returning a resource uses `data`:

```json
{
  "data": {
    "id": "book_123",
    "title": "Example Book",
    "authors": ["Example Author"],
    "readingStatus": "unread"
  }
}
```

A collection uses `data` containing an array. Paginated collections also include `meta.pagination`:

```json
{
  "data": [{ "id": "book_123", "title": "Example Book" }],
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 300,
      "totalPages": 15
    }
  }
}
```

For page-based pagination, default to page `1` and limit `20`, with a maximum limit of `100`. Validate page and limit; implement a deterministic sort with a unique tie-breaker. Revisit cursor pagination only when scale or performance warrants it. Do not expose arbitrary client-defined MongoDB sorts.

Expected HTTP semantics:

| Operation                              | Status           | Response                                                          |
| -------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Read or successfully update a resource | `200 OK`         | `{ "data": ... }`                                                 |
| List resources                         | `200 OK`         | `{ "data": [...], "meta": { "pagination": ... } }` when paginated |
| Create a resource                      | `201 Created`    | `{ "data": ... }`; include `Location` header when practical       |
| Delete a resource with no content      | `204 No Content` | Empty body (no `{ "data": null }`)                                |
| Health probe                           | `200 OK`         | See current Bruno `Health/Liveness.bru`                           |
| Readiness probe                        | `200` or `503`   | See current Bruno `Health/Readiness.bru`                          |

The examples above illustrate the envelope. They are **not** a finalized `Book` DTO or a requirement to invent public string IDs of the form `book_123`. Final fields and ID representation must be defined explicitly in the implementing module.

## Error responses

Every error uses the established envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields",
    "requestId": "c10e79cf-2e60-4a2c-9f35-1ca9cf5bfcb3",
    "details": [{ "field": "title", "message": "Title is required" }]
  }
}
```

`details` is optional, contains only safe field-level feedback, and must not expose credentials, database messages, or input secrets. Known error bodies use a safe, stable `code` and human-readable `message`.

| Status                       | Intended use                                                                    | Example code                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 Bad Request`            | Validation errors, malformed JSON, invalid query/params                         | `VALIDATION_ERROR`, `INVALID_JSON`                                                                                                                                                           |
| `401 Unauthorized`           | Missing, invalid, or expired authentication; failed login or refresh            | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`                                                                                                                            |
| `403 Forbidden`              | Authenticated user lacking permission for an action not concealed by ownership  | `FORBIDDEN`                                                                                                                                                                                  |
| `404 Not Found`              | Missing route, missing resource, or resource owned by someone else              | `NOT_FOUND`                                                                                                                                                                                  |
| `409 Conflict`               | Duplicate resource, a state that forbids the change, or an active-loan conflict | `CONFLICT`, `BOOK_NOT_PHYSICAL`, `BOOK_HAS_PHYSICAL_COPIES`, `READING_SESSION_IN_PROGRESS`, `INVALID_READING_TRANSITION`, `READING_SESSION_UPDATE_CONFLICT`, `READING_SESSION_BOOK_MISMATCH` |
| `413 Payload Too Large`      | Body exceeds configured limit                                                   | `PAYLOAD_TOO_LARGE`                                                                                                                                                                          |
| `415 Unsupported Media Type` | Unsupported request encoding                                                    | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                     |
| `429 Too Many Requests`      | Rate limit exceeded (authentication endpoints)                                  | `RATE_LIMITED`                                                                                                                                                                               |
| `500 Internal Server Error`  | Unexpected server fault                                                         | `INTERNAL_ERROR`                                                                                                                                                                             |
| `503 Service Unavailable`    | Not ready, including disconnected database                                      | `SERVICE_UNAVAILABLE`                                                                                                                                                                        |

Do not change existing implemented error codes merely to match these suggested names; preserve current behavior or propose an explicit breaking-change decision. Avoid `200` responses that represent errors inside `data`.

## Endpoint definition checklist

Every new endpoint PR must record and test:

1. Method and URL, purpose, and required identity/authorization.
2. Path parameters, query parameters, and request body Zod validation (including size and limits).
3. Exact public success DTO, status, and any headers.
4. Explicit expected errors with status and code, including authorization and owner isolation.
5. Bruno examples/tests for success and representative errors; HTTP integration tests exercising the same contract.
6. Observable side effects and idempotency/concurrency constraints for writes.

Use TypeScript types (or Zod response schemas when runtime parsing is justified) for public DTOs. Do not return Mongoose documents or `res.json(model)` without projection/mapping. Reuse shared response envelope types where that reduces duplication, but keep concrete endpoint DTOs visible and understandable. Prefer conventional explicit route handlers to a framework of abstract response wrappers.

## Authentication and session tokens

The API uses bearer tokens carried in JSON, not cookies, so CORS stays `credentials: false`.

- **Access token:** HS256 JWT, valid for 15 minutes (`expiresIn: 900`). Header `typ: at+jwt`; claims `sub` (user id), `sid` (session id), `iss` and `aud` (`book-tracker-api`), `iat`, `exp`. No email, name or other personal data. Send it as `Authorization: Bearer <accessToken>`.
- **Refresh token:** 32 random bytes (256 bits), base64url-encoded, opaque to clients. The server stores only its SHA-256 digest, one record per issued token, kept until the session's absolute expiry. It is single-use: every successful refresh returns a new refresh token and invalidates the presented one.
- **Session:** each register or login creates a server-side session with a 30-day **absolute** lifetime (`refreshExpiresIn` counts down; rotation does not extend it). Expired sessions are deleted by a TTL index.
- **Protected requests** verify the JWT (signature, `HS256` only, issuer, audience, type, expiry) **and** that its session is still active. Logout therefore stops both the refresh token and every access token of that session immediately.
- **Replay policy:** presenting a refresh token that was already exchanged revokes its session (reason `refresh_token_reuse`), so a stolen token cannot keep a session alive. Clients must not send concurrent refreshes with the same token: only one succeeds and the session is then revoked. A token that matches nothing (for example a guess) is rejected without affecting any session. Reuse detection covers every token the session has issued, for the session's whole lifetime.
- **Throttling** (per API instance, in memory; responses carry `RateLimit` headers and `Retry-After` when blocked):

| Limit                     | Applies to                                    | Default            |
| ------------------------- | --------------------------------------------- | ------------------ |
| Auth requests per address | `register`, `login`, `refresh`, `logout`      | 100 per 15 minutes |
| Registrations per address | `register` (all attempts)                     | 20 per hour        |
| Failed logins per address | `login` responses with status ≥ 400           | 30 per 15 minutes  |
| Failed logins per account | `login` responses with status ≥ 400, by email | 10 per 15 minutes  |

Limits are temporary windows, never a permanent lockout. The per-account limit lets someone delay a known user's login for up to 15 minutes; that is the accepted trade-off against unlimited password guessing.

- **No email verification yet:** accounts are active immediately; ownership of the email address is not proven.
- **Browser token storage is not decided.** These JSON tokens suit API clients and Bruno. A browser frontend must not keep the refresh token in `localStorage` or `sessionStorage`; before production web sign-in, choose a secure design (likely an HttpOnly, Secure, SameSite refresh cookie with CSRF protection and an explicit CORS decision).

## Existing endpoints

This section lists every method and status the API currently returns. Bodies are exact; `<id>` is the request id also sent in `X-Request-Id`.

### Probes

Both probes send `Cache-Control: no-store`. Response DTOs: `src/modules/health/health.dto.ts`. Bruno: `bruno/Health/Liveness.bru`, `bruno/Health/Readiness.bru`.

| Method | Path                              | Status        | Body                                                                                                                                |
| ------ | --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health`                  | `200`         | `{ "data": { "status": "ok", "timestamp": "<ISO 8601 UTC timestamp>" } }`                                                           |
| `GET`  | `/api/v1/ready`                   | `200`         | `{ "data": { "status": "ready", "checks": { "database": "connected" } } }`                                                          |
| `GET`  | `/api/v1/ready`                   | `503`         | `{ "error": { "code": "SERVICE_UNAVAILABLE", "message": "Service is not ready: database is not connected", "requestId": "<id>" } }` |
| `HEAD` | `/api/v1/health`, `/api/v1/ready` | Same as `GET` | Headers only, no body (Express answers `HEAD` for every `GET` route)                                                                |

`/ready` returns `503` whenever the MongoDB connection is not fully connected (disconnected, connecting or disconnecting).

### Authentication

All `/api/v1/auth/*` responses send `Cache-Control: no-store`, including errors raised before routing (malformed JSON, oversized or unsupported bodies), unknown auth routes and CORS preflight. DTOs: `src/modules/auth/auth.dto.ts` and `src/modules/users/user.dto.ts`. Bruno: `bruno/Auth/`.

```ts
interface UserDto {
  id: string; // 24-character hex MongoDB ObjectId
  name: string;
  email: string; // trimmed and lowercased
  createdAt: string; // ISO 8601 UTC
}

interface SessionTokensDto {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // seconds until the access token expires (900)
  refreshExpiresIn: number; // seconds until the session's absolute expiry
}
```

| Method | Path                    | Auth                | Request body                | Success                                  | Errors                                                                  |
| ------ | ----------------------- | ------------------- | --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/v1/auth/register` | None                | `{ name, email, password }` | `201` `{ "data": { "user", "tokens" } }` | `400 VALIDATION_ERROR`, `409 CONFLICT`, `429 RATE_LIMITED`              |
| `POST` | `/api/v1/auth/login`    | None                | `{ email, password }`       | `200` `{ "data": { "user", "tokens" } }` | `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `429 RATE_LIMITED`   |
| `POST` | `/api/v1/auth/refresh`  | None                | `{ refreshToken }`          | `200` `{ "data": { "tokens" } }`         | `400 VALIDATION_ERROR`, `401 INVALID_REFRESH_TOKEN`, `429 RATE_LIMITED` |
| `POST` | `/api/v1/auth/logout`   | None                | `{ refreshToken }`          | `204`, empty body                        | `400 VALIDATION_ERROR`, `401 INVALID_REFRESH_TOKEN`, `429 RATE_LIMITED` |
| `GET`  | `/api/v1/auth/me`       | Bearer access token | None                        | `200` `{ "data": { "user" } }`           | `401 UNAUTHENTICATED`                                                   |

Request validation (Zod, unknown fields rejected):

- `name`: string, trimmed, 1–100 characters.
- `email`: string, trimmed and lowercased, valid address, at most 254 characters.
- `password`: string, used exactly as sent (never trimmed). Registration requires 12–128 characters; login accepts 1–128.
- `refreshToken`: string, 1–256 characters.

Error bodies:

| Code                    | Status | Message                                        | Notes                                                                                                                                                          |
| ----------------------- | ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`      | `400`  | `The request contains invalid fields`          | `details: [{ "field", "message" }]`; unknown fields report `Unknown field`; a missing body reports field `body`. Submitted values are never echoed.            |
| `INVALID_CREDENTIALS`   | `401`  | `Email or password is incorrect`               | Same body for an unknown email and a wrong password.                                                                                                           |
| `INVALID_REFRESH_TOKEN` | `401`  | `Refresh token is invalid, expired or revoked` | Unknown, expired, revoked or already-used token; repeated logout.                                                                                              |
| `UNAUTHENTICATED`       | `401`  | `A valid access token is required`             | Also sends `WWW-Authenticate: Bearer`. Missing, malformed, forged, expired or revoked-session token, a refresh token, or more than one `Authorization` header. |
| `CONFLICT`              | `409`  | `An account with this email already exists`    | Reveals that the address is registered; revisit with email verification.                                                                                       |
| `RATE_LIMITED`          | `429`  | `Too many requests, try again later`           | Sends `Retry-After`.                                                                                                                                           |

### Books

A `Book` is a reader's private catalogue entry, not a physical copy. Every endpoint requires `Authorization: Bearer <accessToken>` (the `requireAuthenticatedUser` middleware) and only ever reads or changes the caller's own non-deleted books; the owner comes from the access token, never from the request. DTOs: `src/modules/books/book.dto.ts`. Bruno: `bruno/Books/`.

```ts
interface BookDto {
  id: string; // 24-character lowercase hex
  title: string;
  authors: string[]; // [] when none
  format: 'physical' | 'ebook';
  isbn?: string; // as entered (trimmed)
  edition?: string;
  description?: string;
  coverUrl?: string; // stored only, never fetched by the API
  pageCount?: number;
  chapterCount?: number;
  publicationYear?: number;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

interface DuplicateSuggestionDto {
  book: BookDto;
  matchedOn: Array<'title' | 'isbn'>; // always in this order
}
```

Optional fields that are unset are **omitted** from responses (never `null`).

| Method   | Path                            | Request                | Success                                                                                             | Errors                                                                         |
| -------- | ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/books`                 | Body: book fields      | `201` `{ "data": BookDto }`, `Location: /api/v1/books/{id}`                                         | `400 VALIDATION_ERROR`, `401`                                                  |
| `GET`    | `/api/v1/books`                 | Query: list parameters | `200` `{ "data": BookDto[], "meta": { "pagination": { "page", "limit", "total", "totalPages" } } }` | `400 VALIDATION_ERROR`, `401`                                                  |
| `GET`    | `/api/v1/books/duplicate-check` | Query: `title`, `isbn` | `200` `{ "data": { "matches": DuplicateSuggestionDto[] } }`                                         | `400 VALIDATION_ERROR`, `401`                                                  |
| `GET`    | `/api/v1/books/:bookId`         | —                      | `200` `{ "data": BookDto }`                                                                         | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                 |
| `PATCH`  | `/api/v1/books/:bookId`         | Body: fields to change | `200` `{ "data": BookDto }`                                                                         | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`, `409 BOOK_HAS_PHYSICAL_COPIES` |
| `DELETE` | `/api/v1/books/:bookId`         | —                      | `204`, empty body                                                                                   | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                 |

`401` is the standard `UNAUTHENTICATED` response with `WWW-Authenticate: Bearer`.

**Book fields** (JSON body, strict: any other field, including `ownerId`, `userId`, `_id`, `id`, `deletedAt`, `normalizedTitle`, `normalizedIsbn`, `readingStatus`, `copyCount`, `createdAt`, is rejected as `Unknown field`):

| Field             | Create   | Rules                                                                                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------- |
| `title`           | required | string; trimmed, inner whitespace collapsed to one space; 1–250 characters              |
| `format`          | required | `physical` or `ebook`                                                                   |
| `authors`         | optional | array of up to 20 strings, each trimmed and 1–120 characters; defaults to `[]`          |
| `isbn`            | optional | string, trimmed, at most 32 characters, at least one letter or digit; stored as entered |
| `edition`         | optional | string, trimmed, 1–100 characters                                                       |
| `description`     | optional | string, trimmed, 1–5,000 characters (line breaks kept)                                  |
| `coverUrl`        | optional | absolute `http` or `https` URL, at most 2,048 characters                                |
| `pageCount`       | optional | JSON integer 1–100,000                                                                  |
| `chapterCount`    | optional | JSON integer 1–10,000                                                                   |
| `publicationYear` | optional | JSON integer 1–9999                                                                     |

Empty optional strings (blank after trimming) are rejected rather than stored; omit the field instead. On create, `null` is not accepted for any field.

**PATCH semantics:** an omitted field is unchanged; `null` clears `isbn`, `edition`, `description`, `coverUrl`, `pageCount`, `chapterCount` or `publicationYear`; `"authors": []` clears authors; `title`, `format` and `authors` cannot be `null`. An empty body is rejected with detail `{ "field": "body", "message": "must change at least one field" }`.

**List parameters** (query string; each at most once, a repeated parameter fails with `must be given only once`; unknown parameters are rejected):

| Parameter | Default  | Rules                                                                                                          |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `page`    | `1`      | positive whole number without leading zeros                                                                    |
| `limit`   | `20`     | 1–100                                                                                                          |
| `q`       | —        | trimmed, at most 120 characters, at least one letter or digit                                                  |
| `format`  | —        | `physical` or `ebook`                                                                                          |
| `sort`    | `recent` | `recent` (newest first), `oldest`, `title_asc`, `title_desc`; ties always broken by `id` in the same direction |

- **Search (`q`)** uses MongoDB text search over `title` and `authors` without language rules: a book matches if its title or authors contain **any** of the words, as whole words, case- and diacritic-insensitively. There is no stemming, prefix, fuzzy or relevance ordering; results follow `sort`. Quotes and hyphens are treated as spaces, so MongoDB phrase and negation syntax is not available (`Jean-Paul` searches `Jean` and `Paul`).
- **Title sort** compares titles ignoring case, in Unicode code-point order (not locale collation).
- `format` and `q` apply to both `data` and `pagination.total`. A page past the end returns `data: []` with the same metadata. `totalPages` is `0` when there are no books.

**Duplicate check:** query `title` and/or `isbn` (at least one; each non-blank and valid as on create). Returns up to 10 of the caller's non-deleted books whose title matches ignoring case and extra whitespace (punctuation is significant) and/or whose ISBN matches ignoring case, spaces and hyphens, newest first with `id` as the tie-breaker. Suggestions are informational: creating a duplicate title or ISBN is always allowed. A missing query fails with detail `{ "field": "query", "message": "provide a title, an isbn or both" }`.

**Identifiers and not-found:** a `bookId` that is not 24 hexadecimal characters fails with `400 VALIDATION_ERROR` and detail `{ "field": "bookId", "message": "must be a 24-character hexadecimal id" }`. A well-formed id that does not exist, was deleted or belongs to another reader returns the identical `404 { "error": { "code": "NOT_FOUND", "message": "Book not found", "requestId": "<id>" } }`.

**Deletion is soft:** `DELETE` marks the book deleted and returns `204`. The book then behaves as missing everywhere (get, update, list, search, duplicate check, repeated delete gives `404`). Its record is kept so that later reading history, notes, copies and loans are never destroyed; there is no restore or purge endpoint yet. Its physical copies are kept unchanged (including their locations) and are hidden by every copy endpoint while the book is deleted.

**Format changes and physical copies:** `PATCH` with `"format": "ebook"` fails with `409 { "error": { "code": "BOOK_HAS_PHYSICAL_COPIES", "message": "A book with physical copies cannot become an ebook", "requestId": "<id>" } }` if the book has, or ever had, a physical copy (deleted copies count, because future loans may reference them). Nothing in the request is applied. Books without copy history can change format freely. Another reader's book still gives `404`.

**Reading status** is not part of a book. Books without reading sessions will be treated as unread by the future reading module.

### Locations

A storage location is a named place where a reader keeps physical copies (`Home`, `Office`, `Study Shelf`). Locations belong to one reader. Every endpoint requires a bearer access token. DTO: `src/modules/locations/location.dto.ts`. Bruno: `bruno/Locations/`.

```ts
interface StorageLocationDto {
  id: string; // 24-character lowercase hex
  name: string;
  description?: string; // omitted when unset
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}
```

| Method  | Path                            | Request                                                | Success                                                                    | Errors                                                         |
| ------- | ------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST`  | `/api/v1/locations`             | `{ name, description? }`                               | `201` `{ "data": StorageLocationDto }`, `Location: /api/v1/locations/{id}` | `400 VALIDATION_ERROR`, `401`, `409 CONFLICT`                  |
| `GET`   | `/api/v1/locations`             | Query: `page` (default 1), `limit` (1–100, default 20) | `200` `{ "data": StorageLocationDto[], "meta": { "pagination" } }`         | `400 VALIDATION_ERROR`, `401`                                  |
| `GET`   | `/api/v1/locations/:locationId` | —                                                      | `200` `{ "data": StorageLocationDto }`                                     | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                 |
| `PATCH` | `/api/v1/locations/:locationId` | `{ name?, description? }`, at least one                | `200` `{ "data": StorageLocationDto }`                                     | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`, `409 CONFLICT` |

- **Fields (strict; `ownerId`, `normalizedName` and any other field are rejected as `Unknown field`):** `name` is trimmed with inner whitespace collapsed, 1–100 characters, and cannot be `null`. `description` is trimmed, 1–500 characters; on PATCH `null` clears it. Blank optional strings are rejected.
- **Unique names per reader:** names are compared after collapsing whitespace, Unicode NFC composition and lowercasing, enforced by a unique database index (so concurrent requests cannot create duplicates). A clash returns `409 { "error": { "code": "CONFLICT", "message": "A location with this name already exists", "requestId": "<id>" } }`. Different readers may use the same name, and renaming a location to a different capitalisation of its own name is allowed.
- **Ordering:** alphabetical by the case-insensitive name (Unicode code-point order), then `id`. Only `page` and `limit` are accepted.
- **Not found:** a missing location and another reader's location both return `404 { "error": { "code": "NOT_FOUND", "message": "Location not found", "requestId": "<id>" } }`; a malformed id gives `400` with a `locationId` detail.
- **No deletion yet:** there is deliberately no `DELETE` endpoint (it returns `404 Route not found`). Copies may reference a location, and removing or hiding one needs a reassignment and history policy that is not designed yet.

### Physical copies

A physical copy is one specific item of a reader's **physical** book, with its own label, condition, storage note and optional location. Several copies of one book, and copies of different books, may share a location. Ebooks never have copies. DTO: `src/modules/copies/copy.dto.ts`. Bruno: `bruno/Copies/`.

```ts
type PhysicalCopyCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor';

interface PhysicalCopyDto {
  id: string;
  bookId: string;
  locationId: string | null; // null when unassigned
  label?: string; // omitted when unset
  condition?: PhysicalCopyCondition; // omitted means not assessed
  storageNote?: string; // omitted when unset
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}
```

| Method   | Path                           | Request                                                             | Success                                                              | Errors                                                                                     |
| -------- | ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POST`   | `/api/v1/books/:bookId/copies` | `{ label?, condition?, storageNote?, locationId? }` (body optional) | `201` `{ "data": PhysicalCopyDto }`, `Location: /api/v1/copies/{id}` | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` (book or location), `409 BOOK_NOT_PHYSICAL` |
| `GET`    | `/api/v1/books/:bookId/copies` | Query: `page`, `limit`, `locationId?`, `condition?`                 | `200` `{ "data": PhysicalCopyDto[], "meta": { "pagination" } }`      | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` (book or location)                          |
| `GET`    | `/api/v1/copies/:copyId`       | —                                                                   | `200` `{ "data": PhysicalCopyDto }`                                  | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                             |
| `PATCH`  | `/api/v1/copies/:copyId`       | `{ label?, condition?, storageNote?, locationId? }`, at least one   | `200` `{ "data": PhysicalCopyDto }`                                  | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` (copy or location)                          |
| `DELETE` | `/api/v1/copies/:copyId`       | —                                                                   | `204`, empty body                                                    | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                             |

- **Fields (strict):** `label` trimmed 1–100; `condition` one of the five values; `storageNote` trimmed 1–500; `locationId` a 24-character hex id of one of the reader's locations, or `null`. `ownerId`, `userId`, `bookId`, `_id`, `deletedAt`, `isOnLoan`, `isAvailable` and any other field are rejected as `Unknown field`; a copy can never be moved to another book or reader. Blank strings are rejected. On create every field may be omitted (an empty or missing body creates an unassigned, unlabelled copy) and `locationId` may be `null`. On PATCH an omitted field is unchanged and `null` clears it (`locationId: null` unassigns the copy); an empty body is rejected.
- **Parent book:** creating requires one of the reader's active books. A missing, deleted or foreign book (including another reader's ebook) returns `404 "Book not found"`; the reader's own ebook returns `409 { "error": { "code": "BOOK_NOT_PHYSICAL", "message": "Physical copies can only be added to physical books", "requestId": "<id>" } }`. Listing copies of the reader's own ebook returns an empty page.
- **Locations:** any `locationId` (body or list filter) must be one of the reader's locations; a missing or foreign location gives `404 "Location not found"` without saying which.
- **Listing:** newest first, `id` as tie-breaker. `page` ≥ 1 (default 1), `limit` 1–100 (default 20), optional `locationId` and `condition` filters (applied to `total` too); each parameter at most once, others rejected. Filtering for unassigned copies is not supported yet.
- **Visibility:** a copy is visible only while it and its parent book are both active. Copies of a deleted book return `404 "Copy not found"` from get, update and delete, and listing a deleted book's copies returns `404 "Book not found"`.
- **Deletion is soft:** `DELETE` marks the copy deleted and returns `204`; it then behaves as missing everywhere, and a repeated delete returns `404`. The record is kept for future lending history.
- **No lending status:** there is no `isAvailable` or `isOnLoan`; availability will be derived from active loans.

### Reading sessions

A reading session is **one distinct reading of a book** (physical or ebook). Starting, progressing and finishing happen on a session; rereading starts a new one, and earlier sessions are never overwritten. Books do not store a reading status; it is derived from sessions by the reading overview. Sessions attach to the book, not to a physical copy. Every endpoint requires a bearer access token. DTOs: `src/modules/reading/reading.dto.ts`. Bruno: `bruno/Reading/`.

```ts
type ReadingProgress =
  | { unit: 'pages'; value: number }
  | { unit: 'chapters'; value: number }
  | { unit: 'percent'; value: number };

interface ReadingSessionDto {
  id: string; // 24-character lowercase hex
  bookId: string;
  status: 'in_progress' | 'completed';
  progress: ReadingProgress | null; // always present; null when not recorded
  startedOn?: string; // YYYY-MM-DD, omitted when unset
  completedOn?: string; // YYYY-MM-DD, omitted when unset
  rating?: number; // 1–5, omitted when unset
  summary?: string; // omitted when unset
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

type BookReadingStatus = 'unread' | 'reading' | 'completed';

interface BookReadingOverviewDto {
  bookId: string;
  status: BookReadingStatus;
  totalSessions: number;
  completedSessions: number;
  activeSession: ReadingSessionDto | null;
  lastCompletedSession: ReadingSessionDto | null;
}
```

| Method  | Path                                     | Request                        | Success                                                                          | Errors                                                                                                                  |
| ------- | ---------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST`  | `/api/v1/books/:bookId/reading-sessions` | Session fields (body optional) | `201` `{ "data": ReadingSessionDto }`, `Location: /api/v1/reading-sessions/{id}` | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found", `409 READING_SESSION_IN_PROGRESS`                      |
| `GET`   | `/api/v1/books/:bookId/reading-sessions` | History query                  | `200` `{ "data": ReadingSessionDto[], "meta": { "pagination" } }`                | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found"                                                         |
| `GET`   | `/api/v1/books/:bookId/reading-overview` | —                              | `200` `{ "data": BookReadingOverviewDto }`                                       | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found"                                                         |
| `GET`   | `/api/v1/reading-sessions`               | History query                  | `200` `{ "data": ReadingSessionDto[], "meta": { "pagination" } }`                | `400 VALIDATION_ERROR`, `401`                                                                                           |
| `GET`   | `/api/v1/reading-sessions/:sessionId`    | —                              | `200` `{ "data": ReadingSessionDto }`                                            | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Reading session not found"                                              |
| `PATCH` | `/api/v1/reading-sessions/:sessionId`    | Fields to change, at least one | `200` `{ "data": ReadingSessionDto }`                                            | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`, `409 INVALID_READING_TRANSITION`, `409 READING_SESSION_UPDATE_CONFLICT` |

There is no endpoint to delete a reading session.

**Fields (strict; `ownerId`, `userId`, `bookId`, `_id`, `readingStatus`, `createdAt` and any other field are rejected as `Unknown field`):**

| Field         | Rules                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `status`      | `in_progress` (default on create) or `completed`; cannot be `null`                                                   |
| `progress`    | exactly one metric: `pages` integer 0–100,000, `chapters` integer 0–10,000 or `percent` integer 0–100; no extra keys |
| `startedOn`   | existing calendar date `YYYY-MM-DD` (year 0001–9999; `2026-02-30` is rejected), stored and returned exactly as sent  |
| `completedOn` | as `startedOn`; only on a completed session, and on or after `startedOn` when both are set                           |
| `rating`      | integer 1–5                                                                                                          |
| `summary`     | trimmed, 1–5,000 characters; a short personal summary, not the notes feature                                         |

- **Create:** every field is optional; an empty or missing body starts an in-progress session. `"status": "completed"` records an earlier read in one request, and needs no date, rating, summary or progress. `null` is not accepted on create.
- **PATCH:** omitted fields are unchanged; `null` clears `progress`, `startedOn`, `completedOn`, `rating` or `summary`. The date rules are checked against the **resulting** session, so for example setting `completedOn` on an in-progress session without completing it fails with detail `{ "field": "completedOn", "message": "can only be set on a completed reading session" }`, and a completion before the start fails with `{ "field": "completedOn", "message": "must be on or after startedOn" }`.
- **Progress limits:** when progress is set (on create or PATCH), a `pages` value may not exceed the book's current `pageCount` and a `chapters` value may not exceed its `chapterCount` (detail `{ "field": "progress.value", "message": "must not exceed the book's page count" }` or `... chapter count`). Unknown counts impose no limit beyond the ranges above, and percent is never compared with book metadata. Progress already stored is never rewritten when a book's counts later change, so historical progress may exceed a reduced count. Reaching the end never completes a session.
- **Dates are calendar days:** no time zone conversion is applied, and no date is ever filled in automatically (finishing does not set `completedOn`).

**State machine:**

- `in_progress → completed` via PATCH `{ "status": "completed" }` (optionally with completion details).
- `completed` is final for status: `{ "status": "in_progress" }` on a completed session returns `409 { "error": { "code": "INVALID_READING_TRANSITION", "message": "A completed reading session cannot be reopened; start a new session to reread the book", "requestId": "<id>" } }`. Ratings, summaries, progress and dates of a completed session can still be corrected.
- **One in-progress session per book**, enforced by a partial unique database index: starting another returns `409 { "error": { "code": "READING_SESSION_IN_PROGRESS", "message": "This book already has a reading session in progress", "requestId": "<id>" } }`. Any number of completed sessions is allowed, including recording a completed one while a read is in progress. Finishing the active session frees the slot for a reread.
- **Concurrent edits:** each PATCH is validated against the version of the session it writes to; a concurrent change makes the server re-read and re-validate (so the request may then fail with `400` or `409 INVALID_READING_TRANSITION`). If the session keeps changing for five attempts, the request fails with `409 READING_SESSION_UPDATE_CONFLICT` and can be retried.

**Overview:** `status` is `reading` while a session is in progress (even if earlier reads were completed), otherwise `completed` if any session is completed, otherwise `unread`. `lastCompletedSession` is the most recently **created** completed session (ties broken by `id`); `completedOn` is never guessed.

**History query** (both list endpoints; each parameter at most once, unknown parameters rejected): `page` ≥ 1 (default 1), `limit` 1–100 (default 20), optional `status` (`in_progress` | `completed`), `sort` `recent` (default) or `oldest` by creation time with `id` as tie-breaker. Empty history returns `data: []` with `totalPages: 0`.

**Visibility:** a session is visible only while it belongs to the reader **and** its book is one of the reader's active books. A missing session, another reader's session and a session of a deleted book all return the same `404 "Reading session not found"`; book-scoped endpoints return `404 "Book not found"` for a missing, deleted or foreign book. `GET /reading-sessions` excludes sessions of deleted books **before** counting and paging, so totals and pages are exact. Deleting a book keeps all its sessions stored.

### Notes and highlights

A note is a **private, book-level record** about one of the reader's books (physical or ebook). `kind` is fixed at creation: a `note` is the reader's own writing and a `highlight` is a quotation from the book, optionally with the reader's `commentary`. A note may be linked to one reading session of the same book (for example thoughts from a reread). Every endpoint requires a bearer access token. DTOs: `src/modules/notes/note.dto.ts`. Bruno: `bruno/Notes/`.

```ts
type NoteKind = 'note' | 'highlight';

interface NoteDto {
  id: string; // 24-character lowercase hex
  bookId: string;
  readingSessionId: string | null; // always present; null for a book-level note
  kind: NoteKind;
  content: string; // note: Markdown source; highlight: plain-text quotation
  title?: string; // omitted when unset
  commentary?: string; // Markdown source, omitted when unset
  chapter?: string; // free-text label as entered, omitted when unset
  pageNumber?: number; // omitted when unset
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}
```

| Method   | Path                          | Request                        | Success                                                     | Errors                                                                                                                              |
| -------- | ----------------------------- | ------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/books/:bookId/notes` | Note fields                    | `201` `{ "data": NoteDto }`, `Location: /api/v1/notes/{id}` | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found" or "Reading session not found", `409 READING_SESSION_BOOK_MISMATCH` |
| `GET`    | `/api/v1/books/:bookId/notes` | Notes query                    | `200` `{ "data": NoteDto[], "meta": { "pagination" } }`     | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found" or "Reading session not found", `409 READING_SESSION_BOOK_MISMATCH` |
| `GET`    | `/api/v1/notes`               | Notes query + `bookId`         | `200` `{ "data": NoteDto[], "meta": { "pagination" } }`     | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found" or "Reading session not found", `409 READING_SESSION_BOOK_MISMATCH` |
| `GET`    | `/api/v1/notes/:noteId`       | —                              | `200` `{ "data": NoteDto }`                                 | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Note not found"                                                                     |
| `PATCH`  | `/api/v1/notes/:noteId`       | Fields to change, at least one | `200` `{ "data": NoteDto }`                                 | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Note not found"                                                                     |
| `DELETE` | `/api/v1/notes/:noteId`       | —                              | `204`, empty body                                           | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Note not found"                                                                     |

**Fields (strict; `ownerId`, `userId`, `bookId`, `id`, `chapterKey`, `deletedAt`, `createdAt` and any other field are rejected as `Unknown field`). Lengths count characters after trimming:**

| Field              | Rules                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `kind`             | `note` or `highlight`; required on create, can never be changed                                               |
| `content`          | required; trimmed, 1–20,000 characters for a note, 1–5,000 for a highlight; cannot be cleared                 |
| `title`            | trimmed, 1–160 characters                                                                                     |
| `commentary`       | trimmed, 1–5,000 characters; the reader's reflection, usually on a highlight but allowed on either kind       |
| `chapter`          | trimmed, 1–200 characters; a free-text label such as `Chapter 3` or `Introduction`, not a pointer into a file |
| `pageNumber`       | integer 1–100,000; a reference only, never compared with the book's `pageCount` or treated as progress        |
| `readingSessionId` | create only: a 24-character hex id of a visible reading session **of the same book**, or `null` (default)     |

- **Text is stored verbatim.** Only surrounding whitespace is trimmed; inner whitespace, line breaks, punctuation and quotation marks are kept exactly. `content` of a note and `commentary` are **Markdown source**; a highlight's `content` is plain text. The API never renders, sanitizes or interprets this text and never returns HTML. A client must render Markdown with safe escaping and must not trust raw HTML embedded in it.
- **Size:** the 100 kB JSON body limit applies to every request. Ordinary text fits comfortably, but a maximal note made mostly of multi-byte or `\u`-escaped characters can exceed it and is rejected with `413 PAYLOAD_TOO_LARGE`.
- **Create:** `kind` and `content` are required; `readingSessionId` omitted or `null` makes a book-level note. The book is checked first, then the session: a malformed id gives `400` naming the field; a missing, deleted or foreign book gives `404 "Book not found"`; a missing session, another reader's session or a session of a deleted book gives `404 "Reading session not found"`; the reader's own visible session of **another** book gives `409 { "error": { "code": "READING_SESSION_BOOK_MISMATCH", "message": "The reading session belongs to a different book", "requestId": "<id>" } }`. Any failure stores nothing. In-progress and completed sessions can both be linked.
- **PATCH:** may change `content`, `title`, `commentary`, `chapter` and `pageNumber`. Omitted fields are unchanged; `null` clears `title`, `commentary`, `chapter` or `pageNumber`. `kind`, `readingSessionId` and the book can never change, so a note's attribution to a reading is permanent. A highlight's new `content` is still limited to 5,000 characters (detail `{ "field": "content", "message": "must be at most 5000 characters for a highlight" }`). Each PATCH writes only the fields it names, so concurrent edits of different fields both persist; for the same field the last write wins.
- **DELETE** is an explicit user action and soft: it returns `204` with no body, after which the note behaves as missing everywhere (get, PATCH, delete, lists, search, totals). The record is kept for future export or restore policies; there is no restore endpoint.
- **Visibility:** a note is visible only while it belongs to the reader, is not deleted, **and** its book is one of the reader's active books. A missing note, another reader's note, a deleted note and a note of a deleted book all return the same `404 "Note not found"`. Deleting a book or completing a session never deletes or changes notes; a deleted book's notes are hidden and stay stored.

**Notes query** (both list endpoints; each parameter at most once; unknown parameters rejected):

| Parameter          | Rules                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`, `limit`    | `page` ≥ 1 (default 1), `limit` 1–100 (default 20)                                                                                                                                                 |
| `sort`             | `recent` (default) or `oldest`, by creation time with `id` as tie-breaker in the same direction; never by relevance                                                                                |
| `kind`             | `note` or `highlight`                                                                                                                                                                              |
| `q`                | trimmed, 1–120 characters with at least one letter or digit; word search (see below)                                                                                                               |
| `chapter`          | trimmed, 1–200 characters; exact label match ignoring case, spacing and Unicode composition (`CAFÉ  society` matches `Café Society`, whether `é` is one code point or `e` plus a combining accent) |
| `readingSessionId` | a visible session of the reader; on the book list (or with `bookId`) it must belong to that book, otherwise `409 READING_SESSION_BOOK_MISMATCH`                                                    |
| `bookId`           | `GET /notes` only: one of the reader's active books                                                                                                                                                |

- A requested book or session that is missing, deleted or foreign returns `404` ("Book not found" / "Reading session not found"), never an empty page.
- **Search** (`q`) uses the owner-scoped MongoDB text index over `title`, `content`, `commentary` and `chapter`. It matches whole words (no prefixes, fuzziness or stemming), ignores case and diacritics, and returns notes containing **any** of the words. Quotes and hyphens are treated as plain text, not phrase or negation operators, and the query is never used as a regular expression.
- `GET /notes` excludes notes of deleted books **before** counting and paging, so totals and pages are exact. Empty results return `data: []` with `total: 0` and `totalPages: 0`.
- Request logs record only method, path (with ids), status and request id; note text, search terms and other query parameters are never logged, and validation errors never echo submitted text.

### Categories and collections

A **category** classifies a book by subject or type (`Philosophy`, `Fiction`); a **collection** is a reader-curated shelf or list (`To Read in 2027`, `Books for Isioma`). Both group **books** (physical or ebook catalogue entries), never copies, sessions or notes; a book may be in any number of either, and a group may be empty. The two kinds have identical behaviour and are stored separately, so a reader may have a category and a collection with the same name. Grouping never changes the book: `BookDto`, `GET /books` and the book's reading status and notes are untouched. Every endpoint requires a bearer access token. DTOs: `src/modules/categories/category.dto.ts`, `src/modules/collections/collection.dto.ts`, `src/modules/organization/organization.dto.ts`. Bruno: `bruno/Categories/`, `bruno/Collections/`.

```ts
interface CategoryDto {
  id: string; // 24-character lowercase hex
  name: string;
  description?: string; // omitted when unset
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC; advances on rename, description change or membership change
}

interface BookCollectionDto {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface BookOrganizationDto {
  bookId: string;
  categories: CategoryDto[]; // the reader's active categories containing the book, alphabetical
  collections: BookCollectionDto[]; // likewise for collections
}
```

Memberships are never part of a group DTO; a group's books are read through its own books endpoint, and a book's groups through the organization endpoint.

| Method   | Path                                         | Request                                                | Success                                                                               | Errors                                                                                                          |
| -------- | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/categories/presets`                 | —                                                      | `200` `{ "data": { "names": string[] } }`                                             | `401`                                                                                                           |
| `POST`   | `/api/v1/categories` · `/api/v1/collections` | `{ name, description? }`                               | `201` `{ "data": CategoryDto \| BookCollectionDto }`, `Location: /api/v1/{kind}/{id}` | `400 VALIDATION_ERROR`, `401`, `409 CONFLICT`                                                                   |
| `GET`    | `/api/v1/categories` · `/api/v1/collections` | Query: `page` (default 1), `limit` (1–100, default 20) | `200` `{ "data": [...], "meta": { "pagination" } }`                                   | `400 VALIDATION_ERROR`, `401`                                                                                   |
| `GET`    | `/api/v1/{kind}/:id`                         | —                                                      | `200` `{ "data": ... }`                                                               | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                                                  |
| `PATCH`  | `/api/v1/{kind}/:id`                         | `{ name?, description? }`, at least one                | `200` `{ "data": ... }`                                                               | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`, `409 CONFLICT`                                                  |
| `DELETE` | `/api/v1/{kind}/:id`                         | —                                                      | `204`, empty body                                                                     | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                                                  |
| `PUT`    | `/api/v1/{kind}/:id/books/:bookId`           | —                                                      | `204`, empty body (idempotent add)                                                    | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found" / "Category not found" / "Collection not found" |
| `DELETE` | `/api/v1/{kind}/:id/books/:bookId`           | —                                                      | `204`, empty body (idempotent remove)                                                 | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` (as above)                                                       |
| `GET`    | `/api/v1/{kind}/:id/books`                   | Query: `page`, `limit`                                 | `200` `{ "data": BookDto[], "meta": { "pagination" } }`                               | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND`                                                                  |
| `GET`    | `/api/v1/books/:bookId/organization`         | —                                                      | `200` `{ "data": BookOrganizationDto }`                                               | `400 VALIDATION_ERROR`, `401`, `404 NOT_FOUND` "Book not found"                                                 |

`{kind}` is `categories` (route parameter `categoryId`) or `collections` (`collectionId`). Responses under `/api/v1/categories` and `/api/v1/collections` send `Cache-Control: no-store`, like the other private paths; the organization endpoint inherits the `/api/v1/books` rule.

- **Presets** are a fixed, read-only suggestion list in a deterministic order: `Fiction`, `Nonfiction`, `Biography`, `History`, `Philosophy`, `Psychology`, `Science`, `Technology`, `Religion`, `Personal Development`. They are never stored and never depend on the account: registering creates no categories, listing creates none, and a reader who created or deleted `Philosophy` still sees it suggested. A reader materializes a category only with `POST /categories`, with any name, preset or not.
- **Fields (strict; `ownerId`, `normalizedName`, `bookIds`, `deletedAt`, `id` and any other field are rejected as `Unknown field`):** `name` is trimmed with inner whitespace collapsed, 1–100 characters, and cannot be `null`; `description` is trimmed, 1–500 characters, and on PATCH `null` clears it. Blank strings are rejected.
- **Unique names per reader and kind:** among a reader's **active** groups of one kind, names are unique after collapsing whitespace, Unicode NFC composition and lowercasing, enforced by a partial unique database index (`deletedAt: null`), so concurrent creates and renames cannot produce duplicates. A clash returns `409 { "error": { "code": "CONFLICT", "message": "A category with this name already exists", "requestId": "<id>" } }` (or `A collection ...`), without database details. Different readers may use the same name; a case-only rename keeps the new casing; a deleted group's name may be reused by a new, empty group.
- **Ordering:** group lists are alphabetical by the case-insensitive name (Unicode code-point order), then `id`. Only `page` and `limit` are accepted, each at most once.
- **Memberships:** `PUT` adds the book and `DELETE` removes it, both idempotent (`204` whether or not anything changed). Both require an active group of the reader and an active book of the reader; the book is checked first, so a malformed `bookId` gives `400` naming it, a missing, deleted or foreign book gives `404 "Book not found"`, and then a missing, deleted or foreign group gives `404 "Category not found"` / `"Collection not found"`. Nothing is ever created implicitly. Membership order is the order of first addition; adding an existing member does not move it, and a book removed and later re-added goes to the end. There is no reorder endpoint.
- **A group's books** (`GET /{kind}/:id/books`) returns `BookDto` records in membership order (not creation or title order), paged with `page` and `limit`. Deleted books are removed **before** counting and paging, so `total` and the pages reflect only visible books and have no gaps. A deleted or foreign group returns `404`.
- **Organization** (`GET /books/:bookId/organization`) lists the reader's active categories and collections that contain the book, each alphabetical; both lists are `[]` for an unorganized book. A missing, foreign or deleted book returns `404 "Book not found"`; deleted groups never appear.
- **Deletion is soft:** `DELETE /{kind}/:id` returns `204` with no body, after which the group and its memberships behave as missing everywhere (get, list, PATCH, delete, memberships, books list, organization) and a repeated delete returns `404`. The record is kept; no book, copy, reading session, note or loan is changed. Deleting a book hides it from every group it was in (and from totals) without changing the groups; its membership id may stay stored.
- **Logging:** request logs record only method, path (with ids), status and request id; names, descriptions, titles and query strings are never logged, and error responses never echo submitted names.

### Responses on any path

The JSON body parser runs before routing, so body errors are reported even for paths that do not exist.

| Method               | Condition                                                                                                | Status                    | Body                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OPTIONS`            | Any path (CORS preflight)                                                                                | `204`                     | Empty. `Access-Control-Allow-*` headers are sent only for origins listed in `CORS_ORIGIN`                                     |
| Any                  | No matching route, including a known path with an unsupported method (for example `POST /api/v1/health`) | `404`                     | `{ "error": { "code": "NOT_FOUND", "message": "Route not found", "requestId": "<id>" } }`                                     |
| Any with a JSON body | Malformed JSON                                                                                           | `400`                     | `{ "error": { "code": "INVALID_JSON", "message": "Request body is not valid JSON", "requestId": "<id>" } }`                   |
| Any with a JSON body | Body over 100 kB                                                                                         | `413`                     | `{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "Request body exceeds the size limit", "requestId": "<id>" } }`         |
| Any with a JSON body | Unsupported charset or `Content-Encoding`                                                                | `415`                     | `{ "error": { "code": "UNSUPPORTED_MEDIA_TYPE", "message": "Request body encoding is not supported", "requestId": "<id>" } }` |
| Any with a JSON body | Any other client error from the body parser (for example an aborted request)                             | The parser's `4xx` status | `{ "error": { "code": "BAD_REQUEST", "message": "The request could not be processed", "requestId": "<id>" } }`                |
| Any                  | Unexpected server fault                                                                                  | `500`                     | `{ "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred", "requestId": "<id>" } }`                   |

A wrong method on a known path returns `404`, not `405 Method Not Allowed`. Changing that is an API contract change.

The Bruno collection is the detailed, executable source for each implemented endpoint. Update it whenever the endpoint changes.
