// Provider-secret encryption at rest. We use AES-256-GCM with a key
// derived from a *dedicated* `PROVIDER_KEY_SECRET` env var (falls back
// to `SESSION_SECRET` for backwards-compatibility, but operators are
// expected to set both). Decryption only happens server-side; the API
// never returns the plaintext key.
//
// Key rotation: the version prefix on the ciphertext (`v1:`) tells
// `decryptSecret` which KEY to use. New writes are `v2:` and use
// `PROVIDER_KEY_SECRET`; old `v1:` rows are still readable via the
// fallback key. To rotate, set the new env, run a one-time migration
// that re-encrypts all rows, then deprecate `v1` after a grace
// period. This is a "versioned" pattern so we can rotate SESSION_SECRET
// without losing stored provider keys.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.ts";

const ALGO = "aes-256-gcm";
// v1 (legacy) used this exact salt against SESSION_SECRET.
const SALT_V1_LEGACY = "helm-provider-key-salt";
// v2 (current) uses a separate PROVIDER_KEY_SECRET env.
const SALT_V2 = "helm-provider-key-salt-v2";

/** v1 key derived from SESSION_SECRET with the legacy salt. */
const KEY_V1 = scryptSync(config.session.secret, SALT_V1_LEGACY, 32);
/** v2 key derived from PROVIDER_KEY_SECRET (preferred). */
const KEY_V2 = scryptSync(
  process.env.PROVIDER_KEY_SECRET ?? config.session.secret,
  SALT_V2,
  32,
);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY_V2, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4) {
    throw new Error("invalid encrypted blob");
  }
  const [version, ivB64, tagB64, encB64] = parts as [string, string, string, string];
  let key: Buffer;
  switch (version) {
    case "v1":
      // Legacy: encrypted with the pre-versioned code.
      key = KEY_V1;
      break;
    case "v2":
      key = KEY_V2;
      break;
    default:
      throw new Error(`unknown encrypted blob version: ${version}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export function maskSecret(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 3)}•••${plain.slice(-3)}`;
}
