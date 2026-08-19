// Password hashing helpers. We use bcryptjs (pure-JS) so the backend stays
// portable — bun:ffi bindings would be faster but pull in native build deps.
// Per docs §7: hash on first boot, never store or log plaintext.

import bcrypt from "bcryptjs";

// Cost is env-driven so ops can tune it without a code change. Default 10
// matches the original bcryptjs recommendation (~60ms per hash on a modern
// machine). The valid range for bcrypt is 4..15 — values below 4 are too weak
// to brute-force and values above 15 exceed the 72-byte password truncation
// in a way that makes hashing take seconds without meaningful security gain.
// We refuse to hash outside that range to fail loud on misconfiguration
// rather than silently falling back to a weaker default.
function resolveCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (raw === undefined || raw === "") return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 4 || n > 15) {
    throw new Error(
      `BCRYPT_COST must be an integer between 4 and 15 (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  return bcrypt.hash(plain, resolveCost());
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof hash !== "string") return false;
  // bcrypt.compare is constant-time — exactly what we want here.
  return bcrypt.compare(plain, hash);
}