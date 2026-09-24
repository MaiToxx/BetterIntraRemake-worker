import { Env } from "../types";
import { jsonRes, readJsonBody, textRes } from "../utils";

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
): Promise<Response> {
  if (request.method === "GET") {
    const stored = await env.BETTER_INTRA_KV.get<Announcement>(
      ANNOUNCEMENT_KEY,
      { type: "json" },
    );
    return jsonRes({
      message: stored?.message ?? null,
      updatedAt: stored?.updatedAt ?? null,
      level: stored?.level ?? "critical",
      links: stored?.links ?? [],
    });
  }

  if (request.method === "POST") {
    const parsed = await readJsonBody<any>(
      request,
      MAX_ANNOUNCEMENT_BODY_BYTES,
      "Body too large",
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    // The secret only ever travels in a JSON body: a query string would sit
    // in Workers Logs for the retention window. Unset secret = route closed.
    if (
      !env.ANNOUNCEMENT_SECRET ||
      typeof body?.secret !== "string" ||
      body.secret !== env.ANNOUNCEMENT_SECRET
    ) {
      return textRes("Forbidden", 403);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length > MAX_MESSAGE_LENGTH) {
      return textRes(`Message too long (max ${MAX_MESSAGE_LENGTH})`, 400);
    }

    // An empty message is the one way to clear the banner
    if (message === "") {
      await env.BETTER_INTRA_KV.delete(ANNOUNCEMENT_KEY);
      return jsonRes({ message: null });
    }

    const level = normalizeLevel(body.level);
    const links = normalizeLinks(body.links);
    await env.BETTER_INTRA_KV.put(
      ANNOUNCEMENT_KEY,
      JSON.stringify({ message, updatedAt: Date.now(), level, links }),
    );
    return jsonRes({ message, level, links });
  }

  return textRes("Method not allowed", 405);
}
