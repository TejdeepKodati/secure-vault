# Secure Vault

A personal, single-user file vault that runs in the browser: sign in with a PIN, then
upload, browse, preview, organise and recover your own files. This is a complete
implementation of *Secure Vault SRS v1.0*, sections 1 through 34.

It has **no third-party dependencies**. Everything — the HTTP router, the PIN hashing,
the session tokens, the multipart upload parser, the frontend — is written against the
Node.js and browser standard libraries. `npm install` has nothing to install, so
`git clone` and `node server.js` is the whole setup. The SRS names Express, bcrypt, JWT
and multer as suggestions and permits justified equivalents (SRS 3); the equivalents used
here are noted under [Deviations from the SRS](#deviations-from-the-srs).

## Requirements

Node.js 18.17 or newer, and a filesystem you can write to. Developed and verified on
Node 22. No database, no build step, no bundler, no compile pass.

## Quick start

```bash
cd secure-vault
cp .env.example .env      # optional in development; see Configuration
node server.js            # or: npm start
```

Open <http://localhost:3000>. On the very first boot the server prints a banner
containing a randomly generated six-digit PIN:

```
================================================================
  Secure Vault first-time setup
  Your PIN is:  216624

  This is shown once and is not recoverable from the stored hash.
  Sign in and change it from the profile menu.
================================================================
```

Sign in with that PIN. The app nudges you to change it, which you can do at any time from
the account menu in the top right. `npm test` runs the end-to-end suite (about ten seconds,
no dependencies to install).

## The PIN, and what happens on restart

The PIN is stored only as a scrypt hash with a per-user random salt, never in plaintext
and never in a form that can be reversed (SRS 24). That has one practical consequence
worth stating plainly: a lost PIN cannot be recovered, only reset.

`INITIAL_PIN` is consulted **only when no user record exists yet**. Once
`$DATA_DIR/user.json` has been written, that variable is ignored completely — restarting
the server with a different `INITIAL_PIN`, or with the variable removed, leaves the stored
PIN exactly as it was. A restart never silently restores a default (SRS 5).

**If you have genuinely lost the PIN**, stop the server, delete `$DATA_DIR/user.json`, and
start it once with `ALLOW_REINIT=true` (add `INITIAL_PIN=<new pin>` if you want to choose it;
otherwise a random one is printed to the log). Sign in, change the PIN, and remove
`ALLOW_REINIT` again. The flag is required because a missing `user.json` next to a vault full of
files is far more often a mis-mounted volume than a lost PIN, and the server will not quietly
replace your credentials on a guess. Your files and recycle bin are untouched either way, since
they live in sibling directories.

Changing the PIN bumps a server-side session epoch, which invalidates every session token
issued before the change. The tab that made the change is handed a fresh cookie and stays
signed in; every other signed-in device is signed out on its next request.

## Configuration

Configuration comes from the environment. A `.env` file in the project root is read at
startup if present, and real environment variables always win over the file, so a hosting
platform's own configuration is never overwritten by a checked-out file. `.env` is
gitignored; `.env.example` documents every variable and is the file to copy.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to accept only local connections. |
| `NODE_ENV` | `development` | `production` enables HSTS, requires `JWT_SECRET`, and defaults `COOKIE_SECURE` to true. |
| `JWT_SECRET` | *(dev: generated)* | Session signing key, 16 characters minimum. **Required in production** — the server refuses to start without it. In development a key is generated once and persisted at `$DATA_DIR/.session-secret` (mode 0600) so restarts do not sign you out. |
| `DATA_DIR` | `./data` | Root of all persistent state. Resolved relative to the project root. |
| `INITIAL_PIN` | *(random)* | First-boot only. Blank means a random PIN is generated and logged once. |
| `SESSION_TTL_SECONDS` | `43200` | 12 hours. |
| `COOKIE_SECURE` | *(prod: true)* | Send the session cookie only over HTTPS. |
| `MAX_UPLOAD_BYTES` | `1073741824` | 1 GiB per file. |
| `MAX_FILES_PER_REQUEST` | `500` | |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failures per IP per window before lockout. |
| `LOGIN_WINDOW_SECONDS` | `900` | |
| `LOGIN_LOCKOUT_SECONDS` | `300` | Base lockout; doubles on repeat, capped at 24 hours. |
| `LOGIN_GLOBAL_MAX_ATTEMPTS` | `50` | Ceiling across all IPs, so a distributed guessing attempt is throttled too. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for rate limiting. Set this **only** behind a proxy you control that appends the client address (nginx, Caddy, Cloudflare). Left `false` behind a proxy, all requests share one throttle bucket — safe for a single-user vault. |
| `TRUST_PROXY_HOPS` | `1` | Trusted proxies in front of the app. The client is taken as that many entries from the **right** of `X-Forwarded-For`; the left end is client-controlled and never used. |
| `ALLOW_REINIT` | *(unset)* | One-shot recovery switch: lets the server create a new PIN when `user.json` is missing but the vault has files. See [The PIN](#the-pin-and-what-happens-on-restart). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## Where your data lives

Everything persistent sits under `DATA_DIR`, with live content, deleted content and
metadata in separate trees so the storage layer has clear boundaries (SRS 6):

```
data/
├── files/                     the vault itself; folders here are folders in the UI
├── trash/
│   └── <uuid>/
│       ├── meta.json          original path, type, size, deletedAt
│       └── payload/<name>     the deleted file or folder, intact
├── user.json                  { pin: { hash, updatedAt, isInitial }, sessionEpoch, ... }
└── .session-secret            development-only signing key, mode 0600
```

The recycle bin deliberately has no shared index file. Each deleted item is a
self-contained directory holding its own metadata beside its own payload, so a crash
mid-delete can leave at most one unreferenced directory rather than corrupting a list that
every other entry depends on. Restore reads `meta.json`, puts the payload back at its
original path, and resolves a name collision by suffixing rather than overwriting.

Backing up the vault means copying `DATA_DIR`. There is nothing else.

## What it does

Uploads cover single files, multi-select, whole folders and drag-and-drop, including
folders dropped from the desktop, whose hierarchy is preserved (SRS 7). Progress is
reported from bytes rather than from file counts, so one large file among small ones still
moves the bar smoothly, and the panel shows both a percentage and an *n/m files* count
(SRS 8). The frontend sends one request per file so a single failure cannot take down the
rest of the batch.

The browser lists folders first, then files, sorted naturally, with a breadcrumb trail and
back navigation backed by the URL hash — so browser Back walks up the folder tree and a
folder can be linked to directly (SRS 9, 10, 11). Search filters the current folder as you
type (SRS 19). Files can be previewed inline, downloaded, renamed, moved, deleted to the
recycle bin, restored from it, and inspected in an info panel that reports recursive size
and counts for folders (SRS 12–18). Multi-select works with checkboxes, shift-click ranges
and `Ctrl`/`Cmd`-click, with a tri-state select-all and an action bar that hides whatever
does not apply to the current selection (SRS 17). Right-click opens a context menu on any
row (SRS 21). Dark and light themes are switchable and remembered, and the layout is
responsive down to a phone (SRS 20, 22, 23).

## Security posture

The measures below implement SRS 24 and 25. They are listed here so an operator can see
what is and is not being relied on.

**Authentication.** The PIN is hashed with `crypto.scrypt` (N=32768, r=8, p=1, 32-byte key)
over a 16-byte random salt, and compared with `timingSafeEqual`. The parameters are stored
alongside the hash, so raising them later upgrades an existing record transparently on the
next successful login instead of invalidating it. Sessions are HMAC-SHA256-signed tokens with
the algorithm pinned at verification, carried in an `HttpOnly`, `SameSite=Strict` cookie. The
cookie rather than a JS-held token is what lets `<img>`, `<iframe>` and download navigations
authenticate themselves without any token ever being readable by script.

**Authorisation.** Every route except `/api/login`, `/api/logout` and `/api/session`
requires a valid session; the check is applied at registration, not per-handler
convention. A token whose epoch is older than the stored `sessionEpoch` is rejected even
if its signature and expiry are still valid.

**CSRF.** `SameSite=Strict` is the primary defence. Two checks close the residual gaps: a
present `Origin` must match the `Host`, and every state-changing request must carry
`X-Requested-With: SecureVault`. A cross-origin HTML form cannot set a custom header, and
setting one from script forces a preflight the server never approves.

**Path safety.** Client paths are resolved inside the vault root and then verified with
`realpath`, so a symlink cannot be used to escape. Traversal is *rejected* rather than
stripped — `../` returns an error instead of being quietly rewritten into something the
user did not ask for. Item names are validated against reserved names, control characters,
separators, leading dots and Windows device names; uploaded filenames are sanitised, while
names typed by the user are refused rather than silently altered. Symlinks are never
created, never listed, and never followed out of the vault.

**No path disclosure.** Every response speaks in vault-relative paths. Node's filesystem
errors carry absolute paths in `err.path` and `err.message`, so they are translated into
safe errors at the storage boundary and the original is logged, not returned.

**Content handling.** Downloads are always `application/octet-stream` with an `attachment`
disposition, so no stored file can be rendered as active content in the vault's origin.
Preview serves only whitelisted extensions, forces anything text-like to `text/plain`
regardless of what its extension claims, and wraps text and SVG in
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. That is
what stops a stored `.html` or `.svg` from executing script and reading the session cookie.
PDFs are exempted from the sandbox directive only because it breaks the browsers' built-in
viewers, and they are framed same-origin.

**Response headers.** A CSP with no `unsafe-inline` (the frontend ships no inline script or
style at all), plus `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, a `Permissions-Policy` that
denies geolocation, camera, microphone and USB, `X-Robots-Tag: noindex`, and HSTS in
production.

**Login throttling.** A sliding window per IP with exponential lockout, plus a global
counter, both checked *before* the PIN is hashed — so a flood costs an attacker a 429
rather than a few hundred milliseconds of the server's CPU per guess. PIN checks are
processed one at a time, so a burst of simultaneous guesses cannot all slip past the gate
before the first failure is counted. A wrong current PIN on the change-PIN form counts
against the same budget, so a borrowed session cannot use it to guess the PIN. A 429 carries
`Retry-After` and a message naming the wait. The global counter also means anyone who can
reach the URL can pause logins for a few minutes by failing on purpose; for a personal vault
that is the right trade.

**Rendering.** The frontend never assigns `innerHTML`. Every piece of user-controlled text
reaches the DOM through `textContent` or an attribute, which is why a file named
`<script>alert(1)</script>` shows up as a filename and nothing else.

**Secrets.** Nothing is hardcoded. `.env`, `data/` and `*.log` are gitignored, and
production refuses to start without an explicit `JWT_SECRET` rather than generating one
that would silently invalidate every session on restart.

## Project layout

```
server.js                  wiring: config, middleware order, routes, lifecycle
Dockerfile                 container image (node:22-alpine, non-root, /data volume)
tests/api.test.mjs         end-to-end suite: `npm test`
src/
├── config.js              env parsing, defaults, session-secret resolution
├── auth/                  pin (scrypt), tokens (HS256), session, throttle
├── http/                  router, helpers, middleware, multipart, static
├── routes/                auth, files, content, upload
├── storage/               index (facade), fsStorage, safePath, trash
├── users/userStore.js     user.json read/write, PIN policy, session epoch
└── util/                  errors, logger, mime
public/
├── index.html             the single page and the SVG icon sprite
├── css/styles.css         custom properties on <html data-theme>
└── js/
    ├── app.js             boot, login view, account menu, theme toggle
    ├── api.js             fetch wrapper, ApiError, session-lost signal
    ├── browser.js         the file browser and all of its state
    ├── dom.js             element helpers, formatting, icons
    ├── upload.js          XHR uploads, progress, drag-and-drop sources
    ├── ui/                menu, modal, theme, toast
    └── views/             preview, info, move, trash, pin
docs/API.md                the HTTP contract
docs/DEPLOY.md             free hosting options and step-by-step deployment
```

Backend modules are grouped by concern rather than by feature so that the security-relevant
code is small and contiguous: everything that decides *who you are* is in `src/auth`,
everything that decides *which bytes you may touch* is in `src/storage`. The frontend keeps
all browser state in `browser.js`, and every mutation funnels through a single `refresh()`,
which is why the listing, the breadcrumb, the selection bar and the status line cannot drift
out of sync.

## Deployment

The SRS asks for a deployment that assumes no particular provider (SRS 27), so this is a
plain Node HTTP server: it reads `PORT` and `HOST`, writes to `DATA_DIR`, and has no
provider SDK, no object-store client and no platform-specific configuration anywhere in the
tree. Anything that can run `node server.js` (or the included `Dockerfile`) and give it a
writable directory can host it. **[docs/DEPLOY.md](docs/DEPLOY.md)** walks through the
options that cost nothing, and says plainly which popular free tiers will lose your files.

Four things matter wherever you put it:

1. `DATA_DIR` **must** be a persistent disk. On an ephemeral filesystem the vault and the
   user record are wiped on every restart or redeploy. (The server notices when only part of
   the data has vanished and refuses to start rather than issue a new PIN.)
2. `JWT_SECRET` must be set explicitly in production, and kept stable across restarts, or
   every session is invalidated when the process cycles.
3. Serve it over HTTPS: with `NODE_ENV=production` the session cookie is `Secure`, so a
   plain-HTTP deployment cannot log in at all. (For a trusted home LAN over HTTP, run with
   `NODE_ENV=development` or `COOKIE_SECURE=false`.)
4. Behind a reverse proxy, either leave `TRUST_PROXY=false` (one shared throttle bucket) or set
   `TRUST_PROXY=true` and `TRUST_PROXY_HOPS` to the number of proxies you control. Never
   trust `X-Forwarded-For` from a source you do not control.

A liveness probe is available at `GET /healthz`.

## Verification

`npm test` runs 28 end-to-end checks against real server processes (each on its own port
with a throwaway data directory), using only `node:test` and `fetch`. They cover the auth
lifecycle and cookie flags, CSRF, path traversal on API and static routes, name validation,
uploads (hierarchy, collisions, size limits with partial-file cleanup), byte ranges, preview
hardening for stored HTML and SVG, the recycle-bin round trip, PIN change and session
retirement, login throttling — including a burst of simultaneous guesses and forged
`X-Forwarded-For` values — that no response contains a server path, and the startup
guarantees: a restart never resets the PIN, a missing user record next to a full vault is
refused unless `ALLOW_REINIT` is set, and production refuses to start without `JWT_SECRET`.

The frontend has no automated tests. It was checked by hand and in a real browser
(login, upload, folder navigation via the URL hash and Back, search, preview, delete and
restore, theme, PIN change, mobile width, logout) with no CSP violations.

## Deviations from the SRS

SRS 3 lists a suggested stack and allows justified equivalents. Four substitutions were
made, all in the same direction — removing an install step rather than adding a capability.
Express is replaced by a ~150-line router in `src/http/router.js` with the same
`use`/`get`/`post`/`next(err)` shape. bcrypt is replaced by `crypto.scrypt`, which is
memory-hard, in Node's standard library, and needs no native build. jsonwebtoken is replaced
by HS256 tokens built directly on `crypto.createHmac`, verified with `timingSafeEqual` and
with the algorithm pinned so a token cannot claim `alg: none`. multer is replaced by a
streaming multipart parser in `src/http/multipart.js` that never buffers a whole file in
memory and removes partial files if a limit is exceeded mid-stream.

Two things go slightly beyond the specification. Audio and video are previewable, which the
SRS does not require, because the range-request support the preview endpoint already needed
for PDFs is exactly what media scrubbing uses, and media is passive content. And
`POST /api/folder` creates an empty folder, which is not itemised in the SRS but which Move
(SRS 15) needs in order to have somewhere to move things to.

The HTTP contract is documented in [docs/API.md](docs/API.md). The SRS names its endpoints
without a prefix (`POST /login`, `GET /files`); those bare paths all work as aliases, and
`/api/...` is the canonical form used internally so that API routes and static files cannot
collide.

## Changes in 1.1.0

- **Fixed:** the login throttle could be bypassed by sending many guesses at once. PIN checks now
  run one at a time.
- **Fixed:** with `TRUST_PROXY=true`, a client could forge the left end of `X-Forwarded-For` to
  dodge per-IP lockout. The address is now taken from the right (`TRUST_PROXY_HOPS`).
- **Fixed:** the change-PIN form let a signed-in session guess the current PIN without limit; it
  now shares the login throttle.
- **Fixed:** documentation. PIN recovery needs `ALLOW_REINIT=true`, wrong `currentPin` returns
  400 (not 401), and the `user.json` layout was described incorrectly.
- **Added:** `GET /healthz`, a `Dockerfile`, the test suite (`npm test`), and `docs/DEPLOY.md`.

## Licence

Private. Not licensed for redistribution.

