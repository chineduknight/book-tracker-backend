# Bruno collection

[Bruno](https://www.usebruno.com/) is the API documentation and executable request examples for
this project. Requests are plain-text `.bru` files committed alongside the code, so they are
reviewed and versioned with the API they describe.

```
bruno/
├── bruno.json              # collection manifest
├── collection.bru          # collection-level docs
├── environments/local.bru  # baseUrl for a locally running API (no secrets)
├── Health/                 # liveness + readiness probes
├── Errors/                 # standard error envelope examples
└── Auth/                   # register, login, current user, refresh, logout (+ error cases)
```

## Use the desktop app

1. Install Bruno from <https://www.usebruno.com/downloads>.
2. **Open Collection** → select this `bruno/` folder.
3. Pick the **local** environment in the top-right environment selector.
4. Start the API (`npm run dev`) and send any request. Assertions and tests run automatically and
   appear in the **Tests** tab of the response pane.

## Run from the command line

With the API running locally:

```bash
npm run api:test   # runs the whole collection with a pinned @usebruno/cli via npx
```

The CLI is fetched on demand rather than installed as a dev dependency, which keeps `npm ci` (and
CI) fast. The first run downloads it.

`Readiness` passes with either outcome: 200 when MongoDB is connected, or 503 with the
`SERVICE_UNAVAILABLE` error envelope when it is not. Stop MongoDB to see the 503 response.

## Auth requests

Run the **Auth** folder (or the whole collection) in order. **Register** creates a disposable
user with a generated `bruno-<run id>@example.test` email and random password; later requests
reuse them and the issued tokens through Bruno **runtime variables**, which live in memory for
the run and are never written to the collection. To send a single request by hand in the app,
run **Register** first.

Each run creates one account and makes three registration attempts, which counts towards the
per-address registration limit (20 per hour). Restarting the API resets the in-memory limits.

## Secrets

`environments/local.bru` holds only non-sensitive values. When authenticated endpoints arrive,
keep tokens out of committed files: use Bruno's secret environment variables or a `bruno/.env`
file (git-ignored by the root `.gitignore`) and reference them as `{{process.env.NAME}}`.

## Conventions for new endpoints

- One folder per module (`Books/`, `Copies/`, …) with a `folder.bru` for ordering.
- Every request has `assert` (or `tests`) for the status code and response envelope, plus a
  `docs` block describing the endpoint.
- Use `{{baseUrl}}`; never hard-code hosts.
