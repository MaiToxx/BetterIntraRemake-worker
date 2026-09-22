import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleSubjectsReport,
  handleSubjectsState,
  normalizeSubjectUrl,
} from "../src/handlers/subjects";
import { Env, UserData } from "../src/types";

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

class MockD1 {
  subjects = new Map<string, SubjectRecord>();
  projectNames = new Map<string, string>();

  private sql = "";
  private bindArgs: any[] = [];

  prepare(sql: string) {
    this.sql = sql;
    return this;
  }

  bind(...args: any[]) {
    this.bindArgs = args;
    return this;
  }

  async first(): Promise<any> {
    const sql = this.sql;
    if (sql.includes("FROM subjects WHERE slug")) {
      const r = this.subjects.get(this.bindArgs[0]);
      return r
        ? {
            url: r.url,
            subject_id: r.subjectId,
            created_at: r.createdAt,
            modified_at: r.modifiedAt,
            last_changed_at: r.lastChangedAt,
          }
        : null;
    }
    if (sql.includes("FROM projects WHERE slug")) {
      const name = this.projectNames.get(this.bindArgs[0]);
      return name === undefined ? null : { name };
    }
    return null;
  }

  async run(): Promise<any> {
    const sql = this.sql;
    if (sql.startsWith("INSERT INTO subjects")) {
      const [slug, url, subjectId, createdAt, modifiedAt] = this.bindArgs;
      this.subjects.set(slug, {
        url,
        subjectId,
        createdAt,
        modifiedAt,
        lastChangedAt: null,
      });
      return {};
    }
    if (sql.startsWith("UPDATE subjects")) {
      const [url, subjectId, createdAt, modifiedAt, at, slug] = this.bindArgs;
      this.subjects.set(slug, {
        url,
        subjectId,
        createdAt,
        modifiedAt,
        lastChangedAt: at,
      });
      return {};
    }
    return {};
  }
}

function makeEnv(d1: MockD1): Env {
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

function mockPdfFetch(dates: string[]) {
  const calls: string[] = [];
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    calls.push(url);
    return pdfResponse(dates.shift() ?? dates[dates.length - 1]);
  });
  return calls;
}

describe("handleSubjectsReport", () => {
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
    d1.projectNames.set("python-module-10", "Python Module 10");
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
    expect(body.subjects[0]).toMatchObject({
      slug: "python-module-10",
      status: "first",
      name: "Python Module 10",
      createdAt: SEED_DATE,
      modifiedAt: SEED_DATE,
      lastChangedAt: null,
      subjectId: "900001",
    });
    expect(calls).toHaveLength(1);
    expect(d1.subjects.get("python-module-10")).toEqual({
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

    expect(d1.subjects.get("minishell")).toEqual({
      url: URL_B,
      subjectId: "900002",
      createdAt: NEW_DATE,
      modifiedAt: NEW_DATE,
      lastChangedAt: entry.lastChangedAt,
    });
  });

  it("never fetches or records a URL off the Intra subject hosts", async () => {
    const calls = mockPdfFetch(["D:20990101000000Z"]);
    const res = await handleSubjectsReport(
      post("https://x/report", {
        items: [
          { slug: "minishell", url: "https://evil.example/pdf/pdf/900001/en.subject.pdf" },
          { slug: "minishell", url: "http://cdn.intra.42.fr/pdf/pdf/900001/en.subject.pdf" },
          { slug: "minishell", url: "https://cdn.intra.42.fr.evil.example/pdf/pdf/1/en.subject.pdf" },
          { slug: "minishell", url: "https://cdn.intra.42.fr@evil.example/pdf/pdf/1/en.subject.pdf" },
          { slug: "minishell", url: "not a url" },
        ],
      }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toHaveLength(5);
    for (const entry of body.subjects) {
      expect(entry).toEqual({ slug: "minishell", status: "unknown", reason: "invalid_url" });
    }
    expect(calls).toEqual([]);
    expect(d1.subjects.size).toBe(0);
  });

  it("rejects malformed slugs before any work", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    const res = await handleSubjectsReport(
      post("https://x/report", {
        items: [
          { slug: "x".repeat(101), url: URL_A },
          { slug: "../libft", url: URL_A },
          { slug: "libft minishell", url: URL_A },
          { slug: "-libft", url: URL_A },
        ],
      }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects.map((e) => e.reason)).toEqual([
      "invalid_slug",
      "invalid_slug",
      "invalid_slug",
      "invalid_slug",
    ]);
    expect(body.subjects[0].slug).toHaveLength(100);
    expect(calls).toEqual([]);
    expect(d1.subjects.size).toBe(0);
  });

  it("accepts real project slugs", async () => {
    mockPdfFetch(["D:20260811161924+02'00'"]);
    const slugs = ["42cursus-libft", "ft_printf", "c-piscine-c-00", "python-module-10"];
    const res = await handleSubjectsReport(
      post("https://x/report", { items: slugs.map((slug) => ({ slug, url: URL_A })) }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects.map((e) => e.status)).toEqual(["first", "first", "first", "first"]);
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
    expect(d1.subjects.get("libft")?.url).toBe(URL_A);
  });

  it("handles at most 5 items per request", async () => {
    const calls = mockPdfFetch(["D:20260811161924+02'00'"]);
    const items = Array.from({ length: 12 }, (_, i) => ({ slug: `project-${i}`, url: URL_A }));
    const res = await handleSubjectsReport(
      post("https://x/report", { items }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toHaveLength(5);
    expect(calls).toHaveLength(5);
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
    const res = await handleSubjectsReport(
      post("https://x/report", { items: [{ slug: "" }, { url: URL_A }] }),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toEqual([
      { slug: "", status: "unknown", reason: "missing_slug_or_url" },
      { slug: "", status: "unknown", reason: "missing_slug_or_url" },
    ]);
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
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
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

  it("skips malformed slugs and caps the list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `p-${i}`);
    const res = await handleSubjectsState(
      get(`https://x/state?slugs=${encodeURIComponent(["../x", ...many].join(","))}`),
      env,
      "hash-a",
      sessionData(),
    );
    const body = (await res.json()) as { subjects: any[] };
    expect(body.subjects).toHaveLength(20);
    expect(body.subjects[0].slug).toBe("p-0");
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
    d1.subjects.set("libft", {
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
