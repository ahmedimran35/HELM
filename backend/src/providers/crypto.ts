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
//
// v3 (current): in addition to the version-prefix rotation, every
// v2/v3 ciphertext is bound to a stable Additional Authenticated Data
// label ("helm.provider-secret.v2"). Binding the ciphertext to a
// context label prevents cross-context replay: an attacker who steals
// a provider ciphertext row cannot paste it into a different column
// (e.g. a different secret_kind table) and have it decrypt. Without
// AAD, AES-GCM only authenticates the (IV, ciphertext, tag) triple and
// leaves the surrounding context unauthenticated — the classic
// "ghost protocol" attack. Adding AAD closes that hole. v1 ciphertexts
// continue to fall back to the no-AAD path for backwards compatibility.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { config } from "../config.ts";

const ALGO = "aes-256-gcm";
// v1 (legacy) used this exact salt against SESSION_SECRET.
const SALT_V1_LEGACY = "helm-provider-key-salt";
// v2 (current) uses a separate PROVIDER_KEY_SECRET env.
const SALT_V2 = "helm-provider-key-salt-v2";

// AAD context label — a constant, version-stamped string. Authenticated
// alongside every v2 ciphertext. Hard-coding it (not env-driven) means
// an attacker who controls env cannot weaken the context binding. If
// the context ever needs to change, bump to v3 + add a new constant
// (and never reuse this one).
const AAD_CONTEXT_V2 = "helm.provider-secret.v2" as const;

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
  // Bind ciphertext to a context label so it cannot be replayed across
  // different columns / secret kinds / tables. setAAD must be called
  // BEFORE final() (or getAuthTag()).
  cipher.setAAD(Buffer.from(AAD_CONTEXT_V2, "utf8"));
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
  let useAad: string | null;
  switch (version) {
    case "v1":
      // Legacy: encrypted with the pre-versioned code, no AAD.
      // Re-reading these rows still needs to succeed — they predate
      // the AAD hardening.
      key = KEY_V1;
      useAad = null;
      break;
    case "v2":
      key = KEY_V2;
      useAad = AAD_CONTEXT_V2;
      break;
    default:
      throw new Error(`unknown encrypted blob version: ${version}`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // setAAD must be called AFTER setAuthTag and BEFORE update/final.
  // If a v1 blob accidentally lands on the v2 path (wrong version
  // prefix), or the ciphertext is replayed under a different context
  // label, GCM final() will throw "Unsupported state or unable to
  // authenticate data" — that is the entire point.
  if (useAad !== null) {
    decipher.setAAD(Buffer.from(useAad, "utf8"));
  }
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export function maskSecret(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 3)}•••${plain.slice(-3)}`;
}