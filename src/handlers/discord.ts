import { Env, UserData } from "../types";
import {
  getBearerToken,
  getUserToken,
  hashLogin,
  jsonRes,
  markTokenBroken,
  textRes,
  validateSession,
} from "../utils";

export async function handleDiscordLink(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }
  const discordId = String(body?.discordId || "").trim();
  if (!discordId) return textRes("Missing discordId", 400);

  existingData.discordId = discordId;
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  return jsonRes({ linked: true });
}

export async function handleDiscordUnlink(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  delete existingData.discordId;
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  return jsonRes({ unlinked: true });
}

export async function handleDiscordQuiet(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }

  existingData.discordQuietEnabled = body?.quietEnabled === true;
  existingData.discordQuietStart = String(body?.quietStart || "22:00");
  existingData.discordQuietEnd = String(body?.quietEnd || "08:00");
  existingData.discordQuietTimezone = Number(body?.timezoneOffset) || 0;
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  return jsonRes({ saved: true });
}

export async function handleDiscordTest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return textRes("Invalid JSON body", 400);
  }
  const rawLogin = String(body?.login || "").trim();
  if (!rawLogin) return textRes("Missing login", 400);

  const loginParam = await hashLogin(rawLogin);
  const existingData = await env.BETTER_INTRA_KV.get<UserData>(loginParam, {
    type: "json",
  });
  if (!existingData) return textRes("User not found", 404);
  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  if (!env.DISCORD_BOT_TOKEN) {
    return textRes(
      "Discord bot not configured on the server. Contact admin.",
      500,
    );
  }

  const country: string | null = (request.cf?.country as string | undefined) || null;
  const token42 = await getUserToken(env, existingData, loginParam, country);
  try {
    const meRes = await fetch("https://api.intra.42.fr/v2/me", {
      headers: { Authorization: `Bearer ${token42}` },
    });
    if (!meRes.ok) {
      if (meRes.status === 401) {
        await markTokenBroken(env, existingData, loginParam);
        return textRes("42 token expired — marked as broken, please reconnect in Account tab", 401);
      }
      return textRes(`42 API unreachable (${meRes.status})`, 502);
    }
  } catch {
    return textRes("42 API unreachable — network error", 502);
  }

  const discordId =
    existingData.discordId || String(body?.discordId || "").trim();
  if (!discordId) {
    return textRes("No Discord linked. Set your Discord User ID first.", 400);
  }

  const testBeginAt = new Date(Date.now() + 15 * 60000).toISOString();
  const unix = Math.floor(new Date(testBeginAt).getTime() / 1000);
  const timeStr = `<t:${unix}:t>`;

  const embeds: DiscordEmbed[] = [
    {
      title: "Evaluation Booked",
      color: 0x5865f2,
      fields: [
        { name: "Project", value: "Unknown", inline: true },
        { name: "Time", value: timeStr, inline: true },
      ],
      timestamp: testBeginAt,
    },
    {
      title: "Evaluation in 15 min",
      color: 0x57f287,
      fields: [
        {
          name: "Project",
          value:
            "[ft_transcendence](https://projects.intra.42.fr/projects/ft_transcendence)",
          inline: true,
        },
        { name: "Time", value: timeStr, inline: true },
        {
          name: "Correcting",
          value:
            "[elmo](https://profile-v3.intra.42.fr/users/elmo), [kermit](https://profile-v3.intra.42.fr/users/kermit)",
        },
      ],
      timestamp: testBeginAt,
    },
  ];

  const result = await sendDiscordDm(discordId, embeds, env);
  if (!result.ok) {
    return textRes(`Discord API error (${result.status}): ${result.body}`, 502);
  }

  existingData.discordTestedAt = Date.now();
  await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(existingData));

  return jsonRes({ sent: true });
}

export async function sendDiscordDm(
  discordId: string,
  embeds: DiscordEmbed[],
  env: Env,
): Promise<{ ok: boolean; status?: number; body?: string }> {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, body: "DISCORD_BOT_TOKEN not set" };

  const shortId = discordId.slice(0, 6);
  console.log(
    `[discord] sending DM discord=${shortId}... embeds=${embeds.map((e) => e.title).join(",")}`,
  );

  let channelRes: Response;
  try {
    channelRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });
  } catch {
    console.warn(`[discord] DM channel failed discord=${shortId}... network`);
    return { ok: false, body: "Network error creating DM channel" };
  }

  if (!channelRes.ok) {
    const err = await channelRes.text().catch(() => "Unknown");
    console.warn(
      `[discord] DM channel failed discord=${shortId}... status=${channelRes.status}`,
    );
    return { ok: false, status: channelRes.status, body: err };
  }

  let channel: any;
  try {
    channel = await channelRes.json();
  } catch {
    console.warn(`[discord] DM channel parse failed discord=${shortId}...`);
    return { ok: false, body: "Invalid channel response" };
  }
  const channelId = channel.id;
  if (!channelId) {
    console.warn(`[discord] DM no channel id discord=${shortId}...`);
    return { ok: false, body: "No channel id in response" };
  }

  let msgRes: Response;
  try {
    msgRes = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ embeds }),
      },
    );
  } catch {
    console.warn(`[discord] DM send failed discord=${shortId}... network`);
    return { ok: false, body: "Network error sending message" };
  }

  if (!msgRes.ok) {
    const err = await msgRes.text().catch(() => "Unknown");
    console.warn(
      `[discord] DM send failed discord=${shortId}... status=${msgRes.status}`,
    );
    return { ok: false, status: msgRes.status, body: err };
  }

  console.log(`[discord] DM sent ok discord=${shortId}...`);
  return { ok: true };
}

export interface DiscordEmbed {
  title: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

export async function handleDiscordAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const token = url.searchParams.get("token") || "";
  const login = url.searchParams.get("login") || "";
  if (!redirectUri || !token || !login) {
    return textRes("Missing redirect_uri, token, or login", 400);
  }

  const hashedLogin = await hashLogin(login);
  const userData = await env.BETTER_INTRA_KV.get<UserData>(hashedLogin, {
    type: "json",
  });
  if (!userData || !validateSession(userData, token)) {
    return textRes("Unauthorized", 401);
  }

  const nonce = crypto.randomUUID();
  await env.BETTER_INTRA_KV.put(
    `discord_oauth_${nonce}`,
    JSON.stringify({ hashedLogin, redirectUri }),
    { expirationTtl: 300 },
  );

  const callbackUrl = new URL(request.url).origin + "/discord/callback";

  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", env.DISCORD_CLIENT_ID || "");
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "identify guilds.join");
  authUrl.searchParams.set("state", nonce);
  return Response.redirect(authUrl.toString(), 302);
}

export async function handleDiscordCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const nonce = url.searchParams.get("state");
  if (!code || !nonce) return textRes("Missing code or state", 400);

  const stored = await env.BETTER_INTRA_KV.get(`discord_oauth_${nonce}`);
  // Unauthenticated route: a made-up state must not spend a KV delete (the
  // daily write/delete budget is shared by the whole namespace).
  if (!stored) return textRes("Session expired", 400);
  await env.BETTER_INTRA_KV.delete(`discord_oauth_${nonce}`);

  const { hashedLogin, redirectUri } = JSON.parse(stored) as {
    hashedLogin: string;
    redirectUri: string;
  };

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL(request.url).origin + "/discord/callback",
      client_id: env.DISCORD_CLIENT_ID || "",
      client_secret: env.DISCORD_CLIENT_SECRET || "",
    }),
  });
  if (!tokenRes.ok) {
    return textRes("Failed to exchange Discord code", 500);
  }

  const tokens = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokens.access_token;
  if (!accessToken) return textRes("No access token in Discord response", 500);

  const userRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    return textRes("Failed to fetch Discord user", 500);
  }

  const discordUser = (await userRes.json()) as {
    id: string;
    username: string;
  };
  const discordId = discordUser.id;
  const discordUsername = discordUser.username || "";

  if (env.DISCORD_GUILD_ID) {
    await fetch(
      `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: accessToken }),
      },
    );
  }

  await fetch("https://discord.com/api/oauth2/token/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: accessToken,
      client_id: env.DISCORD_CLIENT_ID || "",
      client_secret: env.DISCORD_CLIENT_SECRET || "",
    }),
  });

  const userData = await env.BETTER_INTRA_KV.get<UserData>(hashedLogin, {
    type: "json",
  });
  if (userData) {
    userData.discordId = discordId;
    userData.discordUsername = discordUsername;
    await env.BETTER_INTRA_KV.put(hashedLogin, JSON.stringify(userData));
  }

  const finalUrl = new URL(redirectUri);
  finalUrl.searchParams.set("discord_id", discordId);
  finalUrl.searchParams.set("discord_username", discordUsername);
  return Response.redirect(finalUrl.toString(), 302);
}
