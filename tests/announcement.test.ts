import { describe, it, expect } from "vitest";
import {
  handleAnnouncement,
  MAX_ANNOUNCEMENT_BODY_BYTES,
} from "../src/handlers/announcement";
import { FakeKV, makeEnv } from "./helpers/fake-env";

const SECRET = "announce-secret-123";
const URL = "https://w.test/api/v1/public/announcement";

function setup(
  withBanner = true,
  vars: { ANNOUNCEMENT_SECRET?: string } = { ANNOUNCEMENT_SECRET: SECRET },
) {
  const seed = withBanner
    ? {
        ANNOUNCEMENT: {
          message: "Maintenance tonight",
          updatedAt: 1,
          level: "warning",
          links: [],
        },
      }
    : {};
  return makeEnv({ kv: new FakeKV(seed), vars });
}

const post = (body: unknown) =>
  new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("announcement", () => {
  it("serves the banner to everyone", async () => {
    const { env } = setup();
    const res = await handleAnnouncement(new Request(URL), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      message: "Maintenance tonight",
      updatedAt: 1,
      level: "warning",
      links: [],
    });
  });

  it("sets a banner with the secret in the body, normalising level and links", async () => {
    const { env, kv } = setup(false);
    const res = await handleAnnouncement(
      post({
        secret: SECRET,
        message: "  Hello  ",
        level: "loud",
        links: [
          { text: "Docs", url: "https://docs.test" },
          { text: "bad", url: "javascript:1" },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(kv.json("ANNOUNCEMENT")).toMatchObject({
      message: "Hello",
      level: "critical",
      links: [{ text: "Docs", url: "https://docs.test" }],
    });
  });

  it("clears the banner with an empty message", async () => {
    const { env, kv } = setup();
    const res = await handleAnnouncement(post({ secret: SECRET, message: "" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: null });
    expect(kv.deletes).toEqual(["ANNOUNCEMENT"]);
  });

  it("refuses a wrong or missing secret, and everything when none is configured", async () => {
    const { env, kv } = setup();
    expect((await handleAnnouncement(post({ secret: "nope", message: "x" }), env)).status).toBe(403);
    expect((await handleAnnouncement(post({ message: "x" }), env)).status).toBe(403);
    const unset = setup(true, {});
    expect((await handleAnnouncement(post({ secret: "", message: "" }), unset.env)).status).toBe(403);
    expect((await handleAnnouncement(post({ message: "" }), unset.env)).status).toBe(403);
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(unset.kv.deletes).toEqual([]);
  });

  it("no longer takes the secret from the query string: DELETE is not a method here", async () => {
    const { env, kv } = setup();
    const res = await handleAnnouncement(
      new Request(`${URL}?secret=${SECRET}`, { method: "DELETE" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(kv.deletes).toEqual([]);
    expect(kv.json("ANNOUNCEMENT").message).toBe("Maintenance tonight");
  });
});

describe("announcement POST body cap", () => {
  it("refuses a body past the cap with 413, before the secret check and any write", async () => {
    const { env, kv } = setup();
    const huge = "x".repeat(MAX_ANNOUNCEMENT_BODY_BYTES);
    for (const secret of [SECRET, "wrong"]) {
      const res = await handleAnnouncement(post({ secret, message: "", padding: huge }), env);
      expect(res.status).toBe(413);
    }
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(kv.json("ANNOUNCEMENT").message).toBe("Maintenance tonight");
  });

  it("still takes the largest real announcement", async () => {
    const { env, kv } = setup(false);
    const links = Array.from({ length: 5 }, (_, i) => ({
      text: `Link ${i} `.padEnd(100, "t"),
      url: `https://docs.test/${"p".repeat(1000)}${i}`,
    }));
    const message = "é".repeat(500);
    const res = await handleAnnouncement(
      post({ secret: SECRET, message, level: "info", links }),
      env,
    );
    expect(res.status).toBe(200);
    expect(kv.json("ANNOUNCEMENT")).toMatchObject({ message, links });
  });

  it("answers 400 for a body that is not JSON and 403 for one that is not an object", async () => {
    const { env, kv } = setup();
    const raw = (body: string) => new Request(URL, { method: "POST", body });
    expect((await handleAnnouncement(raw("{"), env)).status).toBe(400);
    expect((await handleAnnouncement(raw("null"), env)).status).toBe(403);
    expect(kv.puts).toEqual([]);
  });
});
