# Better Intra Worker

Backend 'cloud' worker for the Better Intra extension, managing user synchronization and persistence via Cloudflare KV and D1.
Deployed with `npx wrangler deploy` (this repository has no CI workflow).

This deployment serves the **Intra-login build** of the extension: no 42 OAuth application, no Discord bot, no R2 bucket. Everything that needed one of those in the upstream worker (42 OAuth `/login` and `/callback`, evaluation reminders and their crons, Discord linking, image hosting, the students directory, logtime history, the 42 API proxy, project refresh) has been removed rather than left answering errors. `wrangler.json` declares `"crons": []` on purpose: the empty array is what makes `wrangler deploy` delete the schedules still registered on the live worker.

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /auth/intra` | Intra v3 Keycloak JWT in the body | Opens a session; writes the KV record and a `users` row. |
| `GET /api/v1/private/settings?login=<hash>` | Bearer session | Add `&fields=meta` for `{activeSessions, discordId: null}` without the settings blob. |
| `POST /api/v1/private/settings?login=<hash>` | Bearer session | Merges `{settings}` into the record. |
| `DELETE /api/v1/private/settings?login=<hash>[&all=true]` | Bearer session | Removes the calling session; `all=true` is "Wipe all data" (see below). |
| `GET /api/v1/public/visuals?login=<hash>` | none | Public visuals of one profile, `Cache-Control: public, max-age=300`. |
| `GET /api/v1/public/visuals?logins=<h1>,<h2>,...` | none | Same, for up to 50 hashes in one call: `{"visuals": {<hash>: {...}}}`. Unknown hashes get the defaults, like the single form. |
| `POST /api/v1/private/calendar/token`, `POST /api/v1/private/calendar/update`, `GET /calendar/<token>.ics` | Bearer session / opaque token | Calendar links. |
| `POST /api/v1/private/subjects/report`, `GET /api/v1/private/subjects/state` | Bearer session | Subject tracker. |
| `GET /api/v1/cluster/svg?url=`, `GET /api/v1/cluster/svgs` | none | Cluster maps (SVGs from `https://*.intra.42.fr` only). |
| `GET /api/v1/public/announcement`, `POST` with `{secret, message, level?, links?}` | operator secret in the JSON body | Banner shown in the extension. An empty `message` clears it; the secret never goes in a query string (`DELETE` is gone). Unset `ANNOUNCEMENT_SECRET` closes the route. |
| `GET /api/v1/public/stats` | none | Community counter (see "Data kept in D1"). |
| `GET /gh/*` | none | GitHub raw proxy for campus data. |

Anything else answers 404 before touching KV or D1. Every private route answers one and the same `401 Unauthorized` for a missing header, a wrong token and an unknown login (the login parameter is sha256 of a public login, so a distinct "not found" would tell anyone who uses the extension); the check runs before the KV read, so anonymous scans cost no read. The `login` parameter must be a login hash (64 lowercase hex characters).

## Limits

- **Rate limits** (`src/rate-limit.ts`): 10 writes a minute per login hash (sign-in once the token is verified, settings push, session removal, calendar link and upload) and 30 well-formed `/auth/intra` attempts a minute per IP before any key work. Over the limit: `429` with `Retry-After: 60`. A push that changes nothing is neither written nor counted. The Workers rate limit bindings in `wrangler.json` (`WRITE_RL`, `ANON_RL`, free on every plan) are used when bound; otherwise (local dev, tests, a fork without them) an in-isolate fixed window stands in. Both are best effort per colo/isolate: they make abuse slow and attributable, they do not make the shared 1,000 KV writes a day unexhaustible.
- **Size caps**: settings push body and merged record 64 KB (`413`), any single string value 8 KB (`413`), calendar upload 256 KB (`413`), calendar token body 4 KB. Bodies are dropped as soon as they go over, never buffered whole.
- **Public visuals** are bounded again when served (URLs 2,048 characters, words and colours 64, numbers must be finite), so a record stored by an older worker is never re-served to every visitor as is.
- **CORS preflights** carry `Access-Control-Max-Age: 86400` (Chrome caps at 7,200 s), so an authenticated call is one invocation, not two.

## Data kept in D1

- `users` (`hash`, `country`, `created_at`): one row per student who ever signed in. `country` is the two-letter country Cloudflare infers from the IP of the **first** sign-in (`request.cf.country`), never updated; it only feeds the per-country counts of `/api/v1/public/stats` (hub About tab). This must be stated in the extension's privacy text.
- `calendar_ics`, `calendar_tokens`: calendar links, see below.
- `subjects`, `projects`: the subject tracker registry (`projects` is read-only here; empty means `name: null`).
- A database created by the earlier schema also carries the 42-application tables (`eval_*`, `outstanding_*`, `*_stats_cache`, `logtime_history`, `cursus`) and extra `users` columns; nothing reads them any more, drop them by hand when convenient. `schema.sql` describes a fresh database.

**Wipe all data** (`DELETE ...&all=true`) deletes, in this order: the calendar (revokes every link, deletes the stored ICS), the `users` row (the student leaves the community counter), then the KV record with its sessions and settings. A failure in an earlier step leaves the record, and so the session, for a retry. Revoked calendar-link tombstones stay, so a wiped link can never be registered again.

## Operations notes

- **Calendar links** live in the D1 table `calendar_tokens`, created on first use (also in `schema.sql`). One live link per login: "Regenerate" revokes the previous link, "Wipe all data" revokes every link and deletes the stored calendar, and a revoked link answers 404 and can never be registered again. Links made before this table (KV keys `CALENDAR_TOKEN_*`) keep working until their owner makes a new link or wipes. Rolling back to a worker without the table would break the links made since and bring the revoked legacy ones back.
- `/api/v1/cluster/svg` only fetches SVGs from `https://*.intra.42.fr`; the subject tracker only fetches PDFs from `cdn.intra.42.fr` and `projects.intra.42.fr`.
- Unhandled errors come back as JSON 500 (`{"error":"server_error","message":...}`) with CORS headers, and are logged as `[worker] unhandled error: <METHOD> <path> <name>: <message>` (path only, never the query string). `observability.logs.invocation_logs` is off so that `/calendar/<token>.ics` URLs are not persisted in Workers Logs; turn it back on if per-request status/duration is worth that.
- Tests: `npx vitest run` (in-memory KV, SQLite-backed D1 with `schema.sql` applied, rate limit stub in `tests/helpers/fake-env.ts`). Types: `npx tsc --noEmit -p .`.
