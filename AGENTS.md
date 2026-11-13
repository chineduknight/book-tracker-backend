# Book Tracker Backend: Engineering Instructions

These instructions apply to every change in this repository. Read `docs/decisions.md`, `docs/architecture.md`, and `docs/api-contract.md` before implementing API features. A task brief does not override these rules without an explicit product decision.

## Engineering standard

Build code a senior engineer can understand without an oral explanation. Optimize for correctness, clarity, secure behavior, and maintainability over cleverness or premature abstraction. Follow the practical principles of Robert C. Martin's _Clean Code_ without treating numerical rules (such as a fixed maximum function length) as dogma.

### Names carry meaning

- Use intention-revealing, searchable, pronounceable names. A name should communicate the business concept and its responsibility.
- Name functions with specific verbs: `registerBook`, `findBookOwnedByUser`, `recordLoanReturn`; name predicates `is...`, `has...`, or `can...`.
- Name values by what they represent: `book`, `ownerId`, `activeLoan`, `returnDate`, not `data`, `info`, `obj`, `temp`, `result1`, or ambiguous acronyms.
- Use domain language consistently: `Book` is a catalogue entry; `PhysicalCopy` is an item; `ReadingSession` is one read; `Loan` is one borrowing event.
- Avoid misleading names, redundant context, encoding types in names, and cryptic abbreviations. Short names are appropriate only for truly local, obvious use.
- Prefer consistent verbs across modules; don't alternate between `fetch`, `load`, and `get` for the same behavior without a meaningful distinction.

### Functions and modules read like prose

- Keep functions cohesive and focused on one level of abstraction. Extract named helpers when they clarify the intent, not to satisfy arbitrary line counts.
- Prefer guard clauses to deep nesting. Separate validation, business decisions, persistence, and HTTP serialization.
- Place business rules in services/domain logic; route handlers should validate/authorize, invoke the use case, and return the documented result.
- Prefer explicit dependencies and simple composition over invisible side effects, global mutable state, unnecessary inheritance, decorators, generic frameworks, or speculative interfaces.
- Eliminate duplication of **knowledge** and business rules, but do not create abstractions for one-off similarities.
- Make invalid states difficult to represent. Handle missing resources, conflicts, and concurrency explicitly.
- Prefer readability over micro-optimizations. Do not hide behavior in clever chained expressions or nested ternaries.

### Comments are exceptional

- Production code should be self-explanatory through naming, types, and structure. Do **not** add commentary that restates what the code does.
- A comment is justified only for a non-obvious **why**, an externally imposed constraint, a security invariant, or an important trade-off that cannot be expressed more clearly in code.
- If an explanatory comment seems necessary for routine flow, first improve the names or extract a concept.
- Remove stale, redundant, or misleading comments when modifying nearby code. Do not undertake unrelated mass comment removal.
- API contracts, architectural decisions, README files, and Bruno documentation are **documentation**, not prohibited code comments. Maintain them deliberately.

### TypeScript, Express, and MongoDB

- Runtime: Node.js **26.x**, TypeScript strict, Express 5, Mongoose, Zod, ES modules, npm lockfile. Follow existing configuration; do not silently change the stack.
- Avoid `any`, unverified casts, non-null assertions, and broad `unknown` propagation. Narrow at boundaries and prefer discriminated unions where useful.
- Validate external input with Zod. Derive types from schemas when appropriate. Never trust user-supplied `ownerId` or similar authorization fields.
- Scope every owner-specific read/write by the authenticated user ID. For another user's private record, respond as if absent.
- Use MongoDB indexes and atomic operations for invariants. A physical copy cannot have more than one active loan; enforce this in the database, not only by checking in application code.
- Keep Mongoose documents internal. Return deliberate public DTOs; do not leak `_id`, `__v`, password hashes, secrets, or persistence implementation details.
- Use structured logging, and use the existing safe error serializer. Never log raw exceptions containing potential secret material, credentials, tokens, bodies, or query strings.
- Do not store ebook files, uploaded images, or PDFs in V1. Book covers are external URLs with graceful fallbacks.

### API contracts are part of the feature

- Follow `docs/api-contract.md` for status codes, response envelopes, errors, pagination, dates, and ID serialization.
- For each endpoint, define a request validation schema, explicit response DTO/type, permitted status codes, authorization rule, and expected failures.
- Add or update its Bruno request(s), sample response documentation, assertions, and integration tests in the same PR.
- If you change the response format, treat it as an API contract change: update the docs, Bruno, tests, and affected callers together. Do not silently break established responses.
- Keep a standard success envelope and error envelope; prefer simple, explicit `res.status(...).json(...)` over a complicated generic response builder.

### Testing and quality

- Test behavior and invariants, not implementation trivia. Use descriptive test names that describe the expected result.
- Cover success, validation failures, authentication/authorization failures, not-found cases, concurrency where relevant, and meaningful edge cases.
- Unit-test pure rules; integration-test HTTP contracts and persistence behavior. Database invariants require real MongoDB-backed tests where feasible; mocking Mongoose alone is insufficient.
- Never commit real credentials, production data, `.env`, tokens, or unnecessary generated artifacts.
- Before opening a PR, run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run build`. Run relevant Bruno requests against a live development API when appropriate.
- Prefer explicit reviewable changes over broad refactors. Document trade-offs and any test limitations in the PR.

## Required workflow

1. Read the task scope, relevant existing code, architecture decisions, and API contract.
2. Plan the smallest cohesive implementation. Flag conflicts with existing invariants before changing them.
3. Work only on a dedicated branch. Do not commit to `main`.
4. Implement the behavior and tests; update Bruno and documentation in the same PR.
5. Self-review for naming, unnecessary comments, missing owner scoping, error handling, leaks, race conditions, and API compatibility.
6. Push the branch and open a PR with summary, behavior changes, test evidence, trade-offs, and known limitations.
7. **Stop. Never merge, deploy, provision paid services, or change production resources without explicit user approval.**
