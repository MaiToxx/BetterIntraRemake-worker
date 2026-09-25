import { Env } from "../types";
import {
  FETCH_DEADLINES,
  fetchAllowed,
  jsonRes,
  methodNotAllowedRes,
  readBodyCapped,
  readJsonBody,
} from "../utils";
import { rateLimited, tooManyRes } from "../rate-limit";
import { recordLoader, requireSession, type RecordSource } from "../sessions";

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

/**
 * The extension reports one subject per request, and each new link can mean
 * a PDF download of up to 16 MB: one item, not five.
 */
const MAX_REPORT_ITEMS = 1;
/** A report is a slug and a URL: a few hundred bytes. */
const MAX_REPORT_BYTES = 4 * 1024;
/**
 * Every extension build asks for one slug (tracker.ts); a few leave room, and
 * all of them are read with one query. It took 20, at two sequential queries
 * each, on a route with no rate limit.
 */
const MAX_STATE_SLUGS = 5;

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
    // The minutes are optional (ISO 32000 allows `D:...+02'`): parsing the
    // missing group gave NaN, and the whole date was stored as null.
    const om = offset[3] ? parseInt(offset[3], 10) : 0;
    // An offset no clock has is left out rather than trusted.
    if (oh <= 23 && om <= 59) ms -= sign * (oh * 3600 + om * 60) * 1000;
  }
  return Number.isNaN(ms) ? null : ms;
}

interface PdfMeta {
  createdAt: number | null;
  modifiedAt: number | null;
}

/**
 * The download ran out of time (FETCH_DEADLINES.subjectPdfMs): unlike the
 * other failures, not a fact about the PDF.
 */
const PDF_TIMED_OUT = "timed_out";

/**
 * The PDF's dates, null when it cannot be read (an error status, a redirect
 * off the subject hosts, over 16 MB, a network error), or PDF_TIMED_OUT.
 */
async function fetchPdfMetadata(url: string): Promise<PdfMeta | null | typeof PDF_TIMED_OUT> {
  try {
    const res = await fetchAllowed(new URL(url), isAllowedSubjectUrl, FETCH_DEADLINES.subjectPdfMs, {
      headers: { "User-Agent": "better-intra-subject-tracker" },
    });
    if (!res || !res.ok) {
      await res?.body?.cancel().catch(() => {});
      return null;
    }
    const buf = await readBodyCapped(res, PDF_MAX_BYTES);
    if (!buf) return null;
    const text = new TextDecoder("iso-8859-1").decode(buf);
    const creationMatch = text.match(/\/CreationDate\s*\(([^)]*)\)/);
    const modifiedMatch = text.match(/\/ModDate\s*\(([^)]*)\)/);
    return {
      createdAt: creationMatch ? parsePdfDate(creationMatch[1]) : null,
      modifiedAt: modifiedMatch ? parsePdfDate(modifiedMatch[1]) : null,
    };
  } catch (e) {
    // A DOMException, which is not an Error in every runtime
    return (e as { name?: unknown } | null)?.name === "TimeoutError" ? PDF_TIMED_OUT : null;
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

/** The rows of `slugs` (at most MAX_STATE_SLUGS), in one query. */
async function loadSubjects(
  env: Env,
  slugs: string[],
): Promise<Map<string, SubjectRow>> {
  if (slugs.length === 0) return new Map();
  const { results } = await env.better_intra_d1
    .prepare(
      `SELECT slug, url, subject_id, created_at, modified_at, last_changed_at FROM subjects WHERE slug IN (${slugs.map(() => "?").join(", ")})`,
    )
    .bind(...slugs)
    .all<SubjectRow & { slug: string }>();
  return new Map(results.map((row) => [row.slug, row]));
}

/**
 * Seeds the slug, unless a concurrent first report seeded it since this one
 * found no row (the PDF download in between takes seconds): false then. A
 * plain INSERT threw on the primary key and that reporter got a 500.
 */
async function insertSubject(
  env: Env,
  slug: string,
  url: string,
  subjectId: string | null,
  createdAt: number | null,
  modifiedAt: number | null,
): Promise<boolean> {
  const { meta } = await env.better_intra_d1
    .prepare(
      "INSERT INTO subjects (slug, url, subject_id, created_at, modified_at, last_changed_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(slug) DO NOTHING",
    )
    .bind(slug, url, subjectId, createdAt, modifiedAt)
    .run();
  return meta.changes > 0;
}

/** A report answered from the stored row: same link, or same subject. */
function knownEntry(slug: string, row: SubjectRow) {
  return {
    slug,
    status: "known",
    // The project name came from the `projects` table, which only a 42
    // application ever filled: always null on this deployment. Kept in the
    // answer so its shape does not change.
    name: null,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    lastChangedAt: row.last_changed_at,
    subjectId: row.subject_id,
  };
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
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowedRes();

  const denied = await requireSession(request, env, loginParam, recordLoader(source));
  if (denied) return denied;

  // The only route that wrote shared data without a limit: a signed-in loop
  // could fill the registry, flash "Subject updated" to everyone and make the
  // worker download PDFs without end. Same bucket as the other writes.
  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  const parsed = await readJsonBody<{ items?: any[] }>(request, MAX_REPORT_BYTES, "Report too large");
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
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

    const current = await loadSubject(env, slug);
    if (!current) {
      // Seed: read the PDF metadata once.
      const meta = await fetchPdfMetadata(url);
      if (meta === PDF_TIMED_OUT) {
        // Not seeded: a row with null dates is never read again while the
        // link stays, so a slow CDN would take the dates from everyone for
        // good. The next reporter tries again (every build handles
        // "unknown": no date, like a failed report). A PDF that cannot be
        // read at all still seeds with null dates, so its changes are seen.
        results.push({ slug, status: "unknown", reason: "pdf_unavailable" });
        continue;
      }
      const seeded = await insertSubject(
        env,
        slug,
        url,
        subjectId,
        meta?.createdAt ?? null,
        meta?.modifiedAt ?? null,
      );
      if (!seeded) {
        const winner = await loadSubject(env, slug);
        if (winner) {
          results.push(knownEntry(slug, winner));
          continue;
        }
      }
      results.push({
        slug,
        status: "first",
        name: null,
        createdAt: meta?.createdAt ?? null,
        modifiedAt: meta?.modifiedAt ?? null,
        lastChangedAt: null,
        subjectId,
      });
      continue;
    }

    // Same link, or another file of the same subject (the language versions
    // of one PDF share its id): no refetch, the saved metadata. The extension
    // reports a change only when the id differs (tracker.ts); students on two
    // languages used to flip the link, and every flip was a download and a
    // "Subject updated" for everyone.
    const sameSubject =
      !!subjectId && !!current.subject_id && String(current.subject_id) === subjectId;
    if (current.url === url || sameSubject) {
      results.push(knownEntry(slug, current));
      continue;
    }

    // New link → fetch the new PDF metadata and record the change. The change
    // is recorded whatever the download gave: it is what every tracker user
    // is told about, and a reporter answered anything but "changed" would
    // show the previous change's date.
    const fetched = await fetchPdfMetadata(url);
    const meta = fetched === PDF_TIMED_OUT ? null : fetched;
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
      name: null,
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
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();

  const denied = await requireSession(request, env, loginParam, recordLoader(source));
  if (denied) return denied;

  const raw = new URL(request.url).searchParams.get("slugs") ?? "";
  const slugs = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(isValidSlug),
    ),
  ].slice(0, MAX_STATE_SLUGS);

  const rows = await loadSubjects(env, slugs);
  const results = slugs.map((slug) => {
    const row = rows.get(slug);
    return {
      slug,
      tracked: !!row,
      name: null,
      subjectId: row?.subject_id ?? null,
      createdAt: row?.created_at ?? null,
      modifiedAt: row?.modified_at ?? null,
      lastChangedAt: row?.last_changed_at ?? null,
    };
  });

  return jsonRes({ subjects: results });
}
