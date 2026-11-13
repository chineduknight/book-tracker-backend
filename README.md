# Book Tracker API

Backend for a personal library and reading tracker.

## Problem

Readers who own many books lose track of what they own, where each copy is, who borrowed it, and
what they thought of it. This API lets each user keep a private library: book titles, the physical
copies they own, reading sessions (including rereads), searchable general and chapter notes, and
lending history. Ebooks can be catalogued without storing any files.

This repository currently contains the **foundation only** (PR #1): app assembly, configuration,
MongoDB lifecycle, health/readiness probes, error handling, tests, CI and the Bruno collection.
No product endpoints exist yet.

## Stack

| Concern         | Choice                                                        |
| --------------- | ------------------------------------------------------------- |
| Runtime         | Node.js 26.x LTS (`.nvmrc`, `engines`, CI)                    |
| Language        | TypeScript (strict), ES modules                               |
| HTTP            | Express 5                                                     |
| Database        | MongoDB via Mongoose                                          |
| Validation      | Zod (environment now; request bodies in later modules)        |
| Logging         | pino / pino-http (structured JSON, sensitive values redacted) |
| Tests           | Vitest + Supertest (no database or secrets required)          |
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
npm run dev             # http://localhost:3000/api/v1/health
```

The server starts even if MongoDB is unreachable: `/health` responds immediately and `/ready`
returns 503 until a connection is established (connection attempts are retried every 5s).

## Environment variables

Validated with Zod at startup. Invalid configuration aborts with a list of offending variable
names; values are never printed.

| Variable      | Required | Default                 | Notes                                                        |
| ------------- | -------- | ----------------------- | ------------------------------------------------------------ |
| `MONGODB_URI` | yes      | —                       | `mongodb://` or `mongodb+srv://`. Keep credentials in `.env` |
| `NODE_ENV`    | no       | `development`           | `development` \| `test` \| `production`                      |
| `PORT`        | no       | `3000`                  | 1–65535                                                      |
| `CORS_ORIGIN` | no       | `http://localhost:5173` | Comma-separated exact origins. `*` is rejected               |
| `LOG_LEVEL`   | no       | `info`                  | `fatal` `error` `warn` `info` `debug` `trace` `silent`       |

`.env` and other `.env.*` files are git-ignored; only `.env.example` (fake values) is committed.

## Scripts

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Watch mode via `tsx`, loads `.env`, pretty logs                     |
| `npm run build`     | Compile `src/` → `dist/` with `tsc`                                 |
| `npm start`         | Run the compiled server (`dist/server.js`), loads `.env` if present |
| `npm run typecheck` | Type-check sources, tests and configs                               |
| `npm run lint`      | ESLint                                                              |
| `npm run format`    | Prettier write (`format:check` to verify)                           |
| `npm test`          | Vitest suite (`test:watch` for watch mode)                          |
| `npm run api:test`  | Run the Bruno collection against the local API                      |

## API

All routes are under `/api/v1`. Success bodies are `{ "data": ... }`; errors are
`{ "error": { "code", "message", "requestId", "details?" } }`. Every response carries an
`X-Request-Id` header (a safe caller-supplied value is echoed, otherwise a UUID is generated).
The [API contract](docs/api-contract.md) lists every status and body, including `HEAD`, CORS
preflight and request-body errors.

| Method | Path             | Purpose                                                 |
| ------ | ---------------- | ------------------------------------------------------- |
| GET    | `/api/v1/health` | Liveness. Always 200 while the process serves HTTP      |
| GET    | `/api/v1/ready`  | Readiness. 200 when MongoDB is connected, otherwise 503 |

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
├── modules/health/        # liveness and readiness routes + response DTOs
└── shared/                # AppError, response envelope types, safe error serializer
test/                      # Vitest + Supertest; MongoDB is mocked
bruno/                     # Bruno collection (API docs + executable examples)
docs/                      # architecture, product invariants, API contract
AGENTS.md                  # engineering standards (CLAUDE.md imports it)
```

See [docs/architecture.md](docs/architecture.md) and [docs/decisions.md](docs/decisions.md).

## Current scope

Included: scaffold, config validation, MongoDB lifecycle, health/readiness, security baseline
(helmet, CORS allowlist, 100 kB JSON limit), structured logging with redaction, error handling,
tests, CI, Bruno.

Not included yet: authentication, any book/copy/reading/note/loan endpoints, Mongoose models,
UI, deployment.

## Upcoming PRs

1. **Auth & users**: registration/login, password hashing, JWT, owner-scoping middleware.
2. **Books (titles)**: owner-scoped catalogue CRUD, formats including ebook catalogue entries,
   external cover URLs.
3. **Copies**: physical copies per title with locations.
4. **Reading sessions**: reads and rereads with optional completion date, rating and summary.
5. **Notes**: general and chapter notes with owner-scoped MongoDB text search.
6. **Loans**: lending history with one active loan per copy (partial unique index + race tests).
7. **Export**: full per-user data export.
