// Smoke test for the AAD binding + version rotation in crypto.ts.
// Runs under `bun test` — no external deps.
//
// Covers:
//   - v2 round-trip (encryptSecret / decryptSecret)
//   - v1 legacy blob (no AAD) still decrypts via the legacy salt
//   - v2 with the wrong AAD context fails to decrypt
//   - malformed blobs: wrong part count, invalid base64, empty input
//   - maskSecret: short / long / exact-edge boundaries

import { describe, test, expect, beforeAll } from "bun:test";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { encryptSecret, decryptSecret, maskSecret } from "./crypto.ts";

// Tests construct synthetic v1/v2 blobs using the same key derivation
// constants as the production code. The constants live in crypto.ts;
// we duplicate them here so we don't have to export the salts (which
// would weaken the binding by exposing them on the module surface).
const SALT_V1 = "helm-provider-key-salt";
const SALT_V2 = "helm-provider-key-salt-v2";
const AAD_V2 = "helm.provider-secret.v2";

const TEST_SECRET = "test-secret-do-not-use-in-prod";

beforeAll(() => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = TEST_SECRET;
  }
});

function makeV1Blob(plaintext: string): string {
  const key = scryptSync(process.env.SESSION_SECRET ?? TEST_SECRET, SALT_V1, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // No setAAD — legacy v1 path.
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function makeV2BlobWithAAD(plaintext: string, aad: string): string {
  const key = scryptSync(
    process.env.PROVIDER_KEY_SECRET ?? process.env.SESSION_SECRET ?? TEST_SECRET,
    SALT_V2,
    32,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

describe("crypto: round-trip + version transition", () => {
  test("v2 round-trips encrypt -> decrypt", () => {
    const plain = "sk-1234567890abcdef";
    const ct = encryptSecret(plain);
    expect(ct.startsWith("v2:")).toBe(true);
    expect(decryptSecret(ct)).toBe(plain);
  });

  test("v1 legacy blob still decrypts after v2 migration", () => {
    // Old rows predate AAD; the v1 path must remain readable so we
    // don't lose stored provider keys on rotation.
    const blob = makeV1Blob("legacy-key-abc");
    const pt = decryptSecret(blob);
    expect(pt).toBe("legacy-key-abc");
  });

  test("v1 -> v2 transition: a freshly re-encrypted row still reads", () => {
    // Simulate the migration: take a v1 plaintext, encrypt with v2,
    // confirm we can read both the old (v1) and the new (v2) blob.
    const legacy = makeV1Blob("shared-secret");
    expect(decryptSecret(legacy)).toBe("shared-secret");
    const fresh = encryptSecret("shared-secret");
    expect(fresh.startsWith("v2:")).toBe(true);
    expect(decryptSecret(fresh)).toBe("shared-secret");
  });
});

describe("crypto: AAD context binding", () => {
  test("a v2 blob with the wrong AAD fails to decrypt", () => {
    // Build a v2 blob bound to a different context label. The
    // production decryptSecret pins AAD to AAD_V2; GCM must reject
    // anything else. This is the "ghost protocol" defence.
    const wrongAad = "helm.some-other-context.v9";
    const blob = makeV2BlobWithAAD("sk-test", wrongAad);
    expect(() => decryptSecret(blob)).toThrow();
  });

  test("a v2 blob encrypted with the right AAD decrypts successfully", () => {
    const blob = makeV2BlobWithAAD("sk-test", AAD_V2);
    expect(decryptSecret(blob)).toBe("sk-test");
  });
});

describe("crypto: malformed input", () => {
  test("parts.length !== 4 throws", () => {
    expect(() => decryptSecret("v2:abc:def")).toThrow("invalid encrypted blob");
    expect(() => decryptSecret("v2:abc:def:ghi:jkl")).toThrow("invalid encrypted blob");
  });

  test("invalid base64 in a part throws", () => {
    // '!!!' is not valid base64; the Buffer.from(..., 'base64') call
    // returns an empty Buffer which then fails GCM final().
    const bad = "v2:!!!:!!:!!";
    expect(() => decryptSecret(bad)).toThrow();
  });

  test("empty string throws", () => {
    // Empty -> split(":") yields [""], length 1.
    expect(() => decryptSecret("")).toThrow("invalid encrypted blob");
  });

  test("unknown version prefix throws", () => {
    expect(() => decryptSecret("v9:aaa:bbb:ccc")).toThrow(
      "unknown encrypted blob version: v9",
    );
  });
});

describe("maskSecret", () => {
  test("returns '••••' for short strings (length <= 8)", () => {
    expect(maskSecret("")).toBe("••••");
    expect(maskSecret("abc")).toBe("••••");
    expect(maskSecret("12345678")).toBe("••••"); // exactly 8 — still short
  });

  test("masks middle of long strings (length > 8)", () => {
    // First 3 + bullet + last 3.
    expect(maskSecret("sk-1234567890")).toBe("sk-•••890");
  });

  test("exact edge: length 9 uses 3-prefix and 3-suffix", () => {
    // 9 chars -> one char exposed between the first 3 and last 3.
    const plain = "abcdefghi";
    const masked = maskSecret(plain);
    expect(masked.length).toBe(plain.length);
    expect(masked.slice(0, 3)).toBe(plain.slice(0, 3));
    expect(masked.slice(-3)).toBe(plain.slice(-3));
    expect(masked.slice(3, -3)).toBe("•••");
  });
});