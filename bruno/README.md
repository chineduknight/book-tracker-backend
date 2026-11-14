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
├── Auth/                   # register, login, current user, refresh, logout (+ error cases)
├── Books/                  # catalogue create, duplicate check, list/search, get, update, delete
├── Locations/              # storage locations: create, duplicate, list, get, rename
├── Copies/                 # physical copies: create, ebook/format conflicts, list, update, delete
└── Reading/                # reading sessions: start, progress, finish, reread, history, overview
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

## Books requests

The **Books**, **Locations**, **Copies**, **Reading**, **Notes**, **Categories**,
**Collections**, **Wishlist**, **Loans**, **Dashboard** and **Export** folders each start by
registering their own disposable reader (`booksAccessToken`, `locationsAccessToken`,
`copiesAccessToken`, `readingAccessToken`, `notesAccessToken`, `categoriesAccessToken`,
`collectionsAccessToken`, `wishlistAccessToken`, `loansAccessToken`, `dashboardAccessToken`,
`exportAccessToken`) and create their own books, copies, locations, reading sessions, groups,
wishes and loans. The Export folder checks the empty downloads, then a populated library with a
soft-deleted ebook, and parses the CSV and Markdown downloads as text. The Dashboard folder checks the
empty dashboard first, then builds a small library and asserts exact derived counts. None reuses the Auth folder's tokens, which that folder
deliberately logs out, so each folder runs reliably on its own or as part of the whole collection.

## Repeatable runs: `npm run api:smoke`

`npm run api:smoke` is the recommended way to run the whole collection repeatedly. It builds the
API, drops and recreates only the dedicated `book-tracker-smoke` database, starts a fresh API on
port 3100 with a generated signing secret, runs the whole collection against it and stops the API.
Every run therefore starts from a clean state with fresh in-memory rate limits, so repeated runs
never hit the per-address registration limit and the limits themselves stay unchanged. CI runs the
same command.

Because it deletes data, the runner fails before connecting to anything unless:

- `MONGODB_SMOKE_URI` is a plain `mongodb://` URI with exactly one local host (`127.0.0.1`,
  `localhost` or `[::1]`), the `book-tracker-smoke` database and only harmless options
  (`appName`, `authMechanism`, `authSource`, `connectTimeoutMS`, `directConnection`,
  `serverSelectionTimeoutMS`). `mongodb+srv://`, remote or multiple hosts, replica-set discovery
  and proxies are refused, and both the reset and the API use `directConnection=true`. There is no
  remote opt-in.
- `SMOKE_PORT` is free. A port that is already in use stops the run before the reset, and Bruno
  only starts after the API process this run started reports that it is listening on that port.

Failures print only the runner's own messages or an error's name and code, never connection
strings.

A local address does not prove the database is disposable: an SSH tunnel or port forward on
`localhost` can lead to a remote server, and the runner cannot tell. Only run `api:smoke` when you
know the MongoDB listening locally is a throwaway instance, as in CI.

```bash
npm run api:smoke
# optional: MONGODB_SMOKE_URI=mongodb://127.0.0.1:27017/book-tracker-smoke SMOKE_PORT=3100
```

`npm run api:test` runs the collection against an API you started yourself (for example
`npm run dev`). A full run makes fifteen registration attempts (three in Auth, one in each other
folder), so against a long-running API only one full run fits in the hourly per-address
registration limit; restart the API or use `api:smoke`.

## Secrets

`environments/local.bru` holds only non-sensitive values. When authenticated endpoints arrive,
keep tokens out of committed files: use Bruno's secret environment variables or a `bruno/.env`
file (git-ignored by the root `.gitignore`) and reference them as `{{process.env.NAME}}`.

## Conventions for new endpoints

- One folder per module (`Books/`, `Copies/`, …) with a `folder.bru` for ordering.
- Every request has `assert` (or `tests`) for the status code and response envelope, plus a
  `docs` block describing the endpoint.
- Use `{{baseUrl}}`; never hard-code hosts.
