import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetRateLimits } from "../src/rate-limit";
import {
  handleSubjectsReport,
  handleSubjectsState,
  normalizeSubjectUrl,
} from "../src/handlers/subjects";
import { Env, UserData } from "../src/types";
import { FETCH_DEADLINES } from "../src/utils";
import { FakeD1, hangingFetch, stalledBody } from "./helpers/fake-env";

const TOKEN = "test-session-token";
const SEED_DATE = Date.UTC(2026, 7, 11, 14, 19, 24);
const NEW_DATE = Date.UTC(2026, 8, 1, 8, 9, 0);

interface SubjectRecord {
  url: string;
  subjectId: string | null;
  createdAt: number | null;
  modifiedAt: number | null;
  lastChangedAt: number | null;
}

/** The stored row of `slug` (real SQLite, like D1), or undefined. */
function subjectRow(d1: FakeD1, slug: string): SubjectRecord | undefined {
  const r = d1.rows(
    "SELECT url, subject_id, created_at, modified_at, last_changed_at FROM subjects WHERE slug = ?",
    slug,
  )[0];
  return r
    ? {
        url: r.url as string,
        subjectId: r.subject_id as string | null,
        createdAt: r.created_at as number | null,
        modifiedAt: r.modified_at as number | null,
        lastChangedAt: r.last_changed_at as number | null,
      }
    : undefined;
}

function putSubject(d1: FakeD1, slug: string, r: SubjectRecord): void {
  d1.raw
    .prepare(
      "INSERT INTO subjects (slug, url, subject_id, created_at, modified_at, last_changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(slug, r.url, r.subjectId, r.createdAt, r.modifiedAt, r.lastChangedAt);
}

const subjectCount = (d1: FakeD1) => Number(d1.rows("SELECT COUNT(*) AS n FROM subjects")[0].n);

/** Statements of the registry itself, leaving out the session checks. */
const subjectStatements = (d1: FakeD1) => d1.prepared.filter((sql) => !/\bsession/.test(sql));

function makeEnv(d1: FakeD1): Env {
  return { better_intra_d1: d1 as any, BETTER_INTRA_KV: {} as any } as Env;
}

function sessionData(): UserData {
  return { sessionTokens: [TOKEN] };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(url: string): Request {
  return new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

// The host tracker.ts reports: the first PDF attachment of a project page.
const URL_A = "https://cdn.intra.42.fr/pdf/pdf/900001/en.subject.pdf";
const URL_B = "https://cdn.intra.42.fr/pdf/pdf/900002/en.subject.pdf";

function pdfResponse(modDate: string): Response {
  const text = `<< /CreationDate (${modDate}) /ModDate (${modDate}) /Producer (pdfTeX-1.40.28) >>`;
  const bytes = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
  return new Response(bytes, { status: 200 });
}

const DEADLINE = FETCH_DEADLINES.subjectPdfMs;
afterEach(() => {
  FETCH_DEADLINES.subjectPdfMs = DEADLINE;
});

function mockPdfFetch(dates: string[]) {
  const calls: string[] = [];
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    calls.push(url);
    return pdfResponse(dates.shift() ?? dates[dates.length - 1]);
  });
  return calls;
}

describe("handleSubjectsReport", () => {
  let d1: FakeD1;
  let env: Env;

  beforeEach(() => {
    // the write limiter counts per login across cases otherwise
    resetRateLimits();
    d1 = new FakeD1();
    // what a live database may hold: a 42-application name nothing reads
    d1.raw.prepare("INSERT INTO projects (id, name, slug) VALUES (1, 'Python Module 10', 'python-module-10')").run();
    env = makeEnv(d1);
    vi.restoreAllMocks();
  });

  it("rejects non-POST", async () => {
    const res = await handleSubjectsReport(
      new Request("https://x/report"),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(405);
  });

  it("rejects missing auth", async () => {
    const res = await handleSubjectsReport(
      new Request("https://x/report", { method: "POST", body: "{}" }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(401);
  });

  it("answers the same 401 for an unknown login as for a wrong token", async () => {
    const snapshot = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort(),
    });
    const wrong = await snapshot(
      await handleSubjectsReport(
        new Request("https://x/report", {
          method: "POST",
          headers: { Authorization: "Bearer forged" },
          body: "{}",
        }),
        env,
        "hash-a",
        sessionData(),
      ),
    );
    expect(wrong.status).toBe(401);
    const unknown = await snapshot(
      await handleSubjectsReport(post("https://x/report", {}), env, "hash-b", null),
    );
    expect(unknown).toEqual(wrong);
    const unknownState = await snapshot(
      await handleSubjectsState(get("https://x/state?slugs=libft"), env, "hash-b", null),
    );
    expect(unknownState).toEqual(wrong);
  });

  it("seeds a new slug by reading the pdf metadata", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    const res = await handleSubjectsReport(
      post("https://x/report", {
        items: [{ slug: "python-module-10", url: URL_A }],
      }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toEqual({
      slug: "python-module-10",
      status: "first",
      name: null,
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: null,
      subjectId: "900001",
    });
    expect(calls).toHaveLength(1);
    // the project name query is gone: the table only ever held what a 42
    // application filled in, and nothing read the name
    expect(d1.prepared.some((sql) => /\bprojects\b/.test(sql))).toBe(false);
    expect(subjectRow(d1, "python-module-10")).toEqual({
      url: URL_A,
      subjectId: "900001",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: null,
    });
  });

  it("seeds with null dates when the pdf cannot be fetched", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await handleSubjectsReport(
      post("https://x/report", {
        items: [{ slug: "python-module-10", url: URL_A }],
      }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0].status).toBe("first");
    expect(body.subjects[0].createdAt).toBeNull();
    expect(body.subjects[0].modifiedAt).toBeNull();
    expect(subjectRow(d1, "python-module-10")?.createdAt).toBeNull();
  });

  for (const [form, date] of [
    ["+02'00'", "D:20260811161924+02'00'"],
    // ISO 32000 allows the minutes to be left out: read as null before
    ["+02' (no minutes)", "D:20260811161924+02'"],
    ["+02 (no apostrophe)", "D:20260811161924+02"],
    ["+0200", "D:20260811161924+0200"],
    // Quartz (macOS) writes UTC this way
    ["Z00'00'", "D:20260811141924Z00'00'"],
    ["-05'30'", "D:20260811084924-05'30'"],
  ] as const) {
    it(`reads a PDF date with the offset ${form}`, async () => {
      mockPdfFetch([date]);
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
        env,
        "hash-a",
        sessionData(),
      );
      const entry = ((await res.json()) as { subjects: any[] }).subjects[0];
      expect(entry).toMatchObject({ status: "first", createdAt: SEED_DATE, modifiedAt: SEED_DATE });
      expect(subjectRow(d1, "libft")?.modifiedAt).toBe(SEED_DATE);
    });
  }

  it("ignores an offset no clock has rather than shifting the date by it", async () => {
    mockPdfFetch(["D:20260811141924+99'00'"]);
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(((await res.json()) as { subjects: any[] }).subjects[0].createdAt).toBe(SEED_DATE);
  });

  it("answers two concurrent first reports of one slug, one row and one 'known'", async () => {
    // Both requests find no row, then download: the second insert used to
    // throw on the primary key and answer 500.
    let release!: () => void;
    const bothFetching = new Promise<void>((resolve) => (release = resolve));
    let fetches = 0;
    (globalThis as any).fetch = vi.fn(async () => {
      if (++fetches === 2) release();
      await bothFetching;
      return pdfResponse("D:20260811161924+02'00'");
    });
    const report = (login: string) =>
      handleSubjectsReport(
        post("https://x/report", { items: [{ slug: "minishell", url: URL_A }] }),
        env,
        login,
        sessionData(),
      );
    const [a, b] = await Promise.all([report("hash-a"), report("hash-b")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const entries = [
      ((await a.json()) as { subjects: any[] }).subjects[0],
      ((await b.json()) as { subjects: any[] }).subjects[0],
    ];
    expect(entries.map((e) => e.status).sort()).toEqual(["first", "known"]);
    expect(entries.find((e) => e.status === "known")).toEqual({
      slug: "minishell",
      status: "known",
      name: null,
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: null,
      subjectId: "900001",
    });
    expect(fetches).toBe(2);
    expect(subjectCount(d1)).toBe(1);
  });

  it("does not seed a slug whose PDF download timed out: the next reporter does", async () => {
    FETCH_DEADLINES.subjectPdfMs = 20;
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(hangingFetch(calls));
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subjects: any[] }).subjects).toEqual([
      { slug: "libft", status: "unknown", reason: "pdf_unavailable" },
    ]);
    expect(calls).toEqual([URL_A]);
    expect(subjectCount(d1)).toBe(0);

    mockPdfFetch(["D:20260811161924+02'00'"]);
    const next = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-b",
      sessionData(),
    );
    expect(((await next.json()) as { subjects: any[] }).subjects[0]).toMatchObject({
      status: "first",
      createdAt: SEED_DATE,
    });
    expect(subjectRow(d1, "libft")?.createdAt).toBe(SEED_DATE);
  });

  it("times out a PDF that stalls mid-body the same way, without seeding", async () => {
    FETCH_DEADLINES.subjectPdfMs = 20;
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      stalledBody(init, "%PDF-1.7 << /CreationDate (D:2026"),
    );
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(((await res.json()) as { subjects: any[] }).subjects[0]).toEqual({
      slug: "libft",
      status: "unknown",
      reason: "pdf_unavailable",
    });
    expect(subjectCount(d1)).toBe(0);
  });

  it("still records a change whose new PDF timed out, with null dates", async () => {
    putSubject(d1, "minishell", {
      url: URL_A,
      subjectId: "900001",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: null,
    });
    FETCH_DEADLINES.subjectPdfMs = 20;
    (globalThis as any).fetch = vi.fn(hangingFetch());
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const entry = ((await res.json()) as { subjects: any[] }).subjects[0];
    expect(entry).toMatchObject({ status: "changed", modifiedAt: null, to: { subjectId: "900002", modifiedAt: null } });
    expect(subjectRow(d1, "minishell")).toMatchObject({ url: URL_B, subjectId: "900002", createdAt: null });
  });

  it("is known for an unchanged url without re-fetching the pdf", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({
      status: "known",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
    });
    expect(calls).toHaveLength(1);
  });

  it("detects a changed url, reads the new metadata and records the change", async () => {
    const calls = mockPdfFetch([
      "D:20260811161924+02'00'",
      "D:20260901100900+02'00'",
    ]);
    await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );

    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "minishell", url: URL_B }] }),
      env,
      "hash-b",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    const entry = body.subjects[0];
    expect(entry.status).toBe("changed");
    expect(entry.modifiedAt).toBe(NEW_DATE);
    expect(entry.lastChangedAt).toBeTruthy();
    expect(entry.from).toEqual({
      subjectId: "900001",
      modifiedAt: SEED_DATE,
    });
    expect(entry.to).toEqual({
      subjectId: "900002",
      modifiedAt: NEW_DATE,
    });
    expect(calls).toHaveLength(2);

    expect(subjectRow(d1, "minishell")).toEqual({
      url: URL_B,
      subjectId: "900002",
      createdAt: NEW_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: entry.lastChangedAt,
    });
  });

  it("never fetches or records a URL off the Intra subject hosts", async () => {
    const calls = mockPdfFetch(["D:20990101000000Z"]);
    const urls = [
      "https://evil.example/pdf/pdf/900001/en.subject.pdf",
      "http://cdn.intra.42.fr/pdf/pdf/900001/en.subject.pdf",
      "https://cdn.intra.42.fr.evil.example/pdf/pdf/1/en.subject.pdf",
      "https://cdn.intra.42.fr@evil.example/pdf/pdf/1/en.subject.pdf",
      "not a url",
    ];
    for (const url of urls) {
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [{ slug: "minishell", url }] }),
        env,
        "hash-a",
        sessionData(),
      );
      const body = (await res.json()) as { subjects: any[] };
      expect(body.subjects).toEqual([{ slug: "minishell", status: "unknown", reason: "invalid_url" }]);
    }
    expect(calls).toEqual([]);
    expect(subjectCount(d1)).toBe(0);
  });

  it("rejects malformed slugs before any work", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    const entries: any[] = [];
    for (const slug of ["x".repeat(101), "../libft", "libft minishell", "-libft"]) {
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [{ slug, url: URL_A }] }),
        env,
        "hash-a",
        sessionData(),
      );
      entries.push(...((await res.json()) as { subjects: any[] }).subjects);
    }
    expect(entries.map((e) => e.reason)).toEqual([
      "invalid_slug",
      "invalid_slug",
      "invalid_slug",
      "invalid_slug",
    ]);
    expect(entries[0].slug).toHaveLength(100);
    expect(calls).toEqual([]);
    expect(subjectCount(d1)).toBe(0);
  });

  it("accepts real project slugs", async () => {
    mockPdfFetch(["D:20260811161924+02'00'"]);
    const slugs = ["42cursus-libft", "ft_printf", "c-piscine-c-00", "python-module-10"];
    const statuses: string[] = [];
    for (const slug of slugs) {
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [{ slug, url: URL_A }] }),
        env,
        "hash-a",
        sessionData(),
      );
      statuses.push(((await res.json()) as { subjects: any[] }).subjects[0].status);
    }
    expect(statuses).toEqual(["first", "first", "first", "first"]);
  });

  it("stores the link without query or fragment, like the extension sends it", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: `${URL_A}?x=1#page=2` }] }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(calls).toEqual([URL_A]);
    expect(subjectRow(d1, "libft")?.url).toBe(URL_A);
  });

  it("handles one item per request (each can be a 16 MB download)", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    const items = Array.from({ length: 12 }, (_, i) => ({ slug: `project-${i}`, url: URL_A }));
    const res = await handleSubjectsReport(
      post("https://x/report", { items }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("refuses a body over 4 KB, and a loop past the write limit", async () => {
    const big = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A, pad: "x".repeat(5000) }] }),
      env,
      "hash-a",
      sessionData(),
    );
    expect(big.status).toBe(413);
    mockPdfFetch(["D:20260811161924+02'00'"]);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
        env,
        "hash-loop",
        sessionData(),
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("another file of the same subject (a language version) is not a change", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A.replace("en.subject", "fr.subject") }] }),
      env,
      "hash-b",
      sessionData(),
    );
    expect(((await res.json()) as { subjects: any[] }).subjects[0].status).toBe("known");
    expect(calls).toHaveLength(1);
  });

  it("does not follow a redirect off the subject hosts", async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/x.pdf" } });
    });
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({ status: "first", createdAt: null, modifiedAt: null });
    expect(calls).toEqual([URL_A]);
  });

  it("does not buffer an oversized PDF", async () => {
    (globalThis as any).fetch = vi.fn(
      async () =>
        new Response("x", { status: 200, headers: { "Content-Length": String(64 * 1024 * 1024) } }),
    );
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "libft", url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toMatchObject({ status: "first", modifiedAt: null });
  });

  it("rejects entries missing a slug or url", async () => {
    for (const item of [{ slug: "" }, { url: URL_A }]) {
      const res = await handleSubjectsReport(
        post("https://x/report", { items: [item] }),
        env,
        "hash-a",
        sessionData(),
      );
      const body = (await res.json()) as { subjects: any[] };
      expect(body.subjects).toEqual([{ slug: "", status: "unknown", reason: "missing_slug_or_url" }]);
    }
  });
});

describe("normalizeSubjectUrl", () => {
  it("keeps https PDFs on the Intra subject hosts, without query or fragment", () => {
    expect(normalizeSubjectUrl(URL_A)).toBe(URL_A);
    expect(normalizeSubjectUrl(`${URL_A}?a=1#b`)).toBe(URL_A);
    expect(normalizeSubjectUrl("https://CDN.INTRA.42.FR/pdf/pdf/1/en.subject.PDF")).toBe(
      "https://cdn.intra.42.fr/pdf/pdf/1/en.subject.PDF",
    );
    expect(normalizeSubjectUrl("https://projects.intra.42.fr/uploads/document/1/en.subject.pdf")).toBe(
      "https://projects.intra.42.fr/uploads/document/1/en.subject.pdf",
    );
  });

  it("refuses everything else", () => {
    for (const bad of [
      "https://cdn.intra.42.fr/users/someone.jpg",
      "https://meta.intra.42.fr/x.pdf",
      "https://cdn.intra.42.fr:444/pdf/pdf/1/en.subject.pdf",
      "https://u:p@cdn.intra.42.fr/pdf/pdf/1/en.subject.pdf",
      "ftp://cdn.intra.42.fr/pdf/pdf/1/en.subject.pdf",
      "",
    ]) {
      expect(normalizeSubjectUrl(bad)).toBeNull();
    }
  });
});

describe("handleSubjectsState", () => {
  let d1: FakeD1;
  let env: Env;

  beforeEach(() => {
    d1 = new FakeD1();
    env = makeEnv(d1);
  });

  it("requires auth", async () => {
    const res = await handleSubjectsState(
      new Request("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    expect(res.status).toBe(401);
  });

  it("skips malformed slugs, counts a repeated one once and caps the list at 5", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `p-${i}`);
    const res = await handleSubjectsState(
      get(`https://x/state?slugs=${encodeURIComponent(["../x", "p-0", "p-0", ...many].join(","))}`),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects.map((s) => s.slug)).toEqual(["p-0", "p-1", "p-2", "p-3", "p-4"]);
  });

  it("reads every slug with one query, in the order asked", async () => {
    putSubject(d1, "libft", { url: URL_A, subjectId: "900001", createdAt: SEED_DATE, modifiedAt: SEED_DATE, lastChangedAt: null });
    putSubject(d1, "minishell", { url: URL_B, subjectId: "900002", createdAt: null, modifiedAt: NEW_DATE, lastChangedAt: 7 });
    const res = await handleSubjectsState(
      get("https://x/state?slugs=minishell,cub3d,libft"),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects.map((s) => [s.slug, s.tracked, s.subjectId])).toEqual([
      ["minishell", true, "900002"],
      ["cub3d", false, null],
      ["libft", true, "900001"],
    ]);
    expect(body.subjects[0]).toMatchObject({ createdAt: null, modifiedAt: NEW_DATE, lastChangedAt: 7, name: null });
    expect(subjectStatements(d1)).toHaveLength(1);
    expect(d1.prepared.some((sql) => /\bprojects\b/.test(sql))).toBe(false);
  });

  it("runs no registry query when no slug is valid", async () => {
    const res = await handleSubjectsState(get("https://x/state?slugs=../x,,%20"), env, "hash-a", sessionData());
    expect(await res.json()).toEqual({ subjects: [] });
    expect(subjectStatements(d1)).toEqual([]);
  });

  it("returns tracked:false for unknown slugs", async () => {
    const res = await handleSubjectsState(
      get("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toEqual([
      {
        slug: "libft",
        tracked: false,
        name: null,
        subjectId: null,
        createdAt: null,
        modifiedAt: null,
        lastChangedAt: null,
      },
    ]);
  });

  it("returns the saved url and dates for tracked slugs", async () => {
    putSubject(d1, "libft", {
      url: URL_A,
      subjectId: "900001",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: 999,
    });
    const res = await handleSubjectsState(
      get("https://x/state?slugs=libft"),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects[0]).toEqual({
      slug: "libft",
      tracked: true,
      name: null,
      subjectId: "900001",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: 999,
    });
  });
});
