#!/usr/bin/env node
/**
 * One-off: removes the metadata (GPS, date, device, XMP...) from profile
 * images stored before the worker did it on upload (src/image-strip.ts).
 * The operator runs it by hand, once, after deploying that worker; it is
 * never part of a deploy.
 *
 *   node scripts/strip-image-metadata.mjs --remote           dry run: lists what would change
 *   node scripts/strip-image-metadata.mjs --remote --apply   rewrites those images
 *   (--local [--persist-to <dir>] works on a local wrangler KV instead)
 *
 * Each rewritten image is one KV write out of the namespace's 1,000 a day;
 * an image that is already clean costs none, so a second run writes nothing.
 * The stored metadata {type, v} is written back unchanged, so every URL
 * already published keeps its version and keeps serving. An image that does
 * not parse is left as it is and listed, never deleted.
 *
 * Needs Node 22.18+ (loads the worker's TypeScript module directly) and a
 * logged-in wrangler (`npx wrangler login`) for --remote.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sniffImageType, stripImageMetadata } from "../src/image-strip.ts";

export const IMAGE_PREFIX = "img:";

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Strips every `img:` value of `kv` ({list(prefix), get(key), put(key,
 * bytes, metadata)}), writing only when `apply` is set and something was
 * removed. Returns the keys by outcome.
 */
export async function restripImages(kv, { apply = false, log = () => {} } = {}) {
  const result = { cleaned: [], alreadyClean: [], skipped: [] };
  for (const { name, metadata } of await kv.list(IMAGE_PREFIX)) {
    const bytes = await kv.get(name);
    const type = bytes ? sniffImageType(bytes) : null;
    if (!bytes || !type || metadata?.type !== type) {
      // Without the stored {type, v} the rewritten image would stop serving.
      result.skipped.push(name);
      log(`${name}: skipped (no value, unknown bytes or metadata ${JSON.stringify(metadata)})`);
      continue;
    }
    const clean = stripImageMetadata(bytes, type);
    if (!clean) {
      result.skipped.push(name);
      log(`${name}: skipped (does not parse as ${type}), left as it is`);
      continue;
    }
    if (sameBytes(clean, bytes)) {
      result.alreadyClean.push(name);
      continue;
    }
    if (apply) await kv.put(name, clean, metadata);
    result.cleaned.push(name);
    log(`${name}: ${bytes.length} -> ${clean.length} bytes${apply ? "" : " (dry run, not written)"}`);
  }
  return result;
}

/** The KV namespace through the wrangler CLI (no shell: arguments go as is). */
function wranglerKv(target, cwd) {
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
  const run = (args) => {
    const r = spawnSync(process.execPath, [bin, ...args, "--binding", "BETTER_INTRA_KV", ...target], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${r.stderr.toString()}`);
    }
    return r.stdout;
  };
  const scratch = mkdtempSync(join(tmpdir(), "strip-images-"));
  return {
    list: async (prefix) => JSON.parse(run(["kv", "key", "list", "--prefix", prefix]).toString("utf8")),
    get: async (key) => new Uint8Array(run(["kv", "key", "get", key])),
    put: async (key, bytes, metadata) => {
      const file = join(scratch, "value");
      writeFileSync(file, bytes);
      run(["kv", "key", "put", key, "--path", file, "--metadata", JSON.stringify(metadata)]);
    },
    close: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const persist = argv.indexOf("--persist-to");
  const target = argv.includes("--remote")
    ? ["--remote"]
    : argv.includes("--local")
      ? ["--local", ...(persist >= 0 ? ["--persist-to", argv[persist + 1]] : [])]
      : null;
  if (!target) {
    console.error("usage: node scripts/strip-image-metadata.mjs (--remote | --local [--persist-to <dir>]) [--apply]");
    process.exit(2);
  }
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const kv = wranglerKv(target, cwd);
  try {
    const result = await restripImages(kv, { apply, log: (line) => console.log(line) });
    console.log(
      `${result.cleaned.length} ${apply ? "cleaned" : "to clean"}, ` +
        `${result.alreadyClean.length} already clean, ${result.skipped.length} skipped` +
        (apply || result.cleaned.length === 0 ? "" : ". Run again with --apply to write them."),
    );
  } finally {
    kv.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
