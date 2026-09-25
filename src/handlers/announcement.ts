import { Env } from "../types";
import { clientKey, rateLimited, tooManyRes } from "../rate-limit";
import { errorRes, jsonRes, methodNotAllowedRes, readJsonBody } from "../utils";

const ANNOUNCEMENT_KEY = "ANNOUNCEMENT";
const MAX_MESSAGE_LENGTH = 500;
const MAX_LINKS = 5;

/**
 * Largest POST body read. The route is open to anyone until the secret is
 * checked, and that check needs the parsed body: a 500-character message
 * and five links fit many times over.
 */
export const MAX_ANNOUNCEMENT_BODY_BYTES = 16 * 1024;

const VALID_LEVELS = ["info", "warning", "critical"] as const;
export type AnnouncementLevel = (typeof VALID_LEVELS)[number];

export type AnnouncementLink = { text: string; url: string };

type Announcement = {
  message: string;
  updatedAt: number;
  level: AnnouncementLevel;
  links: AnnouncementLink[];
};

/** What GET answers: the banner, or nulls when there is none. */
type AnnouncementBody = {
  message: string | null;
  updatedAt: number | null;
  level: AnnouncementLevel;
  links: AnnouncementLink[];
};

const NO_ANNOUNCEMENT: AnnouncementBody = {
  message: null,
  updatedAt: null,
  level: "critical",
  links: [],
};

/**
 * How long an isolate serves the same banner. Every profile page load of
 * every extension user asks for it (the extension keeps its copy 5 minutes),
 * the route is public and unlimited, and the key is empty nearly all the
 * time: a billed KV miss per load. The empty answer is kept like a set one. 5 minutes like the extension's
 * cache, because at today's traffic a shorter memo is almost never hit. The
 * POST that sets or clears the banner updates it at once in its isolate;
 * the others follow within this plus KV's own 60 s edge cache. The Cache API
 * does nothing on workers.dev, hence the memory.
 */
export const ANNOUNCEMENT_CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; body: AnnouncementBody } | null = null;

/** Test hook. */
export function resetAnnouncementCache(): void {
  cached = null;
}

/**
 * Whether the POSTed secret is the configured one, in time that does not
 * depend on where they differ: both are hashed to 32 bytes and compared with
 * no early exit. Not crypto.subtle.timingSafeEqual, which exists in workerd
 * only (the tests run on Node).
 */
async function secretMatches(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function normalizeLevel(raw: unknown): AnnouncementLevel {
  return typeof raw === "string" &&
    (VALID_LEVELS as readonly string[]).includes(raw)
    ? (raw as AnnouncementLevel)
    : "critical";
}

function normalizeLinks(raw: unknown): AnnouncementLink[] {
  if (!Array.isArray(raw)) return [];
  const links: AnnouncementLink[] = [];
  for (const item of raw.slice(0, MAX_LINKS)) {
    if (!item || typeof item !== "object") continue;
    const text = String((item as Record<string, unknown>).text ?? "").trim();
    const url = String((item as Record<string, unknown>).url ?? "").trim();
    if (!text || !url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      links.push({ text, url });
    } catch {
      /* skip invalid URL */
    }
  }
  return links;
}

export async function handleAnnouncement(
  request: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method === "GET") {
    if (!cached || now - cached.at >= ANNOUNCEMENT_CACHE_MS) {
      // A KV error is thrown before this assignment: never kept, the next
      // GET reads again (the router answers this one with a 500).
      const stored = await env.BETTER_INTRA_KV.get<Announcement>(
        ANNOUNCEMENT_KEY,
        { type: "json" },
      );
      cached = {
        at: now,
        body: {
          message: stored?.message ?? null,
          updatedAt: stored?.updatedAt ?? null,
          level: stored?.level ?? "critical",
          links: stored?.links ?? [],
        },
      };
    }
    return jsonRes(cached.body);
  }

  if (request.method === "POST") {
    // Unset secret = route closed, before the body is even read.
    if (!env.ANNOUNCEMENT_SECRET) {
      return errorRes("unauthorized", "Forbidden", 403);
    }
    // The only admin route is public: without a limit it was a password
    // oracle, one free guess per request, and a guessed secret puts a
    // "critical" banner with links into every user's Intra pages. Its own
    // bucket (5 a minute per IP, /64 for IPv6), so a guessing loop behind a
    // campus NAT does not also lock everyone there out of signing in.
    if (await rateLimited(env, "admin", clientKey(request.headers.get("CF-Connecting-IP")))) {
      return tooManyRes();
    }
    const parsed = await readJsonBody<any>(
      request,
      MAX_ANNOUNCEMENT_BODY_BYTES,
      "Body too large",
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    // The secret only ever travels in a JSON body: a query string would sit
    // in Workers Logs for the retention window.
    if (
      typeof body?.secret !== "string" ||
      !(await secretMatches(body.secret, env.ANNOUNCEMENT_SECRET))
    ) {
      return errorRes("unauthorized", "Forbidden", 403);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length > MAX_MESSAGE_LENGTH) {
      return errorRes("bad_request", `Message too long (max ${MAX_MESSAGE_LENGTH})`, 400);
    }

    // An empty message is the one way to clear the banner
    if (message === "") {
      await env.BETTER_INTRA_KV.delete(ANNOUNCEMENT_KEY);
      // This isolate is exact at once; the others within ANNOUNCEMENT_CACHE_MS
      cached = { at: now, body: NO_ANNOUNCEMENT };
      return jsonRes({ message: null });
    }

    const level = normalizeLevel(body.level);
    const links = normalizeLinks(body.links);
    const stored: Announcement = { message, updatedAt: now, level, links };
    await env.BETTER_INTRA_KV.put(ANNOUNCEMENT_KEY, JSON.stringify(stored));
    cached = { at: now, body: stored };
    return jsonRes({ message, level, links });
  }

  return methodNotAllowedRes();
}
