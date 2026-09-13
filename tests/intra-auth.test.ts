import { describe, it, expect, beforeAll } from "vitest";
import { INTRA_ISSUER, verifyIntraJwt, type Jwk } from "../src/handlers/intra-auth";

// Node 20+ exposes WebCrypto globally, like the Workers runtime does.
const subtle = globalThis.crypto.subtle;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let jwks: Jwk[];
let otherJwks: Jwk[];

async function makeKey(kid: string) {
  const pair = await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pub = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: pub.n!, e: pub.e! } as Jwk };
}

async function sign(payload: Record<string, unknown>, key: CryptoKey, kid = "k1", alg = "RS256") {
  const header = b64url(JSON.stringify({ alg, typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = 1_800_000_000_000; // fixed "now" in ms
const validPayload = () => ({
  iss: INTRA_ISSUER,
  sub: "abc-123",
  preferred_username: "alepayen",
  exp: Math.floor(now / 1000) + 300,
});

beforeAll(async () => {
  const k = await makeKey("k1");
  privateKey = k.priv;
  // key set also contains an encryption key like Keycloak's real JWKS
  jwks = [{ kid: "enc", kty: "RSA", alg: "RSA-OAEP", use: "enc", n: k.jwk.n, e: k.jwk.e }, k.jwk];
  otherJwks = [(await makeKey("k2")).jwk];
});

describe("verifyIntraJwt", () => {
  it("accepts a valid token and returns the login", async () => {
    const token = "Bearer " + (await sign(validPayload(), privateKey));
    expect(await verifyIntraJwt(token, jwks, now)).toEqual({ login: "alepayen", sub: "abc-123", exp: validPayload().exp });
  });

  it("rejects a token signed by another key", async () => {
    const token = await sign(validPayload(), privateKey);
    expect(await verifyIntraJwt(token, otherJwks, now)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await sign(validPayload(), privateKey);
    const [h, , s] = token.split(".");
    const forged = b64url(JSON.stringify({ ...validPayload(), preferred_username: "victim" }));
    expect(await verifyIntraJwt(`${h}.${forged}.${s}`, jwks, now)).toBeNull();
  });

  it("rejects expired tokens and wrong issuers", async () => {
    expect(await verifyIntraJwt(await sign({ ...validPayload(), exp: Math.floor(now / 1000) - 1 }, privateKey), jwks, now)).toBeNull();
    expect(await verifyIntraJwt(await sign({ ...validPayload(), iss: "https://evil.example/realm" }, privateKey), jwks, now)).toBeNull();
  });

  it("rejects unsupported algorithms and garbage", async () => {
    expect(await verifyIntraJwt(await sign(validPayload(), privateKey, "k1", "HS256"), jwks, now)).toBeNull();
    expect(await verifyIntraJwt("not.a.jwt", jwks, now)).toBeNull();
    expect(await verifyIntraJwt("", jwks, now)).toBeNull();
  });
});
