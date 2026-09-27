# Secure Vault HTTP API

Every endpoint is documented below with a real request and the response it actually
returned. The examples were captured from a running server, so the field names and shapes
are the ones you will see.

## Conventions

**Base path.** `/api` is canonical. The SRS writes its contract without a prefix
(`POST /login`, `GET /files`), and those bare paths work as aliases for all sixteen
endpoints — the alias middleware rewrites the path, so there is one handler per endpoint
rather than two copies of the same logic. `/api` is preferred because it cannot collide
with a static asset.

**Authentication.** Sign in once with `POST /api/login`; the response sets an `HttpOnly`,
`SameSite=Strict` session cookie named `sv_session`, and every subsequent request is
authenticated by that cookie. There is no bearer token to hold, which is deliberate: it
means `<img src="/api/preview?...">` and a download navigation authenticate themselves, and
no script — including injected script — can read the credential. All endpoints except
`login`, `logout`, `session` and `healthz` return `401` without a valid session.

**The client header.** Every request that changes state (`POST`, `DELETE`) must send
`X-Requested-With: SecureVault`. Without it the request is refused with `403`
`FORBIDDEN` before it reaches a handler. If an `Origin` header is present it must match
`Host`. Safe methods (`GET`, `HEAD`, `OPTIONS`) are exempt from both checks.

**Paths.** Every `path` in a request or a response is vault-relative, with `/` as the
separator and `""` meaning the vault root. Absolute paths, `..` segments, symlinks pointing
out of the vault and Windows drive prefixes are rejected with `403` rather than sanitised —
a request for something outside the vault is a mistake worth surfacing, not one to guess at.
No response ever contains a server filesystem path.

**Bodies.** Request and response bodies are JSON, except `POST /api/upload`
(`multipart/form-data`) and the two streaming endpoints. JSON bodies are capped at 64 KiB.
Batch operations accept either a single `path`/`id` or a `paths`/`ids` array, up to 500
items per call.

**Errors.** Every failure uses one envelope, with a stable machine-readable `code` and a
message written for a person:

```json
{ "error": { "code": "FORBIDDEN", "message": "That path is not allowed." } }
```

Diagnostic detail — syscall names, absolute paths, stack traces — is logged server-side and
never serialised into a response.

## Status codes

| Code | `code` | When |
| --- | --- | --- |
| 200 | | Success. |
| 201 | | `POST /api/folder`, `POST /api/upload`. |
| 206 | | A satisfiable `Range` on preview or download. |
| 400 | `BAD_REQUEST` | Missing or malformed input, an invalid name, a file where a folder was expected. |
| 401 | `UNAUTHORIZED` | Wrong PIN, or no valid session. |
| 403 | `FORBIDDEN` | Path outside the vault, missing client header, mismatched origin. |
| 404 | `NOT_FOUND` | No such item. |
| 409 | `CONFLICT` | A name is already taken. |
| 413 | `PAYLOAD_TOO_LARGE` | Upload over `MAX_UPLOAD_BYTES`, or a JSON body over 64 KiB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not previewable, or a text preview over 2 MiB. |
| 416 | `RANGE_NOT_SATISFIABLE` | Requested range starts past end of file. |
| 429 | `TOO_MANY_REQUESTS` | Login or PIN change throttled. Carries `Retry-After`, in seconds. |
| 500 | `INTERNAL_ERROR` | Unexpected server-side failure. |
| 503 | `BUSY` | Server out of file descriptors. |
| 507 | `NO_SPACE` | Disk full. |

## The entry object

Listings, folder creation and rename all return the same shape. `size` is `null` for a
folder, `created` is `null` on filesystems without a birth time, and `category` is a coarse
grouping (`folder`, `image`, `pdf`, `text`, `audio`, `video`, `archive`, `document`,
`spreadsheet`, `presentation`, `file`) used for icons and the type column.

```json
{
  "name": "note.txt",
  "path": "Documents/note.txt",
  "type": "file",
  "size": 12,
  "modified": "2026-09-05T11:44:46.413Z",
  "created": "2026-09-05T11:44:46.412Z",
  "category": "text"
}
```

## Authentication

### POST /api/login

Exchanges the PIN for a session cookie. Throttled per IP and globally *before* the PIN is
hashed. `pinIsInitial` is true while the PIN is still the one generated at first boot, which
is what drives the "change your PIN" nudge in the UI.

```http
POST /api/login
Content-Type: application/json
X-Requested-With: SecureVault

{ "pin": "246813" }
```

```json
{ "ok": true, "expiresIn": 43200, "pinIsInitial": true }
```

`Set-Cookie: sv_session=<token>; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict`
(plus `Secure` when `COOKIE_SECURE` is on).

A wrong PIN returns `401`, and the message names the number of attempts left once two or
fewer remain: `That PIN is not correct. 2 attempts left.`

Once the per-IP window is exhausted, further attempts are refused without hashing anything:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45

{ "error": { "code": "TOO_MANY_REQUESTS",
             "message": "Too many failed attempts. Try again in 45 seconds." } }
```

Attempts are checked one at a time, so a burst of simultaneous guesses cannot slip past the
limit: once it is reached, the rest of the burst is refused without being hashed. The lockout
doubles on each repeat, capped at 24 hours, and a successful login clears the counter for
that IP. A separate global counter (`LOGIN_GLOBAL_MAX_ATTEMPTS`) applies the same
treatment when failures arrive from many addresses at once.

### POST /api/logout

Clears the cookie by reissuing it empty with `Max-Age=0`. Always `{ "ok": true }`, whether or
not a session was present.

### GET /api/session

Unauthenticated on purpose — it is how the frontend decides which view to show on load.

```json
{ "authenticated": true, "pinIsInitial": true }
```

An absent, expired, tampered or superseded token gives `{ "authenticated": false }` with
`200`, not `401`.

### POST /api/change-pin

Requires the current PIN even though the caller already holds a session, so a borrowed or
forgotten-open session cannot lock the owner out. The new PIN must be 4 to 128 characters, and
is refused if every character is the same or if it opens with a run of four consecutive digits.

```http
POST /api/change-pin
{ "currentPin": "246813", "newPin": "719204" }
```

```json
{ "ok": true, "expiresIn": 43200 }
```

Succeeding bumps the stored session epoch, which retires every token issued before this
moment. This response carries a fresh cookie so the calling tab stays signed in; any other
signed-in device gets a `401` on its next request. A wrong `currentPin` returns `400`, and
counts against the same attempt budget as a wrong login PIN, so this endpoint cannot be used
to guess the PIN without limit; once the budget is spent it returns `429` with `Retry-After`.
A new PIN that fails policy returns `400`.

## Browsing

### GET /api/files?path=

Lists one folder. Entries are sorted folders-first then naturally by name. Dotfiles,
symlinks, sockets and device files are omitted. `parent` is `null` at the root, which is what
disables the Back button.

```json
{
  "path": "",
  "name": "Vault",
  "parent": null,
  "entries": [
    { "name": "Documents", "path": "Documents", "type": "folder", "size": null,
      "modified": "2026-09-05T11:44:46.412Z", "created": "2026-09-05T11:44:46.399Z",
      "category": "folder" }
  ]
}
```

Pointing this at a file returns `400`; pointing it outside the vault returns `403`
`{"error":{"code":"FORBIDDEN","message":"That path is not allowed."}}`.

### GET /api/info?path=

Metadata for one item. A file adds `accessed` and `parent` to the entry object. A folder adds
a recursive summary as well, bounded at 20,000 entries and 24 levels deep so that Info on a
huge tree cannot stall the request — `truncated` reports whether the walk stopped early.

```json
{
  "name": "Documents", "path": "Documents", "type": "folder", "size": null,
  "modified": "2026-09-05T11:44:46.412Z", "created": "2026-09-05T11:44:46.399Z",
  "category": "folder",
  "fileCount": 1, "folderCount": 0, "totalSize": 12, "truncated": false,
  "accessed": "2026-09-05T11:44:46.409Z", "parent": ""
}
```

## Organising

### POST /api/folder

Creates one empty folder and returns it, so the caller can insert it into a listing without
refetching. `201` on success, `409` if the name is taken.

```http
POST /api/folder
{ "path": "", "name": "Documents" }
```

```json
{ "ok": true,
  "entry": { "name": "Documents", "path": "Documents", "type": "folder", "size": null,
             "modified": "2026-09-05T11:44:46.399Z", "created": "2026-09-05T11:44:46.399Z",
             "category": "folder" } }
```

Names are validated, not repaired. Empty, `.` and `..`; control characters; `/` or `\`;
`: * ? " < > |`; a leading dot; a trailing dot or space; Windows device names (`CON`, `PRN`,
`AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`); and anything over 255 bytes are each a `400`
with a message naming the specific problem. A name you type is never silently altered —
that is reserved for uploaded filenames, which are sanitised instead, since rejecting a
1,000-file folder upload over one awkward character would be worse than fixing it.

### POST /api/rename

Renames in place and returns the entry at its new path.

```http
POST /api/rename
{ "path": "Documents/note.txt", "newName": "renamed.txt" }
```

```json
{ "ok": true,
  "entry": { "name": "renamed.txt", "path": "Documents/renamed.txt", "type": "file",
             "size": 12, "modified": "2026-09-05T11:44:46.413Z",
             "created": "2026-09-05T11:44:46.412Z", "category": "text" } }
```

A taken name returns `409` rather than overwriting, including a case-only change on a
case-insensitive filesystem where both names are the same file. Renaming the vault root is a
`400`.

### POST /api/move

Moves one or more items into a folder. `destination` is required; `""` means the root.

```http
POST /api/move
{ "paths": ["Documents/renamed.txt"], "destination": "" }
```

```json
{ "ok": true, "moved": [ { "from": "Documents/renamed.txt", "to": "renamed.txt" } ] }
```

A collision at the destination is resolved by suffixing — `report.pdf` becomes
`report (1).pdf` — and the result carries `"renamed": "report (1).pdf"` so the UI can say what
actually happened rather than implying an overwrite. Moving something into the folder it is
already in is a no-op reported as `"unchanged": true`. Moving a folder into itself or into its
own subtree is a `400`; `rename(2)` would otherwise either fail cryptically or detach the
subtree.

### DELETE /api/delete

Moves items to the recycle bin (SRS 16). Nothing is destroyed here, which is why the UI can
promise recovery.

```http
DELETE /api/delete
{ "paths": ["renamed.txt"] }
```

```json
{ "ok": true,
  "trashed": [ { "id": "1d09bd3c-3c12-4300-b3b3-153c3a6c6795", "name": "renamed.txt",
                 "from": "renamed.txt", "type": "file" } ] }
```

## The recycle bin

### GET /api/trash

Newest first. `size` is the recursive total for a deleted folder, or `null` if it could not be
computed at deletion time.

```json
{ "entries": [ { "id": "1d09bd3c-3c12-4300-b3b3-153c3a6c6795", "name": "renamed.txt",
                 "type": "file", "category": "text", "size": 12,
                 "originalPath": "renamed.txt",
                 "deletedAt": "2026-09-05T11:44:46.469Z" } ] }
```

### POST /api/trash/restore

Puts items back at `originalPath`, recreating missing parent folders along the way.

```http
POST /api/trash/restore
{ "ids": ["1d09bd3c-3c12-4300-b3b3-153c3a6c6795"] }
```

```json
{ "ok": true,
  "restored": [ { "id": "1d09bd3c-3c12-4300-b3b3-153c3a6c6795", "to": "renamed.txt" } ] }
```

If something else now occupies that name, the restored copy is suffixed and `renamed` reports
the name used. An unknown id is a `404`.

### DELETE /api/trash

Permanently deletes the listed bin entries. `{ "ok": true, "removed": 1 }`.

### DELETE /api/empty-trash

Permanently deletes everything in the bin. `{ "ok": true, "removed": 0 }`. Irreversible, and
the only endpoint in the API that destroys data without a recovery path — the UI puts a typed
confirmation in front of it.

## Uploads

### POST /api/upload?path=&lt;destination folder&gt;

`multipart/form-data`. Each file part may be preceded by a `relativePath` text field carrying
the browser's `webkitRelativePath`; the parser preserves field order and pairs each
`relativePath` with the file part that follows it, which is how a folder upload keeps its
hierarchy. Without it, the file lands directly in the destination folder.

```http
POST /api/upload?path=Documents
Content-Type: multipart/form-data; boundary=----abc
X-Requested-With: SecureVault
```

```json
{ "ok": true, "uploaded": [ { "path": "Documents/note.txt", "name": "note.txt", "size": 12 } ] }
```

Returns `201`. Several files per request are accepted, up to `MAX_FILES_PER_REQUEST`, though
the frontend deliberately sends one request per file so it can report byte-accurate overall
progress and survive a single failure.

Filenames are sanitised rather than rejected, and a name that already exists is suffixed, so
an upload never overwrites. Files stream straight to disk — nothing is buffered whole in
memory — and if a limit is breached mid-stream, every partial file written by that request is
removed before the error is returned. Exceeding `MAX_UPLOAD_BYTES` gives `413`; a
non-multipart body or an empty upload gives `400`; a destination that is not a folder gives
`400`.

## Streaming content

Both endpoints support `Range` (`206` with `Content-Range`, `416` when unsatisfiable), send
`Accept-Ranges: bytes`, `Cache-Control: private, no-store` and `Last-Modified`, and honour
`HEAD`. Both use RFC 6266 / RFC 5987 `Content-Disposition`, with an ASCII-folded `filename`
and a `filename*=UTF-8''…` form, so a non-ASCII name survives the trip.

### GET /api/preview?path=

Serves a file inline, but only if its extension is on the preview whitelist: images
(`.png .jpg .jpeg .gif .webp .avif .bmp .ico`), `.svg`, `.pdf`, playable media
(`.mp3 .m4a .aac .wav .ogg .flac .mp4 .webm .mov`), or one of about fifty text and source
extensions. Anything else is `415`, with a message pointing at download — the endpoint will
not stream unknown bytes into a browser under a guessed type.

Two hardening rules apply. Everything in the text group is served as
`text/plain; charset=utf-8` no matter what its extension claims, so a stored `.html`, `.svg`
or `.js` is displayed rather than executed. Text and SVG responses additionally carry
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Together
those are what stop a file inside the vault from running script in the vault's own origin and
reading the session cookie. PDF is exempt from the sandbox directive because it breaks the
browsers' built-in viewers, and is framed same-origin only. Text previews are capped at 2 MiB;
a larger text file is `415` with a message saying so.

### GET /api/download?path=

Always `Content-Type: application/octet-stream` with `Content-Disposition: attachment`,
whatever the file is. A stored file therefore cannot be rendered as active content through this
route at all. Folders are `400` — there is no archive-on-the-fly.

## Health check

### GET /healthz

Public and cheap: `200 {"ok":true}` whenever the process is serving requests. Meant for hosting
platforms' health probes and the Docker `HEALTHCHECK`. It touches neither the session nor the
disk, so it says the server is up, not that the volume is mounted, and it is not logged.

## Notes for scripting

`curl` needs three things: a cookie jar, the client header on unsafe methods, and
URL-encoded paths.

```bash
B=http://localhost:3000
H='-H X-Requested-With:SecureVault'
curl -s -c jar $H -H 'Content-Type: application/json' \
     -d '{"pin":"246813"}' $B/api/login
curl -s -b jar $H "$B/api/files?path=Documents"
curl -s -b jar $H -F "file=@./report.pdf" "$B/api/upload?path=Documents"
curl -s -b jar $H -o report.pdf "$B/api/download?path=Documents/report.pdf"
```

A session token may also be presented as `Authorization: Bearer <token>` instead of the
cookie, which is occasionally convenient for a script. The value is the same one the cookie
carries; there is no separate token-issuing endpoint, because handing a readable token to the
browser is exactly what the `HttpOnly` cookie exists to avoid.

