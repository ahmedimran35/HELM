// First-boot admin seeding (docs §7).
//
// On every server start we look at `users`:
//   - If the table has zero rows, create exactly one admin from
//     ADMIN_USERNAME / ADMIN_PASSWORD, hash the password immediately,
//     record the bootstrap in `bootstrap_meta`, and stop.
//   - If there are already users, we IGNORE the env vars entirely — a
//     stale .env must never overwrite or reset an admin's password.

import { sql } from "../db/client.ts";
import { hashPassword } from "./password.ts";
import { config } from "../config.ts";

export async function runBootstrap(): Promise<{ seeded: boolean; adminId: string | null }> {
  const result = await sql.begin(async (tx) => {
    const userRows = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
    const count = Number(userRows[0]?.count ?? "0");

    if (count > 0) {
      // Users exist — per §7.3, do not touch the .env vars.
      // Backfill: any user where `name === username` was almost certainly
      // bootstrapped from an env-typed email. Fix the display name now
      // so the sidebar doesn't show "Signed in as admin@helm.local"
      // twice. This is a one-shot idempotent UPDATE keyed on
      // `name = username`.
      await tx`
        UPDATE users
        SET name = CASE
          WHEN position('@' in username) > 0
            THEN upper(substring(username FROM 1 FOR 1)) || lower(substring(username FROM 2 FOR position('@' in username) - 2))
          ELSE upper(substring(username FROM 1 FOR 1)) || lower(substring(username FROM 2))
        END
        WHERE name = username
      `;
      return { seeded: false, adminId: null };
    }

    // First boot. Hash the plaintext password from env, create the admin,
    // mark the bootstrap. The plaintext password is NEVER persisted — only
    // the bcrypt hash is stored, and we zero out our local reference.
    //
    // Force must_change_password=TRUE for env-seeded passwords. Operators
    // who set ADMIN_PASSWORD=… in compose / k8s leave that secret in
    // the deployment manifest (and in build logs, repo history, etc.),
    // so the very first session must rotate to a real one. The
    // ≥12-char gate we used to use silently left dev / staging installs
    // on a leaked password.
    const username = config.admin.username;
    const plaintext = config.admin.password;
    const passwordHash = await hashPassword(plaintext);
    const mustChange = true;
    // Derive a human-readable display name from the login. The admin
    // env often uses an email ("admin@helm.local") which looks ugly as
    // both `name` and `username` in the sidebar. Use the local part of
    // an email, or the whole string for a plain username.
    const localPart = username.includes("@") ? username.split("@")[0]! : username;
    const displayName =
      localPart.length === 0
        ? "Admin"
        : localPart.charAt(0).toUpperCase() + localPart.slice(1).toLowerCase();

    const inserted = await tx<{ id: string }[]>`
      INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
      VALUES (${displayName}, ${username}, ${passwordHash}, 'admin', ${mustChange}, TRUE)
      RETURNING id
    `;
    const adminId = inserted[0]?.id ?? null;

    await tx`
      UPDATE bootstrap_meta
      SET bootstrapped_at = now(),
          bootstrapped_admin_id = ${adminId}::uuid
      WHERE id = 1
    `;

    return { seeded: true, adminId };
  });

  if (result.seeded) {
    console.log(`✓ bootstrap: seeded first admin "${config.admin.username}" (must_change_password=true)`);
    console.log("  → log in and change the password immediately");
  } else {
    console.log("✓ bootstrap: users table non-empty, skipping seed");
  }

  // Zero-config auto-provisioning: if the binary `lightpanda` is on
  // the PATH (or set via $LIGHTPANDA_BIN) and the web_search_keys
  // table is empty, register it as a managed provider so admins don't
  // have to. Skips if the operator has already configured something
  // manually. Runs every boot — safe because of the count check.
  await sql.begin(async (tx) => {
    const existing = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM web_search_keys WHERE connected = TRUE
    `;
    const auto = (existing[0]?.n ?? 0) === 0 && !!config.webSearch.lightpandaBin;
    if (auto) {
      const { encryptSecret } = await import("../providers/crypto.ts");
      const stored = encryptSecret(config.webSearch.lightpandaBin);
      await tx`
        INSERT INTO web_search_keys (service, api_key_encrypted, connected, base_url, added_by)
        VALUES ('lightpanda', ${stored}, TRUE, '', NULL)
        ON CONFLICT (service) DO UPDATE
          SET api_key_encrypted = EXCLUDED.api_key_encrypted,
              base_url = EXCLUDED.base_url,
              connected = TRUE
      `;
      console.log(
        `✓ web search: auto-configured lightpanda → ${config.webSearch.lightpandaBin}`,
      );
    }
  });
  return result;
}