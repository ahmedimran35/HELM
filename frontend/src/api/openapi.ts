// Hand-rolled typed OpenAPI client.
//
// We do NOT install `openapi-typescript` (no new dependencies) — the
// goal of this file is to give the front end typed access to the
// documented endpoints and to use the same wire format as the live
// routes.  We re-export a `OpenApiClient` class with one method per
// documented endpoint.
//
// All methods share the existing `fetch` + cookie behaviour via the
// project's `api/client.ts` helpers — `credentials: "include"`, 401
// → login redirect, 403 → forbidden event.  The client is a thin
// wrapper; nothing novel happens on the wire.

import { apiGet, apiPost, apiPut, apiDelete } from "./client";

// ── Shared types ────────────────────────────────────────────────────
export type UUID = string;

/** Admin/user role returned by /api/me and friends. */
export type Role = "admin" | "user";

/** Reachability status per popular provider. */
export type ProviderStatus = "up" | "degraded" | "down" | "unknown";

/** Harness latency classification. */
export type HarnessStatus = "healthy" | "degraded" | "down" | "unknown";

/** Upstream harness kinds surfaced by /api/chat + /api/harnesses. */
export type HarnessKind = "openai" | "anthropic" | "mock" | "pi" | "cli";

/** Per-provider health snapshot bundled with the providers list. */
export interface ProviderHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  latency_ms: number;
  checked_at: number;
  reason?: string;
  models_seen?: number;
}

export interface Provider {
  id: UUID;
  type: "openai" | "anthropic" | "nvidia-nim" | "openai-compatible" | string;
  base_url: string;
  display_name: string | null;
  api_key_masked: string;
  key_unreadable: boolean;
  added_at: string;
  model_count: number;
  health: ProviderHealth;
}

export interface Model {
  id: UUID;
  provider_id: UUID;
  provider_type: string;
  provider_base_url: string;
  external_id: string;
  display_name: string;
  context_window: number | null;
  assigned: boolean;
  pending_request: boolean;
}

export interface LoginResponse {
  user: {
    id: UUID;
    role: Role;
    must_change_password: boolean;
  };
}

export interface Me {
  id: UUID;
  username: string;
  name: string | null;
  role: Role;
  must_change_password: boolean;
}

export interface PopularProviderHealth extends Record<string, unknown> {
  id: string;
  name: string;
  url: string;
  short: string;
  status: ProviderStatus;
  latency_ms: number;
  http_code: number;
  checked_at: number;
  reason?: string;
}

export interface HarnessHealth {
  kind: HarnessKind;
  status: HarnessStatus;
  latency_ms: number;
  last_checked_at: number;
  reason?: string;
}

export interface FeedbackStats {
  total: number;
  up_pct: number;
  down_pct: number;
  ups: number;
  downs: number;
  per_model: Array<{
    model_id: UUID;
    model_name: string | null;
    ups: number;
    downs: number;
    total: number;
    up_pct: number;
  }>;
  trend: Array<{ bucket: string; ups: number; downs: number }>;
}

export interface AuditActivity {
  rows: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export interface ChatMessage {
  id: UUID;
  role: "user" | "assistant" | "system" | string;
  content: string;
  tokens: number;
  created_at: string;
}

// ── Client ──────────────────────────────────────────────────────────
export class OpenApiClient {
  // ───── Health ────────────────────────────────────────────────────
  /** GET /api/health — public liveness probe. */
  health(): Promise<{ ok: true; ts: number }> {
    return apiGet("/health");
  }

  /** GET /api/health/harnesses — auth-required, cached snapshot. */
  healthHarnesses(opts: { refresh?: boolean } = {}): Promise<{ harnesses: HarnessHealth[] }> {
    const q = opts.refresh ? "?refresh=1" : "";
    return apiGet(`/health/harnesses${q}`);
  }

  /** GET /api/health/providers/popular — public reachability probe. */
  healthPopularProviders(opts: { refresh?: boolean } = {}): Promise<{
    providers: PopularProviderHealth[];
    summary: { up: number; degraded: number; down: number; unknown: number };
    ts: number;
  }> {
    const q = opts.refresh ? "?refresh=1" : "";
    return apiGet(`/health/providers/popular${q}`);
  }

  // ───── Auth ──────────────────────────────────────────────────────
  /** POST /api/login — sets the session cookie on success. */
  login(body: { username: string; password: string }): Promise<LoginResponse> {
    return apiPost("/login", body);
  }

  /** POST /api/logout — clears the session cookie. */
  logout(): Promise<{ ok: true }> {
    return apiPost("/logout");
  }

  /** GET /api/me — returns the current user record. */
  me(): Promise<Me> {
    return apiGet("/me");
  }

  /** POST /api/change-password — password rotation. */
  changePassword(body: { current: string; next: string }): Promise<{ ok: true }> {
    return apiPost("/change-password", body);
  }

  /** GET /api/bootstrap-status — whether first-boot seeding has run. */
  bootstrapStatus(): Promise<{
    user_count: number;
    bootstrapped: boolean;
    bootstrapped_at: string | null;
  }> {
    return apiGet("/bootstrap-status");
  }

  // ───── Providers ─────────────────────────────────────────────────
  /** GET /api/providers — list (admin). */
  listProviders(): Promise<Provider[]> {
    return apiGet("/providers");
  }

  /** POST /api/providers — add a provider (admin). */
  addProvider(
    body: {
      type: string;
      base_url: string;
      api_key: string;
      display_name?: string | null;
    },
    opts: { allowLocal?: boolean } = {},
  ): Promise<{ id: UUID; type: string; base_url: string; display_name: string | null }> {
    const q = opts.allowLocal ? "?allow_local=1" : "";
    return apiPost(`/providers${q}`, body);
  }

  /** DELETE /api/providers/:id — cascade delete (admin). */
  deleteProvider(id: UUID): Promise<{ ok: true; models_removed?: number }> {
    return apiDelete(`/providers/${id}`);
  }

  /** PUT /api/providers/:id/key — rotate the API key (admin). */
  rotateProviderKey(id: UUID, body: { api_key: string }): Promise<{ ok: true }> {
    return apiPut(`/providers/${id}/key`, body);
  }

  /** POST /api/providers/:id/test — reachability probe (admin). */
  testProvider(
    id: UUID,
    opts: { allowLocal?: boolean } = {},
  ): Promise<{
    ok: boolean;
    latency_ms: number;
    upstream_status: string;
    models_seen?: number;
    sample?: string[];
    error?: string;
  }> {
    const q = opts.allowLocal ? "?allow_local=1" : "";
    return apiPost(`/providers/${id}/test${q}`);
  }

  /** POST /api/providers/:id/fetch — sync upstream /models (admin). */
  fetchProviderModels(
    id: UUID,
    opts: { allowLocal?: boolean } = {},
  ): Promise<{ ok: true; added: number; updated: number; total: number }> {
    const q = opts.allowLocal ? "?allow_local=1" : "";
    return apiPost(`/providers/${id}/fetch${q}`);
  }

  // ───── Models ────────────────────────────────────────────────────
  /** GET /api/models — per-user model list. */
  listModels(): Promise<Model[]> {
    return apiGet("/models");
  }

  // ───── Chat ──────────────────────────────────────────────────────
  /**
   * POST /api/chat — streaming chat reply (text/event-stream).
   * The returned response is the raw `Response` because the standard
   * JSON parser cannot parse SSE; consumers should iterate
   * `response.body` themselves. Use the existing `fetch + SSE
   * reader` pattern in pages/Chat.tsx for the user-facing flow.
   */
  chat(body: {
    model_id: UUID;
    content: string;
    system?: string;
    force_web_search?: boolean;
    url?: string;
    harness?: HarnessKind;
  }): Promise<Response> {
    return fetch("/api/chat", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** GET /api/chat/threads/:id — every message for a model thread. */
  chatThread(modelId: UUID): Promise<ChatMessage[]> {
    return apiGet(`/chat/threads/${modelId}`);
  }

  // ───── Feedback ──────────────────────────────────────────────────
  /** GET /api/feedback/stats — admin aggregate. */
  feedbackStats(): Promise<FeedbackStats> {
    return apiGet("/feedback/stats");
  }

  /** POST /api/feedback/recompute-profile — admin trigger. */
  feedbackRecomputeProfile(body: { user_id?: UUID } = {}): Promise<{
    updated: number;
    preferences?: unknown;
  }> {
    return apiPost("/feedback/recompute-profile", body);
  }

  // ───── CSP report (no auth) ──────────────────────────────────────
  /** GET /api/csp-report — diagnostic GET that returns 200. */
  cspReportPing(): Promise<{ ok: true }> {
    return apiGet("/csp-report");
  }

  /** POST /api/csp-report — browsers post the violation here. */
  cspReport(body: { "csp-report"?: Record<string, unknown> }): Promise<null> {
    return apiPost("/csp-report", body) as unknown as Promise<null>;
  }

  // ───── Audit activity ────────────────────────────────────────────
  /** GET /api/audit/activity — admin audit log. */
  auditActivity(opts: { limit?: number; offset?: number; action?: string } = {}): Promise<AuditActivity> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.action) params.set("action", opts.action);
    const q = params.toString();
    return apiGet(`/audit/activity${q ? `?${q}` : ""}`);
  }
}

// Singleton instance mirrors the existing `apiGet`/`apiPost` pattern
// — no internal state, just a friendly surface for the few callers
// that want the typed wrapper.
export const openapi = new OpenApiClient();
