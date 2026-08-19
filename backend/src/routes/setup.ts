// Setup / onboarding — Tier 7 (zero-config deploy).
//
//   GET  /api/setup/status     — public; returns { setup_required, ... }
//   POST /api/setup/complete   — public; atomic create-admin +
//                                configure-first-provider + seed-demo
//
// The intent is that a fresh install lands on this endpoint instead of
// /login: the wizard is shown at `/setup`, and only after a successful
// POST does the API consider the system "configured" (so /login and the
// shell kick in normally).
//
// We deliberately do NOT auto-disable `setup_required` once a user is
// created by the bootstrap step — the wizard is also the supported way
// for an admin to add a real provider + seed demo apps, so we re-use
// the same endpoint for "first launch" and "configure me properly".
//
// All inputs are server-validated; we never trust the wizard client.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { hashPassword } from "../auth/password.ts";
import { encryptSecret } from "../providers/crypto.ts";
import { assertSafeBaseUrl } from "../providers/registry.ts";
import { runBootstrap } from "../auth/bootstrap.ts";
import { runSkillsSeed } from "../db/seed/skills-seed.ts";
import { seedAppsIfEmpty } from "../db/seed/apps-seed.ts";
import { logAudit } from "../lib/audit.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();

// ---- Public status -----------------------------------------------------

router.get("/status", async (c) => {
  const users = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
  const providers = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM providers`;
  const meta = await sql<{ bootstrapped_at: Date | null }[]>`
    SELECT bootstrapped_at FROM bootstrap_meta WHERE id = 1
  `;
  const userCount = Number(users[0]?.count ?? "0");
  const providerCount = Number(providers[0]?.count ?? "0");
  return c.json({
    setup_required: userCount === 0,
    users: userCount,
    providers: providerCount,
    bootstrapped_at: meta[0]?.bootstrapped_at ?? null,
    features: {
      skills: true,
      apps: true,
      voice: false, // reserved for Tier 3 wiring
      workflow: true,
      cost_router: providerCount > 0,
    },
  });
});

// ---- Public completion -------------------------------------------------
//
// body:
//   admin: { name, username, password, email? }
//   provider?: { type, base_url, display_name?, api_key }
//   invites?: [{ name, username, role? }]

interface AdminIn {
  name?: unknown;
  username?: unknown;
  password?: unknown;
  email?: unknown;
}
interface ProviderIn {
  type?: unknown;
  base_url?: unknown;
  display_name?: unknown;
  api_key?: unknown;
}
interface InviteIn {
  name?: unknown;
  username?: unknown;
  role?: unknown;
}
interface CompleteBody {
  admin?: AdminIn;
  provider?: ProviderIn;
  invites?: InviteIn[];
}

const ALLOWED_PROVIDER_TYPES = new Set([
  "openai",
  "anthropic",
  "nvidia-nim",
  "openai-compatible",
]);

router.post("/complete", async (c) => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as CompleteBody;

  // The entire setup wizard is a one-time, unauthenticated bootstrap. Once
  // any user exists, refuse every subsequent call with 410 Gone so an
  // anonymous attacker can't:
  //   - inject a malicious provider URL (already fixed in the provider
  //     block, but defence-in-depth)
  //   - create a fresh admin row (the invites loop accepts role: "admin"
  //     from the body — an attacker could spam-create new admin users
  //     with a discarded one-time password; combined with a wipe of the
  //     only existing user, the wizard comes back online as a public
  //     admin-creation backdoor)
  const preExisting = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
  if (Number(preExisting[0]?.count ?? "0") > 0) {
    return c.json({ error: "setup_already_completed" }, 410);
  }

  const admin = body.admin ?? {};
  const provider = body.provider ?? {};
  const invites = Array.isArray(body.invites) ? body.invites : [];

  // ---- Validate admin --------------------------------------------------
  const adminName = typeof admin.name === "string" ? admin.name.trim() : "";
  const adminUsername = typeof admin.username === "string" ? admin.username.trim() : "";
  const adminPassword = typeof admin.password === "string" ? admin.password : "";
  const adminEmail = typeof admin.email === "string" ? admin.email.trim() : "";
  if (!adminName) return c.json({ error: "admin.name required", field: "admin.name" }, 400);
  if (adminName.length > 120) return c.json({ error: "admin.name too long", field: "admin.name" }, 400);
  if (!adminUsername) return c.json({ error: "admin.username required", field: "admin.username" }, 400);
  if (adminUsername.length > 120) return c.json({ error: "admin.username too long", field: "admin.username" }, 400);
  if (adminPassword.length < 10) {
    return c.json({ error: "admin.password must be at least 10 chars", field: "admin.password" }, 400);
  }
  if (adminPassword.length > 200) {
    return c.json({ error: "admin.password too long", field: "admin.password" }, 400);
  }
  if (adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    return c.json({ error: "admin.email is not a valid email", field: "admin.email" }, 400);
  }

  // ---- Validate provider (optional) ------------------------------------
  let providerRow: { type: string; base_url: string; api_key: string; display_name: string | null } | null = null;
  const providerType = typeof provider.type === "string" ? provider.type : "";
  const providerBaseUrl = typeof provider.base_url === "string" ? provider.base_url.trim() : "";
  const providerApiKey = typeof provider.api_key === "string" ? provider.api_key : "";
  const providerDisplayName =
    typeof provider.display_name === "string" && provider.display_name.trim().length > 0
      ? provider.display_name.trim()
      : null;
  if (providerType || providerBaseUrl || providerApiKey) {
    if (!ALLOWED_PROVIDER_TYPES.has(providerType)) {
      return c.json({ error: "provider.type must be one of: openai, anthropic, nvidia-nim, openai-compatible", field: "provider.type" }, 400);
    }
    if (!providerBaseUrl) {
      return c.json({ error: "provider.base_url required", field: "provider.base_url" }, 400);
    }
    if (!providerApiKey || providerApiKey.length < 8) {
      return c.json({ error: "provider.api_key required", field: "provider.api_key" }, 400);
    }
    try {
      await assertSafeBaseUrl(providerBaseUrl, { allowLocal: true, allowAnyPort: true });
    } catch (err) {
      return safeError(c, err, { status: 400, code: "setup_provider_url_invalid", publicMessage: "provider.base_url is not a safe URL" });
    }
    providerRow = {
      type: providerType,
      base_url: providerBaseUrl,
      api_key: providerApiKey,
      display_name: providerDisplayName ?? providerType,
    };
  }

  // ---- Validate invites ------------------------------------------------
  const validatedInvites: { name: string; username: string; role: "admin" | "user" }[] = [];
  for (const [i, inv] of invites.entries()) {
    const name = typeof inv?.name === "string" ? inv.name.trim() : "";
    const username = typeof inv?.username === "string" ? inv.username.trim() : "";
    const role = inv?.role === "admin" ? "admin" : "user";
    if (!name || name.length > 120) {
      return c.json({ error: `invites[${i}].name invalid`, field: `invites[${i}].name` }, 400);
    }
    if (!username || username.length > 120) {
      return c.json({ error: `invites[${i}].username invalid`, field: `invites[${i}].username` }, 400);
    }
    validatedInvites.push({ name, username, role });
  }

  // ---- Atomic apply ----------------------------------------------------
  // We do this in a single transaction so a partial setup never leaves
  // the system half-configured. If anything throws, we roll back and
  // report the error.
  try {
    await sql.begin(async (tx) => {
      // Insert admin if the users table is empty. We honour existing
      // admins (in case someone re-runs the wizard without resetting).
      const existing = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
      const isFirstBoot = Number(existing[0]?.count ?? "0") === 0;
      if (isFirstBoot) {
        const hash = await hashPassword(adminPassword);
        await tx`
          INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
          VALUES (${adminName}, ${adminUsername}, ${hash}, 'admin', FALSE, TRUE)
        `;
        await tx`
          UPDATE bootstrap_meta SET bootstrapped_at = now(), bootstrapped_admin_id = (
            SELECT id FROM users WHERE username = ${adminUsername} LIMIT 1
          ) WHERE id = 1
        `;
      }
      // Provider insertion is gated on first-boot only — once users
      // exist, the endpoint becomes effectively read-only, so an
      // anonymous caller can no longer inject a malicious provider
      // even if the wizard was previously completed.
      if (providerRow && isFirstBoot) {
        const enc = encryptSecret(providerRow.api_key);
        await tx`
          INSERT INTO providers (type, base_url, api_key_encrypted, display_name)
          VALUES (${providerRow.type}, ${providerRow.base_url}, ${enc}, ${providerRow.display_name})
        `;
      }
      // Invitees always get a generated one-time password so the wizard
      // never has to deal with password strength for non-admins.
      for (const inv of validatedInvites) {
        const generated = randomPassword(14);
        const hash = await hashPassword(generated);
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
          VALUES (${inv.name}, ${inv.username}, ${hash}, ${inv.role}, TRUE, TRUE)
          RETURNING id
        `;
        await logAudit({
          userId: inserted[0]?.id ?? null,
          target: inserted[0]?.id ?? "setup",
          action: "user_invited",
          metadata: { source: "setup_wizard", role: inv.role },
        });
      }
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("users_username_key")) {
      return c.json({ error: "username_taken", field: "admin.username" }, 409);
    }
    return safeError(c, err, { status: 500, code: "setup_failed", publicMessage: "Setup failed" });
  }

  // Post-commit seeders run outside the transaction (they no-op when
  // data already exists).
  await runSkillsSeed();
  await seedAppsIfEmpty();
  // Refresh bootstrap state in case the env-derived admin row won the
  // race (the wizard admin we just created takes precedence).
  await runBootstrap();

  return c.json({ ok: true });
});

// local helper — mirror of generateOneTimePassword but without the
// shared prefix constant import; kept self-contained so a future
// refactor of ids.ts can't break the setup path silently.
function randomPassword(length = 12): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += alpha[buf[i]! % alpha.length];
  return out;
}

export default router;