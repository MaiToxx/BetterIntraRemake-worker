import { Env, UserData } from "../types";
import {
  fetchAllowed,
  getBearerToken,
  jsonRes,
  readBodyCapped,
  textRes,
  validateSession,
} from "../utils";

/**
 * Hosts a subject link can be on. tracker.ts reports the `href` of the first
 * PDF attachment of a projects.intra.42.fr page (normalised to origin +
 * pathname by fingerprint.ts): an absolute link to the Intra CDN, or a relative
 * one, which resolves on projects.intra.42.fr. The worker fetches the URL, so
 * any other host would let a signed-in user make it download anything.
 */
const SUBJECT_HOSTS = new Set(["cdn.intra.42.fr", "projects.intra.42.fr"]);

/** Project slugs are short lowercase words joined by - or _. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** The extension reports one subject per request: room to spare, no chains. */
const MAX_REPORT_ITEMS = 5;
const MAX_STATE_SLUGS = 20;

/**
 * Subject PDFs weigh a few MB. The dates sit in the Info dictionary, usually
 * near the end of the file, so the body is read whole or not at all.
 */
const PDF_MAX_BYTES = 16 * 1024 * 1024;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function isAllowedSubjectUrl(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port) return false;
  return SUBJECT_HOSTS.has(u.hostname);
}

/**
 * The URL as it is stored and fetched (origin + pathname, like the extension
 * reports it), or null when it is not a PDF on a subject host.
 */
export function normalizeSubjectUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!isAllowedSubjectUrl(u)) return null;
  if (!/\.pdf$/i.test(u.pathname)) return null;
  return `${u.origin}${u.pathname}`;
}

function parseSubjectIdFromUrl(url: string): string | null {
  return url.match(/\/pdf\/pdf\/(\d+)\//)?.[1] ?? null;
}

function parsePdfDate(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = m[4] ? parseInt(m[4], 10) : 0;
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  const second = m[6] ? parseInt(m[6], 10) : 0;
  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = raw.match(/([+-])(\d{2})'?(\d{2})?'?$/);
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const oh = parseInt(offset[2], 10);
    const om = parseInt(offset[3], 10);
    ms -= sign * (oh * 3600 + om * 60) * 1000;
  }
  return Number.isNaN(ms) ? null : ms;
}

async function fetchPdfMetadata(
  url: string,
): Promise<{ createdAt: number | null; modifiedAt: number | null } | null> {
  try {
    const res = await fetchAllowed(new URL(url), isAllowedSubjectUrl, {
      headers: { "User-Agent": "better-intra-subject-tracker" },
    });
    if (!res || !res.ok) return null;
    const buf = await readBodyCapped(res, PDF_MAX_BYTES);
    if (!buf) return null;
    const text = new TextDecoder("iso-8859-1").decode(buf);
    const creationMatch = text.match(/\/CreationDate\s*\(([^)]*)\)/);
    const modifiedMatch = text.match(/\/ModDate\s*\(([^)]*)\)/);
    return {
      createdAt: creationMatch ? parsePdfDate(creationMatch[1]) : null,
      modifiedAt: modifiedMatch ? parsePdfDate(modifiedMatch[1]) : null,
    };
  } catch {
    return null;
  }
}

interface SubjectRow {
  url: string;
  subject_id: string | null;
  created_at: number | null;
  modified_at: number | null;
  last_changed_at: number | null;
}

async function loadSubject(env: Env, slug: string): Promise<SubjectRow | null> {
  return (
    (await env.better_intra_d1
      .prepare(
        "SELECT url, subject_id, created_at, modified_at, last_changed_at FROM subjects WHERE slug = ?",
      )
      .bind(slug)
      .first<SubjectRow>()) ?? null
  );
}

async function loadProjectName(env: Env, slug: string): Promise<string | null> {
  const row = await env.better_intra_d1
    .prepare("SELECT name FROM projects WHERE slug = ?")
    .bind(slug)
    .first<{ name: string }>();
  return row?.name ?? null;
}

async function insertSubject(
  env: Env,
  slug: string,
  url: string,
  subjectId: string | null,
  createdAt: number | null,
  modifiedAt: number | null,
): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "INSERT INTO subjects (slug, url, subject_id, created_at, modified_at, last_changed_at) VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(slug, url, subjectId, createdAt, modifiedAt)
    .run();
}

async function updateSubject(
  env: Env,
  slug: string,
  url: string,
  subjectId: string | null,
  createdAt: number | null,
  modifiedAt: number | null,
  at: number,
): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "UPDATE subjects SET url = ?, subject_id = ?, created_at = ?, modified_at = ?, last_changed_at = ? WHERE slug = ?",
    )
    .bind(url, subjectId, createdAt, modifiedAt, at, slug)
    .run();
}

export async function handleSubjectsReport(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let body: { items?: any[] };
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON", 400);
  }
  const items = Array.isArray(body?.items)
    ? body.items.slice(0, MAX_REPORT_ITEMS)
    : [];

  const now = Date.now();
  const results: any[] = [];

  for (const item of items) {
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    if (!slug || typeof item?.url !== "string" || !item.url.trim()) {
      results.push({ slug, status: "unknown", reason: "missing_slug_or_url" });
      continue;
    }

    // Checked before any D1 or network work: the registry is shared by every
    // user, and the URL is fetched by the worker.
    if (!isValidSlug(slug)) {
      results.push({
        slug: slug.slice(0, 100),
        status: "unknown",
        reason: "invalid_slug",
      });
      continue;
    }
    const url = normalizeSubjectUrl(item.url.trim());
    if (!url) {
      results.push({ slug, status: "unknown", reason: "invalid_url" });
      continue;
    }

    const subjectId = parseSubjectIdFromUrl(url);
    const name = await loadProjectName(env, slug);

    const current = await loadSubject(env, slug);
    if (!current) {
      // Seed: read the PDF metadata once.
      const meta = await fetchPdfMetadata(url);
      await insertSubject(
        env,
        slug,
        url,
        subjectId,
        meta?.createdAt ?? null,
        meta?.modifiedAt ?? null,
      );
      results.push({
        slug,
        status: "first",
        name,
        createdAt: meta?.createdAt ?? null,
        modifiedAt: meta?.modifiedAt ?? null,
        lastChangedAt: null,
        subjectId,
      });
      continue;
    }

    if (current.url === url) {
      // Same link → no refetch, return the already-saved metadata.
      results.push({
        slug,
        status: "known",
        name,
        createdAt: current.created_at,
        modifiedAt: current.modified_at,
        lastChangedAt: current.last_changed_at,
        subjectId: current.subject_id,
      });
      continue;
    }

    // New link → fetch the new PDF metadata and record the change.
    const meta = await fetchPdfMetadata(url);
    await updateSubject(
      env,
      slug,
      url,
      subjectId,
      meta?.createdAt ?? null,
      meta?.modifiedAt ?? null,
      now,
    );
    results.push({
      slug,
      status: "changed",
      name,
      createdAt: meta?.createdAt ?? null,
      modifiedAt: meta?.modifiedAt ?? null,
      lastChangedAt: now,
      from: {
        subjectId: current.subject_id,
        modifiedAt: current.modified_at,
      },
      to: { subjectId, modifiedAt: meta?.modifiedAt ?? null },
    });
  }

  return jsonRes({ subjects: results });
}

export async function handleSubjectsState(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const raw = new URL(request.url).searchParams.get("slugs") ?? "";
  const slugs = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isValidSlug)
    .slice(0, MAX_STATE_SLUGS);

  const results: any[] = [];
  for (const slug of slugs) {
    const row = await loadSubject(env, slug);
    const name = await loadProjectName(env, slug);
    results.push({
      slug,
      tracked: !!row,
      name,
      subjectId: row?.subject_id ?? null,
      createdAt: row?.created_at ?? null,
      modifiedAt: row?.modified_at ?? null,
      lastChangedAt: row?.last_changed_at ?? null,
    });
  }

  return jsonRes({ subjects: results });
}
