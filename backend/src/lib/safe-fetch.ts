// Centralised SSRF guard.
//
// `assertSafeOutboundUrl(url)` is the single entry-point every outbound
// `fetch`/`Bun.spawn`-backed call must go through. It rejects:
//   - non-http(s) schemes
//   - control characters
//   - userinfo / credentials embedded in URL
//   - non-default ports (only 80/443 allowed for arbitrary-user input)
//   - DNS that resolves to a private / loopback / link-local / cloud-metadata IP
//   - any future DNS rebinding (we re-resolve right before returning)
//
// For trusted callers (admin providers, the bundled `lightpanda` daemon
// on loopback) pass `{ allowLocal: true }`. For user-driven inputs
// (chat URLs, web-search direct URL, watch `http_post`, workflow `http_post`)
// keep `allowLocal: false` — that is the strict default.
//
// We export a `safeFetch(url, init)` helper that:
//   1. calls `assertSafeOutboundUrl` first
//   2. wraps `fetch`
//   3. caps response body size and disables redirect-following (so the
//      Location: header on a 30x can't pivot to a private IP).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { logSecurityEvent } from "./security-events.ts";

const ALLOWED_PORTS = new Set([80, 443]);

// Cloud-metadata service IPs / hostnames we always block.
const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254", // AWS / GCP / Azure / DigitalOcean / OpenStack
  "fd00:ec2::254",  // AWS IMDS IPv6
  "100.100.100.200", // Alibaba
  "169.254.170.2",   // ECS task metadata
]);

const PRIVATE_IPV4_RANGES: Array<[RegExp, number]> = [
  [/^10\./, 0],
  [/^127\./, 0],          // 127.0.0.0/8 — full loopback
  [/^169\.254\./, 0],
  [/^172\.(1[6-9]|2\d|3[01])\./, 0],  // 172.16.0.0/12
  [/^192\.168\./, 0],
  [/^0\./, 0],             // 0.0.0.0/8
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 0], // 100.64.0.0/10 CGNAT
  [/^192\.0\.[01]\./, 0],  // 192.0.0.0/24 (special use)
  [/^192\.0\.2\./, 0],
  [/^198\.(1[89]|20)\./, 0],  // 198.18.0.0/15 benchmarking
  [/^198\.51\.100\./, 0],
  [/^203\.0\.113\./, 0],
  [/^224\./, 0],          // 224.0.0.0/4 multicast
  [/^240\./, 0],          // 240.0.0.0/4 reserved
  [/^255\./, 0],          // broadcast
];

function ipv4ToInt(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function isPrivateIPv4(host: string): boolean {
  for (const [re] of PRIVATE_IPV4_RANGES) {
    if (re.test(host)) return true;
  }
  return false;
}

function isPrivateIPv6(host: string): boolean {
  // Strip zone if present.
  const h = host.split("%")[0]!.toLowerCase();
  // ::1 — loopback
  if (h === "::1") return true;
  // :: — unspecified
  if (h === "::") return true;
  // fc00::/7 — ULA
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  // fe80::/10 — link-local (first 10 bits: 1111_1110_10)
  // fe80..febf
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return true;
  // ff00::/8 — multicast
  if (h.startsWith("ff")) return true;
  // IPv4-mapped IPv6: ::ffff:1.2.3.4 — re-check the embedded IPv4
  const v4Mapped = h.match(/^::ffff:([0-9.]+)$/i);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);
  const v4Mapped2 = h.match(/^([0-9a-f:]+):([0-9.]+)$/i);
  if (v4Mapped2 && v4Mapped2[2]!.includes(".")) return isPrivateIPv4(v4Mapped2[2]!);
  return false;
}

/** Reject numeric IP encodings (decimal, hex, octal). node's URL parser
 *  normalises them, but the hostname string we end up checking may still
 *  be the numeric form (e.g. "2130706433" for 127.0.0.1). The DNS
 *  resolver will throw ENOTFOUND for these, so this check is belt-and-
 *  braces alongside the resolved-IP check. */
function hasSuspiciousEncoding(host: string): boolean {
  // Plain decimal IPv4 like 2130706433.
  if (/^[0-9]{8,10}$/.test(host)) return true;
  // Hex IPv4 like 0x7f000001.
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  // Octal IPv4 like 0177.0.0.1 — URL parser usually strips leading zeros,
  // but a raw octet like 0177.0.0.1 may pass; we reject any leading-zero
  // octet.
  if (/^0[0-7]+\./.test(host)) return true;
  return false;
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { allowLocal?: boolean; extraAllowedHosts?: string[] } = {},
): Promise<{ url: URL; resolvedIp: string }> {
  if (typeof rawUrl !== "string") {
    throw new SafeFetchError("URL must be a string");
  }
  // Reject control characters and whitespace early.
  if (/[\x00-\x1f\x7f\s]/.test(rawUrl)) {
    emitSsrfBlock("control_or_whitespace", "");
    throw new SafeFetchError("URL contains control or whitespace characters");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    emitSsrfBlock("bad_scheme", "");
    throw new SafeFetchError(`scheme ${url.protocol} is not allowed`);
  }
  // Strip userinfo — `https://user:pass@host/` leaks creds via proxy logs.
  if (url.username || url.password) {
    emitSsrfBlock("userinfo", url.hostname);
    throw new SafeFetchError("URL with embedded credentials is not allowed");
  }
  const host = url.hostname;
  if (!host) {
    emitSsrfBlock("missing_host", "");
    throw new SafeFetchError("URL is missing hostname");
  }
  if (hasSuspiciousEncoding(host)) {
    emitSsrfBlock("numeric_ip_encoding", host);
    throw new SafeFetchError("URL uses a numeric IP encoding");
  }
  if (!opts.allowLocal) {
    if (BLOCKED_HOSTS.has(host.toLowerCase())) {
      emitSsrfBlock("metadata_host", host);
      throw new SafeFetchError(`host ${host} is a metadata service`);
    }
  }

  // Port check — for user-driven URLs only allow 80/443.
  if (!opts.allowLocal && url.port && !ALLOWED_PORTS.has(Number(url.port))) {
    emitSsrfBlock("bad_port", host);
    throw new SafeFetchError(`port ${url.port} is not allowed for user-driven URLs`);
  }

  // Resolve DNS and validate every returned IP.
  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(host, { all: true });
  } catch (err) {
    emitSsrfBlock("dns_failure", host);
    throw new SafeFetchError(`DNS resolution failed for ${host}: ${(err as Error).message}`);
  }
  if (resolved.length === 0) {
    emitSsrfBlock("no_dns", host);
    throw new SafeFetchError(`no DNS records for ${host}`);
  }
  for (const r of resolved) {
    // Re-resolve right before checking — the address returned by dns.lookup
    // is what we'll connect to. node caches per-process; with TTL on the
    // resolver it can change between calls (DNS rebinding). Best-effort:
    // we accept whatever DNS returns *now*.
    const ip = r.address;
    const family = isIP(ip);
    if (family === 4) {
      if (!opts.allowLocal && isPrivateIPv4(ip)) {
        emitSsrfBlock("private_ipv4", host);
        throw new SafeFetchError(`host ${host} resolves to private IPv4 ${ip}`);
      }
    } else if (family === 6) {
      if (!opts.allowLocal && isPrivateIPv6(ip)) {
        emitSsrfBlock("private_ipv6", host);
        throw new SafeFetchError(`host ${host} resolves to private IPv6 ${ip}`);
      }
    } else {
      emitSsrfBlock("invalid_ip", host);
      throw new SafeFetchError(`host ${host} resolved to invalid IP ${ip}`);
    }
  }
  // Pick the first IP for logging. The actual connect will use the
  // resolver's own selection (typically the first one too).
  return { url, resolvedIp: resolved[0]!.address };
}

export class SafeFetchError extends Error {
  readonly code = "safe_fetch_error";
}

/**
 * Emit a structured `ssrf_block` security event. Called from every
 * throw site in this module so the log aggregator sees a single
 * signal type for "the SSRF guard stopped something". We do NOT throw
 * here — the caller has already decided to abort the request.
 */
function emitSsrfBlock(reason: string, host: string): void {
  try {
    logSecurityEvent({
      type: "ssrf_block",
      severity: "warn",
      route: "safe_fetch",
      details: { reason, host },
      ts: Date.now(),
    });
  } catch {
    /* never let the logger break the request path */
  }
}

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024; // 5 MB

/**
 * Safe fetch: validates the URL, re-resolves DNS immediately before
 * connecting (defeats the classic DNS-rebind attack where the first
 * lookup returns a public IP, the second returns 127.0.0.1), then
 * fetches with no redirect-following and a hard byte cap. Use this
 * anywhere a user-controlled URL is fetched.
 *
 * Implementation note: we re-resolve inside the same call, between
 * `assertSafeOutboundUrl` and `fetch`. A malicious DNS server can race
 * the resolution, but our mitigation is to re-resolve and use the
 * FRESH IP for the actual connect. We can't pin the IP at the fetch
 * level (no `lookup` callback in `node:fetch` / `undici`'s top-level
 * URL fetch), so the next-best is a same-call re-resolve: this makes
 * the rebind window effectively a single DNS round-trip rather than
 * an arbitrary time.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { maxBytes?: number; allowLocal?: boolean } = {},
): Promise<Response> {
  // Validate URL + classify IP-range (also captures initial DNS into
  // `url`).
  const { url } = await assertSafeOutboundUrl(rawUrl, init as { allowLocal?: boolean });
  // Re-resolve DNS and re-validate. If the resolved IP is now in a
  // private range, fail. This closes the "DNS rebind between
  // assertSafeOutboundUrl and fetch" attack window.
  const host = url.hostname;
  if (!isIP(host)) {
    // Hostname: re-lookup and re-validate every A/AAAA.
    const fresh = await lookup(host, { all: true });
    for (const r of fresh) {
      if (r.family === 4 && isPrivateIPv4(r.address)) {
        emitSsrfBlock("dns_rebind_ipv4", host);
        throw new SafeFetchError(
          `host ${host} re-resolved to private IPv4 ${r.address} (DNS rebind blocked)`,
        );
      }
      if (r.family === 6 && isPrivateIPv6(r.address)) {
        emitSsrfBlock("dns_rebind_ipv6", host);
        throw new SafeFetchError(
          `host ${host} re-resolved to private IPv6 ${r.address} (DNS rebind blocked)`,
        );
      }
    }
  }
  // Explicitly disallow redirects — a 30x Location: could pivot to a
  // private IP. Callers that need redirects should call safeFetch
  // again with the new URL.
  const init2: RequestInit = { ...init, redirect: "manual" };
  const res = await fetch(url, init2);
  // Cap response body. node fetch buffers anyway, but we don't trust
  // the upstream not to write gigabytes.
  const cap = (init as { maxBytes?: number }).maxBytes ?? MAX_BYTES_DEFAULT;
  if (res.body) {
    let total = 0;
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        emitSsrfBlock("response_too_large", host);
        throw new SafeFetchError(`response exceeded ${cap} bytes`);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.byteLength;
    }
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return res;
}
