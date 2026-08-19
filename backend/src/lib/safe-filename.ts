// Build a safe `Content-Disposition` value for a user-supplied filename.
//
// Why we can't just stuff `encodeURIComponent(name)` between the
// quotes of `filename="..."`:
//
//   - `encodeURIComponent` does NOT encode `"`, `\r`, `\n`, or `;`.
//     A user-named file called `foo"; filename="evil.html` would let
//     them inject a second filename into the header.
//   - `encodeURIComponent` encodes spaces as `%20`, but RFC 6266 only
//     allows token characters in the plain `filename=` form. Browsers
//     (and intermediate proxies) will reject or mangle anything outside
//     the printable ASCII range.
//   - For non-ASCII filenames the standard is RFC 5987:
//     `filename*=UTF-8''<percent-encoded>`. The plain `filename=`
//     parameter is a fallback using ASCII-only characters.
//
// The strategy here:
//   1. Reject outright: control chars, `/` or `\`, `"`, `;`, names
//      that start with `.` (hidden files / config overrides on the
//      download path), and names longer than 255 bytes.
//   2. Replace any char outside [A-Za-z0-9._-] with `_` for the ASCII
//      fallback so a non-ASCII name still produces a usable, safe
//      plain-ascii filename for old browsers / proxies.
//   3. Always also emit the RFC 5987 `filename*=` parameter so modern
//      clients see the original Unicode name.
//
// Returns the full header value, ready to drop into the
// `Content-Disposition` header.

const ASCII_FALLBACK_RE = /[^A-Za-z0-9._-]/g;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const PATH_SEP_RE = /[\\/]/;

export interface SanitizeResult {
  /** Full `Content-Disposition` header value (no trailing newline). */
  header: string;
  /** The ASCII fallback that was used. Useful for logging / tests. */
  ascii: string;
  /** Whether the input had to be transformed (sanitized) at all. */
  sanitized: boolean;
}

export class UnsafeFilenameError extends Error {
  readonly code = "unsafe_filename";
  constructor(public reason: string) {
    super(`unsafe filename: ${reason}`);
  }
}

/** Per-byte validation. Throws `UnsafeFilenameError` on rejection. */
export function validateFilename(name: unknown): asserts name is string {
  if (typeof name !== "string") {
    throw new UnsafeFilenameError("name is not a string");
  }
  if (name.length === 0) {
    throw new UnsafeFilenameError("name is empty");
  }
  if (name.length > 255) {
    throw new UnsafeFilenameError("name exceeds 255 bytes");
  }
  if (PATH_SEP_RE.test(name)) {
    throw new UnsafeFilenameError("name contains path separator");
  }
  if (CONTROL_CHARS_RE.test(name)) {
    throw new UnsafeFilenameError("name contains control characters");
  }
  if (name.includes('"') || name.includes(";")) {
    throw new UnsafeFilenameError("name contains reserved character");
  }
  if (name.startsWith(".")) {
    throw new UnsafeFilenameError("name starts with a dot (hidden file)");
  }
}

/**
 * Encode a value for the RFC 5987 `filename*=` parameter. All non-ASCII
 * bytes are percent-encoded as UTF-8; the result contains only the
 * chars `[A-Za-z0-9._-~%]`. `*` is escaped as `%2A` per RFC 5987 §3.2.
 */
function encode5987(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let out = "";
  for (const b of bytes) {
    if (
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2e /* . */ ||
      b === 0x5f /* _ */ ||
      b === 0x2d /* - */ ||
      b === 0x7e /* ~ */
    ) {
      out += String.fromCharCode(b);
    } else if (b === 0x2a /* * */ || b === 0x27 /* ' */) {
      // Per RFC 5987 §3.2: `*` and `'` MUST be percent-encoded.
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/**
 * Returns the printable-ASCII fallback for `filename="..."`. Any byte
 * outside [A-Za-z0-9._-] is mapped to `_`. This keeps the plain
 * parameter strictly within the RFC 6266 token-char set so ancient
 * browsers / broken proxies don't strip the header.
 */
function asciiFallback(name: string): string {
  if (ASCII_FALLBACK_RE.test(name)) {
    return name.replace(ASCII_FALLBACK_RE, "_");
  }
  return name;
}

/**
 * Build the full `Content-Disposition` header value for a filename.
 * Throws `UnsafeFilenameError` if the name is rejected outright
 * (path separators, control chars, etc).
 */
export function sanitizeContentDispositionFilename(name: string): SanitizeResult {
  validateFilename(name);
  const ascii = asciiFallback(name);
  const sanitized = ascii !== name;
  // If the original is pure ASCII AND no chars were replaced, emit
  // a single `filename="..."` parameter — modern browsers prefer it
  // and it keeps the header short.
  if (!sanitized) {
    return {
      header: `attachment; filename="${ascii}"`,
      ascii,
      sanitized: false,
    };
  }
  // Mixed / non-ASCII: emit BOTH the ASCII fallback (for old clients)
  // and the RFC 5987 `filename*=` (for everything else). Order matters:
  // some parsers stop at the first parameter, so the safer ASCII one
  // comes first.
  const encoded = encode5987(name);
  return {
    header: `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    ascii,
    sanitized: true,
  };
}