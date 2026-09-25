import { describe, it, expect } from "vitest";

// Loaded without an import so the worker's tsconfig (no Node types) is happy.
const nodeProcess = (globalThis as any).process;
const { readFileSync, readdirSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
};

const SRC = new URL("../src/", (import.meta as { url?: string }).url);

/** Source without comments, so a fetch() named in prose is not a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The argument list of the call whose "(" is at `open`. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error("unbalanced call");
}

/**
 * A fetch() without a deadline holds the request as long as the host
 * stalls: the GitHub proxy never reached its second source, and a hung key
 * server ran the sign-in into the extension's own timeout. Every outbound
 * call passes a signal (see FETCH_DEADLINES in src/utils.ts); the behaviour
 * of each is tested in its handler's file.
 */
describe("outbound fetches", () => {
  it("every fetch() call in src/ passes a signal", () => {
    const files = readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith(".ts"));
    const calls: string[] = [];
    for (const file of files) {
      const text = code(readFileSync(new URL(file.replace(/\\/g, "/"), SRC), "utf8"));
      for (const m of text.matchAll(/(^|[^.\w])fetch\(/g)) {
        const at = m.index! + m[0].length - 1;
        // the worker's own handler, `async fetch(request, env)`, is not a call
        if (/async\s+$/.test(text.slice(Math.max(0, at - 12), at - "fetch".length))) continue;
        const args = argumentsAt(text, at);
        calls.push(`${file}: fetch(${args.split("\n")[0]}`);
        expect({ file, args, signal: /\bsignal\b/.test(args) }).toMatchObject({ signal: true });
      }
    }
    // gh-proxy, the JWKS, and fetchAllowed (cluster maps, subject PDFs)
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
