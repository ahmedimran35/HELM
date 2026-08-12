// Password hashing helpers. We use bcryptjs (pure-JS) so the backend stays
// portable — bun:ffi bindings would be faster but pull in native build deps.
// Per docs §7: hash on first boot, never store or log plaintext.

import bcrypt from "bcryptjs";

const COST = 12; // ~150ms per hash on a modern machine

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof hash !== "string") return false;
  // bcrypt.compare is constant-time — exactly what we want here.
  return bcrypt.compare(plain, hash);
}