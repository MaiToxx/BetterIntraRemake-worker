import { handleIntraAuth } from "./handlers/intra-auth";
import {
  handlePrivateSettings,
  handlePublicVisuals,
  handlePublicVisualsBatch,
} from "./handlers/settings";
import { handleGhProxy } from "./handlers/gh-proxy";
import { handleSubjectsReport, handleSubjectsState } from "./handlers/subjects";
import {
  handleCalendarToken,
  handleCalendarUpdate,
  handleCalendarIcs,
} from "./handlers/calendar";
import { handleClusterSvg, handleClusterSvgs } from "./handlers/clusters";
import { handleImageServe, handleImageUpload } from "./handlers/images";
import { handleAnnouncement } from "./handlers/announcement";
import { handleStats } from "./handlers/stats";
import { Env, UserData } from "./types";
import {
  getBearerToken,
  isLoginHash,
  isOriginAllowed,
  serverErrorRes,
  textRes,
} from "./utils";

/**
 * This worker serves the Intra-login build of the extension: no 42 OAuth
 * application, no Discord, no R2. Every route that needed one of those (42
 * OAuth login, evaluation reminders and their crons, Discord, image hosting,
 * the students directory, logtime history, the 42 API proxy...) is gone
 * rather than answering errors: the routes below are exactly the ones the
 * extension calls (grep WORKER_URL in its src/).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      return serverErrorRes(e, env, request);
    }
  },
};

/** Routes that name a user through `login=<hash>` and read their KV record. */
const USER_ROUTES = new Set([
  "/api/v1/public/visuals",
  "/api/v1/private/settings",
  "/api/v1/private/subjects/report",
  "/api/v1/private/subjects/state",
  "/api/v1/private/calendar/token",
  "/api/v1/private/calendar/update",
  "/api/v1/private/images",
]);

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (origin && !isOriginAllowed(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }

  if (request.method === "OPTIONS") {
    const acao = origin || "*";
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": acao,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        // Every authenticated call is preflighted (Authorization header) and
        // the browser default keeps the answer 5 s: without this, each worker
        // call is two invocations. Chrome caps the cache at 7,200 s, Firefox
        // honours a day.
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }

  // Login with the Intra v3 session token (no 42 OAuth application needed)
  if (url.pathname === "/auth/intra") {
    return handleIntraAuth(request, env);
  }

  if (url.pathname.startsWith("/gh/")) {
    return handleGhProxy(request);
  }

  if (url.pathname === "/api/v1/cluster/svg") {
    return handleClusterSvg(request, env, origin);
  }

  if (url.pathname === "/api/v1/cluster/svgs") {
    return handleClusterSvgs(env, origin);
  }

  const imgMatch = url.pathname.match(/^\/img\/([a-f0-9]{64})\/([a-z]+)$/);
  if (imgMatch) {
    if (request.method !== "GET") return textRes("Method not allowed", 405);
    return handleImageServe(
      env,
      imgMatch[1],
      imgMatch[2],
      url.searchParams.get("v"),
      url.origin,
    );
  }

  const calMatch = url.pathname.match(/^\/calendar\/([^\/]+)\.ics$/);
  if (calMatch) {
    return handleCalendarIcs(calMatch[1], env);
  }

  if (url.pathname === "/api/v1/public/announcement") {
    return handleAnnouncement(request, env);
  }

  if (url.pathname === "/api/v1/public/stats") {
    return handleStats(request, env);
  }

  const loginsParam = url.searchParams.get("logins");
  if (url.pathname === "/api/v1/public/visuals" && loginsParam !== null) {
    return handlePublicVisualsBatch(request, env, loginsParam);
  }

  // Unknown paths are 404 whatever the query: the login checks below are for
  // the user routes only.
  if (!USER_ROUTES.has(url.pathname)) return textRes("Not found", 404);

  const loginParam = url.searchParams.get("login");
  if (!loginParam) {
    return textRes("Username hash required", 400);
  }
  if (!isLoginHash(loginParam)) {
    return textRes("Invalid username hash", 400);
  }

  // Every private route needs a Bearer token: refusing here, before the KV
  // read, means an anonymous scanner spends no read out of the daily budget.
  // Same 401 as a wrong token or an unknown login (see requireSession).
  if (url.pathname.startsWith("/api/v1/private/") && !getBearerToken(request)) {
    return textRes("Unauthorized", 401);
  }

  const existingData: UserData | null = await env.BETTER_INTRA_KV.get(
    loginParam,
    { type: "json" },
  );

  if (url.pathname === "/api/v1/public/visuals") {
    return handlePublicVisuals(request, existingData);
  }

  if (url.pathname === "/api/v1/private/settings") {
    return handlePrivateSettings(request, env, loginParam, existingData);
  }

  if (url.pathname === "/api/v1/private/subjects/report") {
    return handleSubjectsReport(request, env, loginParam, existingData);
  }

  if (url.pathname === "/api/v1/private/subjects/state") {
    return handleSubjectsState(request, env, loginParam, existingData);
  }

  if (url.pathname === "/api/v1/private/images") {
    // POST uploads, DELETE removes a slot
    return handleImageUpload(request, env, loginParam, existingData);
  }

  if (url.pathname === "/api/v1/private/calendar/token") {
    return handleCalendarToken(request, env, loginParam, existingData);
  }

  // USER_ROUTES leaves only /api/v1/private/calendar/update here
  return handleCalendarUpdate(request, env, loginParam, existingData);
}
