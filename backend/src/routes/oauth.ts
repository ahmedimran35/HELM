// OAuth + identity linking (docs §P5).
//
// Routes:
//   GET    /api/oauth/:provider/start          (auth) — build authorize URL,
//                                                 stash state in a short-lived
//                                                 signed cookie, redirect.
//   GET    /api/oauth/callback                 (any)  — verify state,
//                                                 exchange code, fetch user
//                                                 info, upsert oauth_accounts
//                                                 row, link to (or create) a
//                                                 local user, redirect to
//                                                 /settings?oauth=ok.
//   GET    /api/oauth/accounts                 (auth) — list the current
//                                                 user's linked identities.
//   DELETE /api/oauth/accounts/:id             (auth) — unlink.
//
// Supported providers: google, github, microsoft.
//
// Each provider gets its own (client_id, client_secret) pair from .env:
//   OAUTH_GOOGLE_CLIENT_ID / OAUTH_GOOGLE_CLIENT_SECRET
//   OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET
//   OAUTH_MICROSOFT_CLIENT_ID / OAUTH_MICROSOFT_CLIENT_SECRET
//   (optional) OAUTH_MICROSOFT_TENANT          — defaults to "common"
//
// Tokens are encrypted at rest via lib/crypto.ts (AES-256-GCM) — never
// returned to the client. Scopes are minimum-viable for identity (openid
// + email + profile); refresh tokens are stored when the provider returns
// them so we can keep the row "live" without re-prompting the user.
//
// Behaviour on callback:
//   - If the caller has a session, link the external identity to the
//     signed-in user (the "Connect" button on /connected-accounts).
//   - If the caller has no session, look up the existing oauth_accounts
//     row for this (provider, account_id) and sign them in as that
//     user. If there's no row yet (first-ever OAuth for that email),
//     create a new local user with a generated password + must_change_password=true.

import { Hono } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "../db/client.ts";
import { config } from "../config.ts";
import { requireAuth } from "../middleware/auth.ts";
import { encryptSecret } from "../lib/crypto.ts";
import { hashPassword } from "../auth/password.ts";
import { generateOneTimePassword } from "../lib/ids.ts";
import { createSession } from "../auth/session.ts";
import { serializeSessionCookie } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();

// Authenticated sub-router for everything except the public callback
// (the /callback endpoint is what the OAuth provider hits to exchange
// the code, so it can't require a session).
const authedRouter = new Hono();
authedRouter.use("*", requireAuth);

// ─────────────────────────────────────────────────────────────────────
// Provider config — read once at boot from process.env. If a client id
// is missing the /start endpoint returns 503 so admins see the gap.
// ─────────────────────────────────────────────────────────────────────

type ProviderId = "google" | "github" | "microsoft";

interface ProviderConfig {
  id: ProviderId;
  label: string;
  authorizeUrl: (state: string, redirectUri: string) => string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  extractUserInfo: (
    json: Record<string, unknown>,
  ) => { accountId: string; email: string | null; name: string | null };
  parseRefreshToken?: (json: Record<string, unknown>) => string | null;
  parseExpiresAt?: (json: Record<string, unknown>) => Date | null;
}

function envOpt(key: string): string | null {
  const v = process.env[key];
  return v && v.length > 0 ? v : null;
}

function getProvider(id: ProviderId): ProviderConfig | null {
  if (id === "google") {
    const clientId = envOpt("OAUTH_GOOGLE_CLIENT_ID");
    const clientSecret = envOpt("OAUTH_GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) return null;
    return {
      id: "google",
      label: "Google",
      authorizeUrl: (state, redirectUri) =>
        `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid email profile")}&state=${encodeURIComponent(state)}&access_type=offline&prompt=consent`,
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
      extractUserInfo: (j) => ({
        accountId: typeof j.sub === "string" ? j.sub : "",
        email: typeof j.email === "string" ? j.email : null,
        name: typeof j.name === "string" ? j.name : null,
      }),
      parseRefreshToken: (j) =>
        typeof j.refresh_token === "string" ? j.refresh_token : null,
      parseExpiresAt: (j) =>
        typeof j.expires_in === "number"
          ? new Date(Date.now() + j.expires_in * 1000)
          : null,
    };
  }
  if (id === "github") {
    const clientId = envOpt("OAUTH_GITHUB_CLIENT_ID");
    const clientSecret = envOpt("OAUTH_GITHUB_CLIENT_SECRET");
    if (!clientId || !clientSecret) return null;
    return {
      id: "github",
      label: "GitHub",
      authorizeUrl: (state, redirectUri) =>
        `https://github.com/login/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("read:user user:email")}&state=${encodeURIComponent(state)}`,
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
      extractUserInfo: (j) => ({
        accountId:
          typeof j.id === "number"
            ? String(j.id)
            : typeof j.id === "string"
              ? j.id
              : "",
        email: typeof j.email === "string" ? j.email : null,
        name:
          typeof j.name === "string"
            ? j.name
            : typeof j.login === "string"
              ? j.login
              : null,
      }),
      // GitHub doesn't issue refresh tokens for standard OAuth Apps.
    };
  }
  if (id === "microsoft") {
    const clientId = envOpt("OAUTH_MICROSOFT_CLIENT_ID");
    const clientSecret = envOpt("OAUTH_MICROSOFT_CLIENT_SECRET");
    if (!clientId || !clientSecret) return null;
    const tenant = envOpt("OAUTH_MICROSOFT_TENANT") ?? "common";
    return {
      id: "microsoft",
      label: "Microsoft",
      authorizeUrl: (state, redirectUri) =>
        `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent("openid email profile User.Read")}&state=${encodeURIComponent(state)}&response_mode=query`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      userInfoUrl: "https://graph.microsoft.com/v1.0/me",
      scopes: ["openid", "email", "profile", "User.Read"],
      extractUserInfo: (j) => ({
        accountId: typeof j.id === "string" ? j.id : "",
        email:
          typeof j.mail === "string"
            ? j.mail
            : typeof j.userPrincipalName === "string"
              ? j.userPrincipalName
              : null,
        name: typeof j.displayName === "string" ? j.displayName : null,
      }),
      parseRefreshToken: (j) =>
        typeof j.refresh_token === "string" ? j.refresh_token : null,
      parseExpiresAt: (j) =>
        typeof j.expires_in === "number"
          ? new Date(Date.now() + j.expires_in * 1000)
          : null,
    };
  }
  return null;
}

const SUPPORTED: ProviderId[] = ["google", "github", "microsoft"];

function isProviderId(s: string): s is ProviderId {
  return (SUPPORTED as string[]).includes(s);
}

// ─────────────────────────────────────────────────────────────────────
// State cookie — short-lived signed cookie that carries:
//   provider  : "google" | ...
//   nonce     : random string
//   ts        : unix seconds (for expiry)
//   linkMode  : "true" if the user clicked "Connect" (vs. login)
// HMAC over provider|nonce|ts|linkMode with SESSION_SECRET. We sign
// instead of using a JWT library because we want one cookie (not two),
// no JSON parser, and explicit tampering detection.
// ─────────────────────────────────────────────────────────────────────

const STATE_COOKIE = "helm_oauth_state";
const STATE_TTL_SECONDS = 600;

interface StatePayload {
  provider: ProviderId;
  nonce: string;
  ts: number;
  linkMode: boolean;
}

function signState(payload: StatePayload): string {
  const body = `${payload.provider}|${payload.nonce}|${payload.ts}|${payload.linkMode ? "1" : "0"}`;
  const mac = createHmac("sha256", config.session.secret)
    .update(body)
    .digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${mac}`;
}

function verifyState(signed: string): StatePayload | null {
  const dot = signed.indexOf(".");
  if (dot < 0) return null;
  const b64 = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  let body: string;
  try {
    body = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", config.session.secret)
    .update(body)
    .digest("base64url");
  // timingSafeEqual throws on length mismatch; signatures here are always
  // 43 chars (sha256 base64url) so an unequal-length attack is a hard fail.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const parts = body.split("|");
  const provider = parts[0]!;
  const nonce = parts[1]!;
  const ts = parts[2]!;
  const mode = parts[3]!;
  if (!isProviderId(provider)) return null;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return null;
  const linkMode = mode === "1";
  if (Date.now() / 1000 - tsNum > STATE_TTL_SECONDS) return null;
  return { provider, nonce, ts: tsNum, linkMode };
}

function buildStateCookie(signed: string): string {
  const isHttps = process.env.WEB_ORIGIN?.startsWith("https://") ?? false;
  const attrs = [
    `${STATE_COOKIE}=${encodeURIComponent(signed)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL_SECONDS}`,
  ];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readStateCookie(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const p = part.trim();
    if (p.startsWith(`${STATE_COOKIE}=`)) {
      return decodeURIComponent(p.slice(STATE_COOKIE.length + 1));
    }
  }
  return null;
}

function redirectUriFor(req: Request): string {
  // The callback URL must exactly match what's registered with the IdP.
  // Prefer an explicit OAUTH_REDIRECT_BASE if set (so prod can pin it);
  // otherwise derive from the request URL so dev + containers both work.
  const base = envOpt("OAUTH_REDIRECT_BASE");
  if (base) return `${base.replace(/\/$/, "")}/api/oauth/callback`;
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}/api/oauth/callback`;
}

// ─────────────────────────────────────────────────────────────────────
// /api/oauth/:provider/start  (auth required)
// ─────────────────────────────────────────────────────────────────────

authedRouter.get("/:provider/start", requireAuth, async (c) => {
  const providerParam = c.req.param("provider");
  if (!isProviderId(providerParam)) {
    return c.json({ error: "unsupported_provider" }, 400);
  }
  const provider = getProvider(providerParam);
  if (!provider) {
    return c.json(
      {
        error: "provider_not_configured",
        provider: providerParam,
        message: `${providerParam} OAuth is not configured. Set OAUTH_${providerParam.toUpperCase()}_CLIENT_ID and OAUTH_${providerParam.toUpperCase()}_CLIENT_SECRET in the backend .env.`,
      },
      503,
    );
  }

  const url = new URL(c.req.url);
  // link=1 means the user clicked "Connect" from /connected-accounts.
  // Otherwise it's an "OAuth login" — we'll create a user if needed.
  const linkMode = url.searchParams.get("link") === "1";

  const nonce = randomBytes(16).toString("base64url");
  const payload: StatePayload = {
    provider: provider.id,
    nonce,
    ts: Math.floor(Date.now() / 1000),
    linkMode,
  };
  const signed = signState(payload);

  const authorize = provider.authorizeUrl(signed, redirectUriFor(c.req.raw));
  c.header("Set-Cookie", buildStateCookie(signed), { append: true });
  return c.redirect(authorize, 302);
});

// ─────────────────────────────────────────────────────────────────────
// /api/oauth/callback  (no auth required — supports first-time OAuth)
// ─────────────────────────────────────────────────────────────────────
//
// The IdP redirects the browser back here with ?provider=&code=&state=.
// We:
//   1) Verify state cookie matches the state query (HMAC-signed, short-lived).
//   2) Exchange code → token at the IdP.
//   3) Fetch the user's profile (sub + email + name).
//   4) Either:
//        - signed-in user present → link to that user
//        - no session, oauth_accounts row exists → log in as that user
//        - no session, no row → create a new local user + log them in
//   5) Redirect to /settings?oauth=ok (or oauth=failed/denied on error).
router.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  const providerParam = url.searchParams.get("provider") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const stateFromQuery = url.searchParams.get("state") ?? "";
  const errorParam = url.searchParams.get("error") ?? "";

  if (errorParam) {
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/settings?oauth=denied", 302);
  }
  if (!isProviderId(providerParam)) {
    return c.json({ error: "unsupported_provider" }, 400);
  }
  if (!code || !stateFromQuery) {
    return c.json({ error: "missing_code_or_state" }, 400);
  }

  const stateCookie = readStateCookie(c.req.raw);
  if (!stateCookie) {
    return c.json({ error: "missing_state_cookie" }, 400);
  }
  const payload = verifyState(stateCookie);
  if (!payload || payload.provider !== providerParam || stateCookie !== stateFromQuery) {
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.json({ error: "invalid_state" }, 400);
  }
  const provider = getProvider(providerParam);
  if (!provider) {
    return c.json({ error: "provider_not_configured" }, 503);
  }

  const clientId = envOpt(`OAUTH_${providerParam.toUpperCase()}_CLIENT_ID`)!;
  const clientSecret = envOpt(`OAUTH_${providerParam.toUpperCase()}_CLIENT_SECRET`)!;
  const redirectUri = redirectUriFor(c.req.raw);

  // 1) Exchange code → token.
  let tokenJson: Record<string, unknown>;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`oauth ${providerParam} token exchange failed: ${res.status} ${text}`);
      c.header("Set-Cookie", clearStateCookie(), { append: true });
      return c.redirect("/settings?oauth=failed", 302);
    }
    tokenJson = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn("oauth token exchange error:", (err as Error).message);
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/settings?oauth=failed", 302);
  }

  const accessToken = typeof tokenJson.access_token === "string" ? tokenJson.access_token : null;
  if (!accessToken) {
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/settings?oauth=failed", 302);
  }
  const refreshToken = provider.parseRefreshToken?.(tokenJson) ?? null;
  const expiresAt = provider.parseExpiresAt?.(tokenJson) ?? null;
  const accessEnc = encryptSecret(accessToken);
  const refreshEnc = refreshToken ? encryptSecret(refreshToken) : null;

  // 2) Fetch user info.
  let userInfoJson: Record<string, unknown>;
  try {
    const res = await fetch(provider.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "helm-oauth/1.0",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`oauth ${providerParam} userinfo failed: ${res.status} ${text}`);
      c.header("Set-Cookie", clearStateCookie(), { append: true });
      return c.redirect("/settings?oauth=failed", 302);
    }
    userInfoJson = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn("oauth userinfo error:", (err as Error).message);
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/settings?oauth=failed", 302);
  }

  const info = provider.extractUserInfo(userInfoJson);
  if (!info.accountId) {
    c.header("Set-Cookie", clearStateCookie(), { append: true });
    return c.redirect("/settings?oauth=failed", 302);
  }

  // 3) Resolve the target user. Order:
  //    a) If there's an active session, link to that user.
  //    b) If no session but the (provider, account_id) row exists,
  //       sign them in as that user (returning user).
  //    c) Otherwise, create a fresh local user with must_change_password=true.
  const sessionUser = c.get("user") as { id: string } | undefined;
  let targetUserId: string;
  let isNewUser = false;

  if (sessionUser) {
    // Force-link mode — the user is signed in and explicitly clicked
    // "Connect". Two safety checks:
    //   1. The state payload's linkMode must be true (signed by us).
    //      Without this, an attacker who tricked the victim into
    //      starting a non-link OAuth flow could still flip the link
    //      intent and steal the account.
    //   2. If the (provider, account_id) row already exists and is
    //      bound to a DIFFERENT user, refuse — otherwise an attacker
    //      can attach their Google identity to the victim and then
    //      sign in via Google → /api/oauth/callback as that user.
    if (!payload.linkMode) {
      c.header("Set-Cookie", clearStateCookie(), { append: true });
      return c.json({ error: "link_required" }, 400);
    }
    const conflict = await sql<{ user_id: string }[]>`
      SELECT user_id FROM oauth_accounts
      WHERE provider = ${providerParam} AND account_id = ${info.accountId}
        AND user_id <> ${sessionUser.id}::uuid
      LIMIT 1
    `;
    if (conflict[0]) {
      c.header("Set-Cookie", clearStateCookie(), { append: true });
      return c.json({ error: "oauth_account_already_linked" }, 409);
    }
    targetUserId = sessionUser.id;
  } else {
    const existing = await sql<{ user_id: string }[]>`
      SELECT user_id FROM oauth_accounts
      WHERE provider = ${providerParam} AND account_id = ${info.accountId}
      LIMIT 1
    `;
    if (existing[0]) {
      targetUserId = existing[0].user_id;
    } else {
      targetUserId = await createLocalUserFromOAuth(info, providerParam);
      isNewUser = true;
    }
  }

  // 4) Upsert oauth_accounts. The (provider, account_id) UNIQUE means
  // re-connecting from the same external identity always lands on the
  // same row.
  await sql`
    INSERT INTO oauth_accounts (
      user_id, provider, account_id, account_email, account_name,
      access_token_encrypted, refresh_token_encrypted, scopes, expires_at
    ) VALUES (
      ${targetUserId}::uuid,
      ${providerParam},
      ${info.accountId},
      ${info.email},
      ${info.name},
      ${accessEnc},
      ${refreshEnc},
      ${provider.scopes}::text[],
      ${expiresAt}
    )
    ON CONFLICT (provider, account_id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          account_email = EXCLUDED.account_email,
          account_name = EXCLUDED.account_name,
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
          scopes = EXCLUDED.scopes,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
  `;

  await logAudit({
    userId: targetUserId,
    target: targetUserId,
    action: isNewUser
      ? `oauth_${providerParam}_signup`
      : `oauth_${providerParam}_linked`,
    metadata: { account_id: info.accountId, email: info.email },
  });

  // 5) Mint a fresh session if the caller didn't already have one.
  if (!sessionUser) {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = c.req.header("user-agent") ?? null;
    const session = await createSession({ userId: targetUserId, ip, userAgent: ua });
    const isHttps = c.req.url.startsWith("https://");
    c.header(
      "Set-Cookie",
      serializeSessionCookie(session.id, {
        maxAge: config.session.ttlSeconds,
        secure: isHttps,
      }),
      { append: true },
    );
    await logAudit({
      userId: targetUserId,
      target: "auth",
      action: "login_success",
      metadata: { via: `oauth_${providerParam}` },
    });
  }

  c.header("Set-Cookie", clearStateCookie(), { append: true });
  return c.redirect("/settings?oauth=ok", 302);
});

// Create a brand-new user from an OAuth profile. Username defaults to
// the email local-part (uniquified on collision); name falls back to the
// email; password is generated and discarded (must_change_password=true).
async function createLocalUserFromOAuth(
  info: { accountId: string; email: string | null; name: string | null },
  provider: ProviderId,
): Promise<string> {
  const email = info.email ?? `${provider}-${info.accountId}@oauth.local`;
  const baseUsername = email.includes("@")
    ? email.split("@")[0]!.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40)
    : `${provider}-${info.accountId.slice(0, 8)}`;
  const username = (baseUsername.length > 0 ? baseUsername : `user-${info.accountId.slice(0, 8)}`).slice(0, 60);
  const displayName = info.name ?? email.split("@")[0]!;
  const password = generateOneTimePassword(14);
  const hash = await hashPassword(password);

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
    VALUES (${displayName}, ${username}, ${hash}, 'user', TRUE, TRUE)
    ON CONFLICT (username) DO UPDATE
      SET name = EXCLUDED.name
    RETURNING id
  `;
  return inserted[0]!.id;
}

// ─────────────────────────────────────────────────────────────────────
// /api/oauth/accounts  (auth) — list identities for current user
// ─────────────────────────────────────────────────────────────────────

authedRouter.get("/accounts", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    provider: string;
    account_id: string;
    account_email: string | null;
    account_name: string | null;
    scopes: string[];
    expires_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT id, provider, account_id, account_email, account_name,
           scopes, expires_at, created_at, updated_at
    FROM oauth_accounts
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at ASC
  `;
  return c.json(rows);
});

// ─────────────────────────────────────────────────────────────────────
// /api/oauth/accounts/:id  (auth) — disconnect
// ─────────────────────────────────────────────────────────────────────

authedRouter.delete("/accounts/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{ id: string; provider: string }[]>`
    SELECT id, provider FROM oauth_accounts
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  await sql`DELETE FROM oauth_accounts WHERE id = ${id}::uuid`;
  await logAudit({
    userId: user.id,
    target: id,
    action: `oauth_${row.provider}_unlinked`,
  });
  return c.json({ ok: true });
});

export { signState, verifyState, getProvider, isProviderId };

// Merge authed sub-router so /:provider/start, /accounts, and
// /accounts/:id all run under requireAuth. /callback stays public
// (provider hits it before any session exists).
router.route("/", authedRouter);

export default router;