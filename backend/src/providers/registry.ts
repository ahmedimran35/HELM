// Build a ProviderAdapter for a stored `providers` row. We instantiate
// one adapter per (provider_id, request) and cache it for the duration
// of that request — long-lived cross-request caching would let a stale
// key linger after the admin rotates it.

import { sql } from "../db/client.ts";
import { decryptSecret } from "./crypto.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { OpenAICompatAdapter } from "./openai_compat.ts";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ProviderAdapter } from "./adapter.ts";

export interface StoredProvider {
  id: string;
  type: "openai" | "anthropic" | "nvidia-nim" | "openai-compatible";
  base_url: string;
  api_key_encrypted: string;
}

export async function getProviderById(id: string): Promise<StoredProvider | null> {
  const rows = await sql<StoredProvider[]>`
    SELECT id, type, base_url, api_key_encrypted
    FROM providers
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listProviders(): Promise<StoredProvider[]> {
  return sql<StoredProvider[]>`
    SELECT id, type, base_url, api_key_encrypted
    FROM providers
    ORDER BY added_at ASC
  `;
}

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "169.254.169.254",
  "fd00:ec2::254",
  "100.100.100.200",
]);

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || !parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a !== undefined && a >= 224)
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.split("%")[0]!.toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(h)) return true;
  if (h.startsWith("ff")) return true;
  const v4Mapped = h.match(/^::ffff:([0-9.]+)$/i);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]!);
  return false;
}

function hasSuspiciousEncoding(host: string): boolean {
  if (/^[0-9]{8,10}$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^0[0-7]+\./.test(host)) return true;
  return false;
}

/** SSRF guard — refuses private/loopback base URLs unless the provider
 *  is explicitly allowed to talk to localhost. Resolves DNS so a
 *  hostname that resolves to a private IP is still rejected, even
 *  when the hostname itself looks innocuous.
 *
 *  - 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10
 *  - IPv4-mapped IPv6, IPv6 ULA (fc/fd), link-local (fe80::/10)
 *  - Numeric IP encodings (decimal/hex/octal)
 *  - Embedded credentials in URL
 *
 *  By default non-80/443 ports are rejected. Pass `allowAnyPort` for
 *  admin-configured provider URLs (e.g. an OpenAI-compatible adapter
 *  on a self-hosted :8443).
 */
export async function assertSafeBaseUrl(
  baseUrl: string,
  opts: { allowLocal?: boolean; allowAnyPort?: boolean } = {},
): Promise<void> {
  const allowLocal = opts.allowLocal ?? false;
  const allowAnyPort = opts.allowAnyPort ?? true; // admin-configured provider URLs may use any port
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("invalid base URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("base URL must be http or https");
  }
  if (u.username || u.password) {
    throw new Error("base URL with embedded credentials is not allowed");
  }
  const host = u.hostname.toLowerCase();
  if (!host) throw new Error("base URL is missing hostname");
  if (hasSuspiciousEncoding(host)) {
    throw new Error("base URL uses a numeric IP encoding");
  }
  const envAllows = process.env.HELM_ALLOW_LOCAL_PROVIDERS === "1";
  const localOk = allowLocal || envAllows;
  if (BLOCKED_HOSTS.has(host) && !localOk) {
    throw new Error("base URL is a metadata service");
  }
  if (
    !localOk &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local"))
  ) {
    throw new Error("base URL points to a private/loopback address");
  }

  // Port filter — for user-driven URLs we restrict to 80/443; admin
  // URLs may use any port.
  if (!allowAnyPort && u.port && u.port !== "80" && u.port !== "443") {
    throw new Error(`base URL port ${u.port} is not allowed`);
  }

  if (isIP(host) === 4) {
    if (!localOk && isPrivateIPv4(host)) {
      throw new Error("base URL is in a private IP range");
    }
  } else if (isIP(host) === 6) {
    if (!localOk && isPrivateIPv6(host)) {
      throw new Error("base URL is in a private IPv6 range");
    }
  } else {
    // Hostname — resolve DNS and validate every returned record.
    let resolved: { address: string; family: number }[];
    try {
      resolved = await lookup(host, { all: true });
    } catch (err) {
      throw new Error(`DNS resolution failed for ${host}: ${(err as Error).message}`);
    }
    if (resolved.length === 0) {
      throw new Error(`no DNS records for ${host}`);
    }
    for (const r of resolved) {
      if (r.family === 4) {
        if (!localOk && isPrivateIPv4(r.address)) {
          throw new Error(`base URL ${host} resolves to private IPv4 ${r.address}`);
        }
      } else if (r.family === 6) {
        if (!localOk && isPrivateIPv6(r.address)) {
          throw new Error(`base URL ${host} resolves to private IPv6 ${r.address}`);
        }
      }
    }
  }
}

export async function buildAdapter(p: StoredProvider, opts?: { allowLocal?: boolean }): Promise<ProviderAdapter> {
  const allowLocal = opts?.allowLocal ?? process.env.HELM_ALLOW_LOCAL_PROVIDERS === "1";
  await assertSafeBaseUrl(p.base_url, { allowLocal, allowAnyPort: true });
  const apiKey = decryptSecret(p.api_key_encrypted);
  switch (p.type) {
    case "openai":
      return new OpenAICompatAdapter({
        baseUrl: "https://api.openai.com/v1",
        apiKey,
      });
    case "anthropic":
      return new AnthropicAdapter({ apiKey });
    case "nvidia-nim":
      return new OpenAICompatAdapter({
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey,
      });
    case "openai-compatible":
      return new OpenAICompatAdapter({
        baseUrl: p.base_url,
        apiKey,
      });
  }
}