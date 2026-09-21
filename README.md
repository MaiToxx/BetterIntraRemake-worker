# Better Intra Worker

Backend 'cloud' worker for Better Intra extension, managing user synchronization and persistence via Cloudflare KV and D1.
Deployed with `npx wrangler deploy` (this repository has no CI workflow).

## Operations notes

- **Calendar links** live in the D1 table `calendar_tokens`, created on first use (also in `schema.sql`). One live link per login: "Regenerate" revokes the previous link, "Wipe all data" revokes every link and deletes the stored calendar, and a revoked link answers 404 and can never be registered again. Links made before this table (KV keys `CALENDAR_TOKEN_*`) keep working until their owner makes a new link or wipes. Rolling back to a worker without the table would break the links made since and bring the revoked legacy ones back.
- **Without a 42 application** (`CLIENT_ID` left as `TO_FILL_42_APP_UID`, or no `CLIENT_SECRET`) the three crons return at once and `getAppToken()` fails without calling the 42 API. Set both to turn them on.
- `/api/v1/cluster/svg` only fetches SVGs from `https://*.intra.42.fr`; the subject tracker only fetches PDFs from `cdn.intra.42.fr` and `projects.intra.42.fr`.
- Unhandled errors come back as JSON 500 (`{"error":"server_error","message":...}`) with CORS headers; the `login` parameter must be a login hash (64 lowercase hex characters).
