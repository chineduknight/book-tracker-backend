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

| Status                       | Intended use                                                                   | Example code                       |
| ---------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `400 Bad Request`            | Validation errors, malformed JSON, invalid query/params                        | `VALIDATION_ERROR`, `INVALID_JSON` |
| `401 Unauthorized`           | Missing, invalid, or expired authentication                                    | `UNAUTHENTICATED`                  |
| `403 Forbidden`              | Authenticated user lacking permission for an action not concealed by ownership | `FORBIDDEN`                        |
| `404 Not Found`              | Missing route, missing resource, or resource owned by someone else             | `NOT_FOUND`                        |
| `409 Conflict`               | Duplicate resource or an active-loan uniqueness conflict                       | `CONFLICT`                         |
| `413 Payload Too Large`      | Body exceeds configured limit                                                  | `PAYLOAD_TOO_LARGE`                |
| `415 Unsupported Media Type` | Unsupported request encoding                                                   | `UNSUPPORTED_MEDIA_TYPE`           |
| `429 Too Many Requests`      | Rate limit exceeded once implemented                                           | `RATE_LIMITED`                     |
| `500 Internal Server Error`  | Unexpected server fault                                                        | `INTERNAL_ERROR`                   |
| `503 Service Unavailable`    | Not ready, including disconnected database                                     | `SERVICE_UNAVAILABLE`              |

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
