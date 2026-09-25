import { Env } from "../types";
import {
  authenticate,
  listSessions,
  recordLoader,
  revokeOtherSessions,
  type RecordSource,
} from "../sessions";
import { errorRes, jsonRes, methodNotAllowedRes, unauthorizedRes } from "../utils";

/**
 * /api/v1/private/sessions?login=<hash>
 *  - GET: the login's live sessions, newest first:
 *    {"sessions":[{"id":"<first 8 hex of the token's SHA-256>","createdAt":<ms>,"current":bool}]}.
 *    The id only tells the rows apart: 32 bits of a hash open nothing.
 *  - DELETE &others=true: "Sign out other browsers". Revokes every session
 *    of the login but the caller's and answers {"revoked":<n>}. Until then
 *    the only way to end a session left on another computer was "Wipe all
 *    data", which takes the backup, the images and the calendar with it.
 *
 * A path of its own rather than a flag on DELETE /api/v1/private/settings: a
 * worker that ignored the flag would take the call for a sign-out of the
 * caller. Not rate limited, like the sign-out: it writes D1 only, and a second
 * call has nothing left to remove.
 */
export async function handleSessions(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "DELETE") {
    return methodNotAllowedRes();
  }
  const session = await authenticate(request, env, loginParam, recordLoader(source));
  if (!session) return unauthorizedRes();

  if (request.method === "GET") {
    const rows = await listSessions(env, loginParam);
    return jsonRes({
      sessions: rows.map((r) => ({
        id: r.tokenHash.slice(0, 8),
        createdAt: r.createdAt,
        current: r.tokenHash === session.tokenHash,
      })),
    });
  }

  // Only the "others" form exists: a bare DELETE must not guess between
  // signing out the caller and everyone else.
  if (new URL(request.url).searchParams.get("others") !== "true") {
    return errorRes(
      "bad_request",
      "Add others=true: this route signs out the other browsers",
      400,
    );
  }
  return jsonRes({ revoked: await revokeOtherSessions(env, session) });
}
