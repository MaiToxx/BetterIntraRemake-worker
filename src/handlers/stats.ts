import { Env } from "../types";
import { jsonRes, textRes } from "../utils";

async function countSince(env: Env, cutoff: number): Promise<number> {
  const row = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users WHERE created_at > ?")
    .bind(cutoff)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

function countNew(env: Env, days: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  return countSince(env, cutoff);
}

function countNewToday(env: Env): Promise<number> {
  const todayStart = Math.floor(Date.now() / 1000) % 86_400;
  return countSince(env, Math.floor(Date.now() / 1000) - todayStart);
}

export async function handleStats(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const total = await env.better_intra_d1
    .prepare("SELECT COUNT(*) AS c FROM users")
    .first<{ c: number }>();

  const [newToday, newLast30Days, newLast14Days, newLast7Days] =
  await Promise.all([
    countNewToday(env),
    countNew(env, 30),
    countNew(env, 14),
    countNew(env, 7),
  ]);

  return jsonRes({
    total: total?.c ?? 0,
    newToday,
    newLast30Days,
    newLast14Days,
    newLast7Days,
    // No country is stored any more (see handleIntraAuth). The field stays,
    // empty: extension builds up to 1.13.x read `countries.length` with no
    // guard, and a missing field would leave their About tab on a spinner.
    countries: [],
  });
}
