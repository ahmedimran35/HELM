// Symmetric encryption helpers for OAuth tokens, Slack bot tokens, and any
// other at-rest credential we don't want to live in plaintext (docs §8.4).
//
// We wrap the providers/crypto.ts helper so other domains (oauth, slack,
// future integrations) have a stable import path under `lib/`. The
// implementation is AES-256-GCM with a key derived from SESSION_SECRET via
// scrypt. Decryption only happens server-side; the API never returns the
// plaintext (the `maskSecret` helper is for safe UI display only).

import {
  encryptSecret,
  decryptSecret,
  maskSecret,
} from "../providers/crypto.ts";

export { encryptSecret, decryptSecret, maskSecret };