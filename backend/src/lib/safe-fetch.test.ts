// Unit tests for the SSRF guard (lib/safe-fetch.ts) — the single most
// security-critical pure function in the backend. Every user-driven
// outbound URL goes through assertSafeOutboundUrl; these tests pin the
// bypass vectors it must reject.
//
// Network-touching cases (DNS resolution + re-resolution before
// connect) need a resolver and are covered by the egress-check CI
// workflow instead; these tests cover the static gates that must not
// depend on the network.

import { describe, test, expect } from "bun:test";
import { assertSafeOutboundUrl } from "./safe-fetch.ts";

describe("assertSafeOutboundUrl", () => {
  // ---- Accepted URLs -------------------------------------------------
  test("accepts a plain https URL", async () => {
    const { url, resolvedIp } = await assertSafeOutboundUrl("https://api.openai.com/v1");
    expect(url.hostname).toBe("api.openai.com");
    expect(typeof resolvedIp).toBe("string");
  });

  test("accepts http on the default port", async () => {
    await assertSafeOutboundUrl("http://example.com/some/path");
  });

  // ---- Scheme / shape -------------------------------------------------
  test("rejects non-string input", async () => {
    await expect(assertSafeOutboundUrl(123 as unknown as string)).rejects.toThrow();
  });

  test("rejects control characters and whitespace", async () => {
    await expect(assertSafeOutboundUrl("https://example.com/\x00evil")).rejects.toThrow(
      "control or whitespace"
    );
    await expect(assertSafeOutboundUrl("https://example.com/ a")).rejects.toThrow();
  });

  test("rejects invalid URLs", async () => {
    await expect(assertSafeOutboundUrl("not-a-url")).rejects.toThrow("invalid URL");
  });

  test("rejects non-http(s) schemes", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow("not allowed");
    await expect(assertSafeOutboundUrl("ftp://example.com/x")).rejects.toThrow();
  });

  // ---- Credential stripping -------------------------------------------
  test("rejects embedded userinfo (credential leak via logs)", async () => {
    await expect(assertSafeOutboundUrl("https://user:pass@example.com/")).rejects.toThrow(
      "embedded credentials"
    );
  });

  // ---- Metadata / internal hosts -------------------------------------
  test("rejects the AWS metadata IP", async () => {
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
  });

  test("rejects cloud metadata hostnames", async () => {
    await expect(assertSafeOutboundUrl("http://metadata.google.internal/")).rejects.toThrow(
      "metadata service"
    );
    await expect(assertSafeOutboundUrl("http://metadata.google.internal/")).rejects.toThrow();
  });

  // ---- Numeric IP encodings -------------------------------------------
  test("rejects decimal IPv4 encoding of 127.0.0.1", async () => {
    // The URL parser normalizes decimal/hex forms to 127.0.0.1 before
    // the encoding check, so the block reason may be either
    // numeric_ip_encoding or private_ipv4 — both are correct rejections.
    await expect(assertSafeOutboundUrl("http://2130706433/")).rejects.toThrow();
  });

  test("rejects hex IPv4 encoding", async () => {
    await expect(assertSafeOutboundUrl("http://0x7f000001/")).rejects.toThrow();
  });

  test("rejects octal IPv4 encoding", async () => {
    await expect(assertSafeOutboundUrl("http://0177.0.0.1/")).rejects.toThrow();
  });

  // ---- Ports ----------------------------------------------------------
  test("rejects non-80/443 ports for user-driven URLs", async () => {
    await expect(assertSafeOutboundUrl("https://example.com:8443/x")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://example.com:8080/x")).rejects.toThrow();
  });

  test("accepts port 443 explicitly", async () => {
    await assertSafeOutboundUrl("https://example.com:443/x");
  });
});
