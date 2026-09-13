import { corsHeaders, textRes } from "../utils";

const SOURCES = [
  "https://raw.githubusercontent.com/MaiToxx/BetterIntraRemake/main",
  "https://cdn.jsdelivr.net/gh/MaiToxx/BetterIntraRemake@main",
];

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function guessContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

export function isBadPath(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes("..");
}

export async function handleGhProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/gh\//, "");
  if (!path) return textRes("Missing path", 400);
  if (isBadPath(path)) return textRes("Bad path", 400);

  let lastStatus = 502;
  for (const base of SOURCES) {
    const res = await fetch(`${base}/${path}`);
    if (res.ok) {
      return new Response(await res.text(), {
        status: res.status,
        headers: {
          ...corsHeaders,
          "Content-Type":
            res.headers.get("content-type") || guessContentType(path),
          "Cache-Control":
            res.status >= 400 ? "public, max-age=300" : "public, max-age=3600",
        },
      });
    }
    lastStatus = res.status;
  }

  return new Response("Failed to fetch upstream", {
    status: lastStatus,
    headers: corsHeaders,
  });
}
