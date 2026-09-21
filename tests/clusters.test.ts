import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleClusterSvg,
  isAllowedClusterSvgUrl,
} from "../src/handlers/clusters";
import { makeEnv } from "./helpers/fake-env";

const SVG = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect id="k0r1p1"/></svg>`;
const MAP_URL = "https://cdn.intra.42.fr/cluster/image/104/k0.svg";

function call(target: string | null, origin: string | null = null) {
  const u = new URL("https://w.test/api/v1/cluster/svg");
  if (target !== null) u.searchParams.set("url", target);
  return handleClusterSvg(new Request(u), makeEnv().env, origin);
}

describe("isAllowedClusterSvgUrl", () => {
  it("accepts https Intra hosts only", () => {
    for (const ok of [
      MAP_URL,
      "https://meta.intra.42.fr/assets/clusters/k1.svg",
      "https://intra.42.fr/k2.svg",
    ]) {
      expect(isAllowedClusterSvgUrl(new URL(ok))).toBe(true);
    }
    for (const bad of [
      "http://cdn.intra.42.fr/k0.svg",
      "https://evil.example/x.svg",
      "https://cdn.intra.42.fr.evil.example/x.svg",
      "https://evilintra.42.fr/x.svg",
      "https://cdn.intra.42.fr@evil.example/x.svg",
      "https://user:pw@cdn.intra.42.fr/x.svg",
      "https://cdn.intra.42.fr:8443/x.svg",
      "https://evil.example/?h=.intra.42.fr",
      "file:///etc/passwd",
    ]) {
      expect(isAllowedClusterSvgUrl(new URL(bad))).toBe(false);
    }
  });
});

describe("handleClusterSvg", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(SVG, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves an Intra cluster map with headers that keep it inert", async () => {
    const res = await call(MAP_URL, "https://meta.intra.42.fr");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SVG);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://meta.intra.42.fr",
    );
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(MAP_URL);
  });

  it("never fetches a host outside intra.42.fr", async () => {
    for (const bad of [
      "https://evil.example/x.svg",
      "http://cdn.intra.42.fr/k0.svg",
      "https://cdn.intra.42.fr.evil.example/x.svg",
    ]) {
      expect((await call(bad)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 400 (not a crash) for a missing or malformed url", async () => {
    expect((await call(null)).status).toBe(400);
    const res = await call("notaurl");
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect off Intra", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/x.svg" },
        }),
    );
    expect((await call(MAP_URL)).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that stays on Intra", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 301,
          headers: { Location: "/cluster/image/104/k0-v2.svg" },
        }),
    );
    const res = await call(MAP_URL);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://cdn.intra.42.fr/cluster/image/104/k0-v2.svg",
    );
    expect(
      fetchMock.mock.calls.every(
        (c) => (c[1] as RequestInit)?.redirect === "manual",
      ),
    ).toBe(true);
  });

  it("refuses to re-serve something that is not an SVG", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response("<!doctype html><script>alert(1)</script>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(
      (await call("https://signin.intra.42.fr/users/sign_in")).status,
    ).toBe(502);
  });

  it("recognises an SVG served with a generic content type", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(SVG, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    );
    expect((await call(MAP_URL)).status).toBe(200);
  });

  it("refuses an oversized body", async () => {
    const big = `<svg>${"x".repeat(5 * 1024 * 1024)}</svg>`;
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(big, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    );
    expect((await call(MAP_URL)).status).toBe(502);
  });

  it("reports an upstream error as 502", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response("nope", { status: 404 }),
    );
    expect((await call(MAP_URL)).status).toBe(502);
  });
});
