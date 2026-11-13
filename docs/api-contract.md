# Book Tracker REST API Contract (V1)

This document defines shared HTTP behavior. Every implemented endpoint must additionally have its own contract in the corresponding Bruno request: method/path, authentication, input validation, success status, exact success DTO, expected error statuses/codes, and representative examples. Bruno is our executable API documentation, not a replacement for typed DTOs or tests.

## General rules

- Base path: `/api/v1`.
- JSON responses use `Content-Type: application/json`; `204 No Content` has no body.
- All responses include an `X-Request-Id` header. Error responses also include `requestId` in the body if one was assigned.
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

| Status                       | Intended use                                                                   | Example code                                                      |
| ---------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `400 Bad Request`            | Validation errors, malformed JSON, invalid query/params                        | `VALIDATION_ERROR`, `INVALID_JSON`                                |
| `401 Unauthorized`           | Missing, invalid, or expired authentication; failed login or refresh           | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` |
| `403 Forbidden`              | Authenticated user lacking permission for an action not concealed by ownership | `FORBIDDEN`                                                       |
| `404 Not Found`              | Missing route, missing resource, or resource owned by someone else             | `NOT_FOUND`                                                       |
| `409 Conflict`               | Duplicate resource or an active-loan uniqueness conflict                       | `CONFLICT`                                                        |
| `413 Payload Too Large`      | Body exceeds configured limit                                                  | `PAYLOAD_TOO_LARGE`                                               |
| `415 Unsupported Media Type` | Unsupported request encoding                                                   | `UNSUPPORTED_MEDIA_TYPE`                                          |
| `429 Too Many Requests`      | Rate limit exceeded (authentication endpoints)                                 | `RATE_LIMITED`                                                    |
| `500 Internal Server Error`  | Unexpected server fault                                                        | `INTERNAL_ERROR`                                                  |
| `503 Service Unavailable`    | Not ready, including disconnected database                                     | `SERVICE_UNAVAILABLE`                                             |

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
