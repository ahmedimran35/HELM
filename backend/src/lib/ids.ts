// Shared identifiers and small utilities used across the backend.
//
// Call-sign IDs are the signature visual device in §1 — `MDL-01`,
// `PNL-02`, `REQ-14`. These helpers generate them with the right prefix
// per entity so the front end can render `CallSign` badges everywhere.

let counter = 0;

export type CallSignPrefix =
  | "USR" | "MDL" | "PNL" | "MSG" | "REQ" | "PER" | "INT" | "CRN" | "DOC" | "SES";

export function makeCallSign(prefix: CallSignPrefix): string {
  // Not cryptographically unique — just human-friendly. Pair this with a
  // UUID primary key in the DB; the call-sign is for display only.
  counter = (counter + 1) % 9999;
  const num = (counter + 1).toString().padStart(2, "0");
  return `${prefix}-${num}`;
}

// Pick a short random string for one-time passwords (§7 password reset).
// Uses crypto.randomInt over the printable alphabet — no ambiguous chars.
const OTP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateOneTimePassword(length = 24): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += OTP_ALPHABET[buf[i]! % OTP_ALPHABET.length];
  }
  return out;
}