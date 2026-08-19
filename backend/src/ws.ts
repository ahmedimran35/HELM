// WebSocket layer for panel multiplayer chat (docs §2.3).
//
// Path: ws://<host>/api/ws/panels/:id
// Protocol: every frame is a JSON object.
//
// Client → server frames:
//   { type: "send", content: string,
//     mentioned_model_id?: string,
//     force_web_search?: boolean }         — post a message; agent replies
//   { type: "presence", status?: "viewing"|"typing"|"idle",
//     cursor_block?: string | null }       — heartbeat
//   { type: "ping" }                       — keepalive; no-op reply
//
// Server → client frames:
//   { type: "ready", panelId, userId, name }
//   { type: "message", id, role, content, senderName?, createdAt }
//   { type: "typing", userId }
//   { type: "token", delta }                — agent reply streaming
//   { type: "done", promptTokens, completionTokens }
//   { type: "error", message }
//
// Auth: the upgrade request carries the helm_sid cookie. We resolve it
// to a user + panel-membership check before accepting the connection.
// Origin is also checked against WEB_ORIGIN to reject cross-site WS
// hijacks (mirrors the originGuard behaviour from middleware/security-headers.ts).

import { sql } from "./db/client.ts";
import { buildAdapter, getProviderById } from "./providers/registry.ts";
import { logAudit } from "./lib/audit.ts";
import { logSecurityEvent } from "./lib/security-events.ts";
import { retrieveForPanel, formatContext } from "./lib/retrieve.ts";
import { enforceUserMessageQuota } from "./routes/chat.ts";
import {
  setPresence,
  clearPresence,
  getPresence,
  DEFAULT_STALE_MS,
  type PresenceStatus,
} from "./lib/presence.ts";
import { takePanelSnapshot } from "./lib/snapshots.ts";
import { config } from "./config.ts";
import { parseSessionCookie } from "./middleware/auth.ts";

export interface PanelSocketData {
  panelId: string;
  userId: string;
  username: string;
  name: string;
  role: "admin" | "user";
}

const sockets = new Map<string, Set<PanelSocketData>>(); // panelId -> set

// Allowed presence statuses — match the SQL enum + presence lib. Anything
// else is silently dropped by the message handler.
const ALLOWED_PRESENCE_STATUSES: PresenceStatus[] = ["viewing", "typing", "idle"];

/**
 * Hand-rolled schema validator for inbound WS frames. Returns the
 * validated shape on success, or null when the frame doesn't match the
 * documented contract. Hand-rolled (not Zod) to keep the WS layer free
 * of new runtime deps — the surface area is small and stable.
 */
type ValidatedFrame =
  | {
      type: "send";
      content: string;
      mentioned_model_id: string | null;
      force_web_search: boolean | null;
    }
  | {
      type: "presence";
      status: PresenceStatus;
      cursor_block: string | null;
    }
  | { type: "ping" };

function validateInboundFrame(raw: unknown): ValidatedFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const t = obj.type;
  if (typeof t !== "string") return null;
  switch (t) {
    case "ping":
      return { type: "ping" };
    case "send": {
      // content must be a non-empty string
      if (typeof obj.content !== "string") return null;
      const mentioned_model_id =
        typeof obj.mentioned_model_id === "string" ? obj.mentioned_model_id : null;
      const fws = obj.force_web_search;
      const force_web_search =
        fws === true ? true : fws === false ? false : null;
      return {
        type: "send",
        content: obj.content,
        mentioned_model_id,
        force_web_search,
      };
    }
    case "presence": {
      const rawStatus = obj.status;
      const status =
        typeof rawStatus === "string" &&
        (ALLOWED_PRESENCE_STATUSES as string[]).includes(rawStatus)
          ? (rawStatus as PresenceStatus)
          : "viewing";
      const cursor_block =
        typeof obj.cursor_block === "string" ? obj.cursor_block : null;
      return { type: "presence", status, cursor_block };
    }
    default:
      // Unknown frame type — reject so a hostile client can't probe the
      // server's behaviour or inject arbitrary fields the handler reads.
      return null;
  }
}

function joinPanel(panelId: string, ws: PanelSocketData) {
  if (!sockets.has(panelId)) sockets.set(panelId, new Set());
  sockets.get(panelId)!.add(ws);
}
function leavePanel(panelId: string, ws: PanelSocketData) {
  sockets.get(panelId)?.delete(ws);
  // Drain pending broadcast batches and drop the timer if the panel
  // went empty. Prevents accumulating Timers for chatty users who
  // disconnect rapidly.
  if (sockets.get(panelId)?.size === 0) {
    drainPanelBatches(panelId);
    sockets.delete(panelId);
  }
}
// Per-panel batched broadcast. We coalesce messages within a 30 ms
// window so a rapid `token` + `done` pair (or two `presence_update`
// events firing back-to-back) goes out as a single frame instead of
// two. Effect: WS frame count drops ~50% on hot panels, and the
// browser renders the final state more cleanly because the
// `event-loop` decides the boundary.
const batchQueues = new Map<string, string[]>();
const batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const BATCH_WINDOW_MS = 30;
function flushPanel(panelId: string) {
  const queue = batchQueues.get(panelId);
  batchQueues.delete(panelId);
  batchTimers.delete(panelId);
  if (!queue || queue.length === 0) return;
  const set = sockets.get(panelId);
  if (!set) return;
  // For multi-message flushes, wrap with a single outer envelope so
  // the client sees one frame. The wrapper is a JSON array which
  // the existing single-frame-fast-path doesn't care about.
  const frame = queue.length === 1 ? queue[0]! : JSON.stringify(queue);
  for (const peer of set) {
    try {
      (peer as PanelSocketData & { _raw?: { send: (d: string) => void } })._raw?.send(frame);
    } catch {
      /* ignore dead sockets */
    }
  }
}

export function broadcast(panelId: string, msg: unknown) {
  // Critical synchronous events (ready, error, done) flush immediately
  // — they need to be visible to the client ASAP. Token + presence
  // updates can coalesce.
  const t = (msg as { type?: string } | null)?.type;
  const immediate = t === "ready" || t === "error" || t === "done" || t === "cached";
  if (immediate) {
    const set = sockets.get(panelId);
    if (!set) return;
    const payload = JSON.stringify(msg);
    for (const peer of set) {
      try {
        (peer as PanelSocketData & { _raw?: { send: (d: string) => void } })._raw?.send(payload);
      } catch {
        /* ignore dead sockets */
      }
    }
    return;
  }

  // Batched path — enqueue + flush on a 30 ms timer.
  let queue = batchQueues.get(panelId);
  if (!queue) {
    queue = [];
    batchQueues.set(panelId, queue);
  }
  queue.push(JSON.stringify(msg));
  if (!batchTimers.has(panelId)) {
    batchTimers.set(
      panelId,
      setTimeout(() => flushPanel(panelId), BATCH_WINDOW_MS),
    );
  }
}

/** Drain all pending batches. Called when the panel goes empty
 *  (last peer left) so we don't leak timer handles. */
function drainPanelBatches(panelId: string) {
  const timer = batchTimers.get(panelId);
  if (timer) {
    clearTimeout(timer);
    batchTimers.delete(panelId);
  }
  batchQueues.delete(panelId);
}

// Convenience: when presence changes, push the fresh map to everyone in
// the panel room. The presence table is the source of truth; this reads
// it through `getPresence` and ships the array. Cheap because the
// panel usually has a handful of members online at once.
async function broadcastPresence(panelId: string): Promise<void> {
  try {
    const list = await getPresence(panelId);
    broadcast(panelId, { type: "presence_update", panel_id: panelId, users: list });
  } catch (err) {
    console.warn("broadcastPresence failed:", (err as Error).message);
  }
}

async function authFromRequest(req: Request): Promise<PanelSocketData | null> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const panelId = parts[parts.length - 1] ?? "";
  // CSRF defense: reject cross-origin WebSocket upgrades. Browsers
  // include an Origin header for cross-site ws://...; same-origin
  // requests omit it. Anything else is rejected — mirrors the
  // originGuard behaviour in middleware/security-headers.ts so the
  // SPA and the WS upgrade agree on what counts as a trusted origin.
  const origin = req.headers.get("origin");
  if (origin) {
    const expected = (config.web.origin ?? process.env.WEB_ORIGIN ?? "").replace(/\/$/, "");
    if (expected && origin !== expected) {
      console.warn(`ws upgrade rejected: bad origin=${origin}`);
      return null;
    }
  }
  // Reuse the cookie parser from the HTTP auth middleware so the WS
  // upgrade honours the exact same `helm_sid` (with or without
  // `__Host-` prefix) as the REST routes. parseSessionCookie returns
  // null when the cookie is missing or malformed — we treat that the
  // same as an expired/invalid session.
  const sessionId = parseSessionCookie(req.headers.get("cookie") ?? "");
  if (!sessionId) return null;
  const { findSession, loadUserForSession } = await import("./auth/session.ts");
  const session = await findSession(sessionId);
  if (!session) return null;
  const user = await loadUserForSession(sessionId);
  if (!user) return null;
  if (!user.is_active) {
    console.warn(`ws upgrade rejected: inactive user=${user.username}`);
    return null;
  }
  if (user.role !== "admin") {
    const member = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${panelId}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!member[0]) return null;
  }
  const panel = await sql<{ id: string }[]>`
    SELECT id FROM panels WHERE id = ${panelId}::uuid LIMIT 1
  `;
  if (!panel[0]) return null;
  // Session-hijack heuristic: if the session row has a recorded
  // originating IP and the current connection's peer IP differs, log
  // a `session_hijack_suspect` event. We don't reject the upgrade —
  // the user might be on a mobile network that NATs them, and a
  // false positive would brick legitimate users. We DO alert so the
  // operator can investigate (revoke + force password change).
  let ipForEvent: string | null = null;
  try {
    const ipRows = await sql<{ ip: string | null }[]>`
      SELECT ip FROM sessions WHERE id = ${sessionId} LIMIT 1
    `;
    const storedIp = ipRows[0]?.ip ?? null;
    if (storedIp) {
      const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
      const xff = req.headers.get("x-forwarded-for");
      let currentIp: string | null = null;
      if (trustProxy && xff) {
        const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
        currentIp = hops[hops.length - 1] ?? null;
      } else {
        // The Bun server doesn't expose the peer IP directly on a
        // Request; the proxy / TLS terminator is expected to set it
        // via cf-connecting-ip or x-real-ip when we don't trust XFF.
        const cf = req.headers.get("cf-connecting-ip");
        const xr = req.headers.get("x-real-ip");
        currentIp = cf?.trim() || xr?.trim() || null;
      }
      ipForEvent = currentIp;
      if (currentIp && currentIp !== storedIp) {
        logSecurityEvent({
          type: "session_hijack_suspect",
          severity: "critical",
          userId: user.id,
          ip: currentIp,
          route: "ws.upgrade",
          details: {
            session_id: sessionId,
            stored_ip: storedIp,
            current_ip: currentIp,
            username: user.username,
          },
          ts: Date.now(),
        });
      }
    }
  } catch (err) {
    console.warn("session IP check failed:", (err as Error).message);
  }
  return {
    panelId,
    userId: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
  };
}

export async function handlePanelUpgrade(req: Request, server: any): Promise<Response> {
  const ctx = await authFromRequest(req);
  if (!ctx) {
    return new Response("forbidden", { status: 403 });
  }
  // Bun returns undefined from server.upgrade() on success.
  const upgraded = server.upgrade(req, { data: ctx });
  if (upgraded) {
    return undefined as unknown as Response;
  }
  return new Response("upgrade failed", { status: 500 });
}

// Bun-style handler hooks — wired from index.ts so the websocket
// events fire on the ServerWebSocket object directly.
export const panelWS = {
  async open(ws: any) {
    const data = ws.data as PanelSocketData;
    joinPanel(data.panelId, data);
    // Stash a back-reference so broadcast() can reach this peer.
    (data as any)._raw = ws;
    // Mark this user as "viewing" the panel and tell the room. Doing
    // it on open means every other connected client immediately sees
    // a fresh presence dot in the header / member stack.
    try {
      await setPresence(data.panelId, data.userId, "viewing", null);
      await broadcastPresence(data.panelId);
    } catch (err) {
      console.warn("presence open failed:", (err as Error).message);
    }
    ws.send(JSON.stringify({ type: "ready", panelId: data.panelId, name: data.name }));
  },
  async close(ws: any) {
    const data = ws.data as PanelSocketData;
    leavePanel(data.panelId, data);
    // Only remove the presence row when the LAST socket for this user
    // closes. A single user can have multiple tabs open; we don't want
    // the dot to flicker every time one of them reloads.
    const room = sockets.get(data.panelId);
    const stillHere = room && Array.from(room).some(
      (p) => (p as PanelSocketData).userId === data.userId,
    );
    if (!stillHere) {
      try {
        await clearPresence(data.panelId, data.userId);
        await broadcastPresence(data.panelId);
      } catch (err) {
        console.warn("presence close failed:", (err as Error).message);
      }
    }
  },
  async message(ws: any, raw: string | Buffer) {
    const data = ws.data as PanelSocketData;
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    // Schema validation — any frame that doesn't match the documented
    // contract is silently dropped. This blocks hostile frames from
    // reaching downstream code paths that assume typed fields exist.
    const msg = validateInboundFrame(parsed);
    if (!msg) return;

    // Keepalive — no-op. Lets the client detect dead sockets without
    // touching the DB.
    if (msg.type === "ping") return;

    // Presence frames — fire-and-forget heartbeats so the panel UI
    // shows who's reading / typing right now. Valid statuses are
    // enforced by the schema above; anything else is rejected before
    // we ever touch setPresence.
    if (msg.type === "presence") {
      try {
        await setPresence(data.panelId, data.userId, msg.status, msg.cursor_block);
        await broadcastPresence(data.panelId);
      } catch (err) {
        console.warn("presence update failed:", (err as Error).message);
      }
      return;
    }

    if (msg.type !== "send") return;
    const content = msg.content.trim();
    // msg.force_web_search === null means "use the user's default
    // posture" (admin always searches, others follow tool_posture).
    const forceWebSearch = msg.force_web_search === true;
    if (content.length === 0) return;

    // Quota guard — without this check, the WS handler would let a user
    // who has exhausted their HTTP /api/chat budget keep generating
    // billable LLM calls + audit_log rows + 1:1-thread entries via
    // the panel WS. We delegate to the same path the HTTP /api/chat
    // route uses so the budget is shared across both surfaces.
    const quotaCheck = await enforceUserMessageQuota(data.userId, content, {
      panelId: data.panelId,
    });
    if (!quotaCheck.ok) {
      ws.send(JSON.stringify({
        type: "error",
        message: quotaCheck.reason ?? "quota exceeded",
      }));
      return;
    }

    // Resolve @-mention. The client may pass an explicit mentioned_model_id
    // (resolved by the @-picker) or it may be embedded as `@<external_id>` at
    // any position in the message (start of message, or after whitespace).
    // Whichever wins, we route the reply to that model instead of the panel
    // default.
    let mentionedModelId: string | null = msg.mentioned_model_id ?? null;

    // Match an @-token anywhere at the START of the message or after
    // whitespace, optionally followed by a space and the rest of the
    // message. Captures: full prefix, the @-token.
    const mentionMatch = content.match(/(^|\s)@([A-Za-z0-9._/-]{2,80})(?:\s|$)/);
    if (mentionMatch) {
      const mentionToken = mentionMatch[2]!;
      const found = await sql<{ id: string; display_name: string; external_id: string }[]>`
        SELECT id, display_name, external_id FROM models
        WHERE external_id = ${mentionToken}
           OR display_name = ${mentionToken}
           OR LOWER(display_name) = LOWER(${mentionToken})
        LIMIT 1
      `;
      if (found[0]) {
        // Don't override a model the client already picked.
        if (!mentionedModelId) mentionedModelId = found[0].id;
        // Authorization: admin always allowed; users must have access to
        // the mentioned model via model_access.
        if (data.role !== "admin") {
          const access = await sql<{ model_id: string }[]>`
            SELECT model_id FROM model_access
            WHERE user_id = ${data.userId}::uuid AND model_id = ${found[0].id}::uuid
            LIMIT 1
          `;
          if (!access[0]) {
            // User mentioned a model they can't access. Clear the
            // resolved id (so we fall back) AND the client-supplied id
            // (so we don't honour a forged one either).
            mentionedModelId = null;
          } else if (!msg.mentioned_model_id) {
            mentionedModelId = found[0].id;
          }
        }
      }
    }

    // Persist user message. The quota helper above already inserted the
    // row (so it can count it atomically). Look it up to get the id.
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM messages
      WHERE panel_id = ${data.panelId}::uuid
        AND user_id = ${data.userId}::uuid
        AND role = 'user'
        AND content = ${content}
      ORDER BY created_at DESC LIMIT 1
    `;
    const userMsgId = rows[0]?.id ?? "";
    broadcast(data.panelId, {
      type: "message",
      id: userMsgId,
      role: "user",
      content,
      senderName: data.name,
      createdAt: new Date().toISOString(),
    });
    await logAudit({
      userId: data.userId,
      target: data.panelId,
      action: "panel_user_message",
      metadata: mentionedModelId ? { mentioned_model_id: mentionedModelId } : undefined,
    });

    broadcast(data.panelId, { type: "typing", userId: data.userId });

    // Look up panel's agent model + persona.
    const panelRows = await sql<{
      agent_model_id: string | null;
      persona_id: string | null;
    }[]>`
      SELECT agent_model_id, persona_id FROM panels WHERE id = ${data.panelId}::uuid LIMIT 1
    `;
    const panel = panelRows[0];
    // Multiplayer chat behaviour: if the user didn't @mention a model,
    // just broadcast the human message and return — no AI reply. This
    // makes panels work as proper multiplayer threads where humans can
    // talk to each other without the agent responding to every line.
    // Defence-in-depth: also require the actual content to contain
    // a valid @-token that we can resolve — the frontend may have a
    // stale model_id from a previous mention.
    const contentMentionsModel =
      !!mentionMatch &&
      !!mentionMatch[2] &&
      !!panel &&
      mentionedModelId !== null;
    if (!mentionedModelId || !contentMentionsModel) {
      // Clear the typing indicator on every connected client so the UI
      // doesn't get stuck on "thinking…" forever.
      broadcast(data.panelId, { type: "done", completionTokens: 0 });
      return;
    }
    // User @mentioned a model but we couldn't resolve one. Two cases:
    //  1. They @-mentioned a model that doesn't exist → tell them.
    //  2. They @-mentioned a model but have no access to it → silent
    //     (don't reveal model existence to non-admins).
    if (!mentionedModelId) {
      const panelHasAgent = !!panel?.agent_model_id;
      if (mentionMatch && !panelHasAgent) {
        const msg =
          "couldn't find that model — check the spelling, or set a default agent in panel settings";
        broadcast(data.panelId, { type: "error", message: msg });
        ws.send(JSON.stringify({ type: "error", message: msg }));
      }
      return;
    }
    // Resolve which model to use: the @mention takes precedence;
    // otherwise fall back to the panel's default agent model.
    const targetModelId = mentionedModelId ?? panel?.agent_model_id ?? null;
    if (!targetModelId) {
      const msg = "no model resolved — panel has no default agent and no @-mention matched";
      const eRows = await sql<{ id: string }[]>`
        INSERT INTO messages (panel_id, model_id, role, content, tokens)
        VALUES (${data.panelId}::uuid, NULL, 'assistant', ${`⚠ ${msg}`}, 0)
        RETURNING id
      `;
      broadcast(data.panelId, {
        type: "message",
        id: eRows[0]!.id,
        role: "assistant",
        content: `⚠ ${msg}`,
        senderName: "system",
        modelId: null,
        modelName: "system",
        createdAt: new Date().toISOString(),
      });
      broadcast(data.panelId, { type: "error", message: msg });
      ws.send(JSON.stringify({ type: "error", message: msg }));
      return;
    }
    const modelRows = await sql<{
      id: string;
      external_id: string;
      display_name: string;
      provider_id: string;
    }[]>`
      SELECT id, external_id, display_name, provider_id
      FROM models WHERE id = ${targetModelId}::uuid LIMIT 1
    `;
    const model = modelRows[0];
    if (!model) {
      const msg = "mentioned model is missing or not yet provisioned";
      const eRows = await sql<{ id: string }[]>`
        INSERT INTO messages (panel_id, model_id, role, content, tokens)
        VALUES (${data.panelId}::uuid, NULL, 'assistant', ${`⚠ ${msg}`}, 0)
        RETURNING id
      `;
      broadcast(data.panelId, {
        type: "message",
        id: eRows[0]!.id,
        role: "assistant",
        content: `⚠ ${msg}`,
        senderName: "system",
        modelId: null,
        modelName: "system",
        createdAt: new Date().toISOString(),
      });
      broadcast(data.panelId, { type: "error", message: msg });
      ws.send(JSON.stringify({ type: "error", message: msg }));
      return;
    }
    const provider = await getProviderById(model.provider_id);
    if (!provider) {
      const msg = "provider missing — re-add it under Providers";
      const eRows = await sql<{ id: string }[]>`
        INSERT INTO messages (panel_id, model_id, role, content, tokens)
        VALUES (${data.panelId}::uuid, NULL, 'assistant', ${`⚠ ${msg}`}, 0)
        RETURNING id
      `;
      broadcast(data.panelId, {
        type: "message",
        id: eRows[0]!.id,
        role: "assistant",
        content: `⚠ ${msg}`,
        senderName: "system",
        modelId: null,
        modelName: "system",
        createdAt: new Date().toISOString(),
      });
      broadcast(data.panelId, { type: "error", message: msg });
      ws.send(JSON.stringify({ type: "error", message: msg }));
      return;
    }
    const adapter = await buildAdapter(provider);

    let systemPrompt: string | undefined;
    if (panel?.persona_id) {
      const pe = await sql<{ system_prompt: string }[]>`
        SELECT system_prompt FROM personas WHERE id = ${panel.persona_id}::uuid LIMIT 1
      `;
      systemPrompt = pe[0]?.system_prompt || undefined;
    }

    // Retrieve relevant panel knowledge via full-text search on the
    // most recent user message (the one that triggered this turn).
    const retrieved = await retrieveForPanel(data.panelId, content, 4);
    let retrievedContext = formatContext(retrieved);
    // Inject the user's memory (personal + team-visible) into the
    // panel context. Lightweight: one SQL query, recent 50 entries.
    const { buildMemoryContext } = await import("./routes/workspace.ts");
    const memCtx = await buildMemoryContext({ id: data.userId, role: data.role });
    if (memCtx) retrievedContext += (retrievedContext ? "\n\n" : "") + memCtx;

    // Real-time web search — runs when:
    //   - the user has force_web_search=true in the WS frame, OR
    //   - the user's posture for the tool is "auto", OR
    //   - the caller is admin.
    // Mirrors the chat route's flow so panels also get fresh data.
    const postureRows = await sql<{ posture: string }[]>`
      SELECT posture FROM tool_posture
      WHERE user_id = ${data.userId}::uuid AND tool_name = 'web_search' LIMIT 1
    `;
    const webSearchPosture = postureRows[0]?.posture ?? "auto";
    // Three-way branch so the per-message toggle actually means what
    // it says — mirrors backend/src/routes/chat.ts.
    //   force_web_search === true  → always search
    //   force_web_search === false → never search (admin override off too)
    //   undefined                  → default: admin always, otherwise posture
    const forceWebSearchOff = msg.force_web_search === false;
    let shouldSearch: boolean;
    if (forceWebSearch) {
      shouldSearch = true;
    } else if (forceWebSearchOff) {
      shouldSearch = false;
    } else {
      shouldSearch = data.role === "admin" || webSearchPosture === "auto";
    }
    // Track search results so we can auto-inject a Sources section
    // after the model stream ends (mirrors chat.ts).
    const searchSources: Array<{ title: string; url: string }> = [];
    let searchSummary: { service: string; result_count: number; has_answer: boolean } | null = null;
    if (shouldSearch) {
      try {
        const { callLightpanda } = await import("./lib/chat_search.ts");
        const configured = await sql<{ service: string }[]>`
          SELECT service FROM web_search_keys WHERE connected = TRUE LIMIT 1
        `;
        const searchResponse = await callLightpanda(
          "lightpanda",
          "",
          content,
          8,
          {},
        );
        if (searchResponse) {
          for (const r of searchResponse.results) {
            searchSources.push({ title: r.title, url: r.url });
          }
          searchSummary = {
            service: configured[0]?.service ?? "lightpanda",
            result_count: searchResponse.results.length,
            has_answer: !!searchResponse.answer,
          };
          const ctx =
            "Web search results:\n" +
            searchResponse.results
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet ?? "").slice(0, 240)}`,
              )
              .join("\n\n") +
            (searchResponse.answer ? `\n\nDirect answer: ${searchResponse.answer}` : "");
          retrievedContext += (retrievedContext ? "\n\n" : "") + ctx;
          await logAudit({
            userId: data.userId,
            target: data.panelId,
            action: forceWebSearch ? "panel_web_search_forced" : "panel_web_search_auto",
            metadata: {
              query: content,
              intent: searchResponse.intent ?? "general",
              result_count: searchResponse.results.length,
            },
          });
          // Send a "search" event so the chat UI can show the banner.
          try {
            ws.send(JSON.stringify({
              type: "search",
              service: searchSummary.service,
              result_count: searchSummary.result_count,
              has_answer: searchSummary.has_answer,
            }));
          } catch { /* ignore */ }
        }
      } catch {
        // Auto-search failures are non-fatal — we just skip the boost.
      }
    }

    // Detect query intent and count for list queries, then build an
    // intent-aware system override. Same as chat.ts.
    const { extractListCount, classifyQuery } = await import("./lib/web_search.ts");
    const requestedN = extractListCount(content);
    const intent = classifyQuery(content);
    if (retrievedContext) {
      const prefix = systemPrompt ? `${systemPrompt}\n\n` : "";

      let intentRule: string;
      if (requestedN) {
        intentRule = `The user explicitly asked for ${requestedN} items. You MUST produce exactly ${requestedN} entries — pick the best ${requestedN} from the search results, mixing regional and broader results if needed; never reply with fewer than ${requestedN} by saying "the search only returned X". Never split one article into multiple items to fill the count — each item must be a distinct source.`;
      } else if (intent === "comparison") {
        intentRule = `The user is asking for a comparison. Produce a side-by-side comparison table or two clearly labelled sections (one per subject) with the key differences called out. Use the search results for both subjects.`;
      } else if (intent === "howto") {
        intentRule = `The user is asking how or why something works. Give a clear step-by-step explanation with concrete examples. If the search results cover the topic, build your explanation on those; otherwise supplement with your own knowledge but flag anything that isn't from the sources.`;
      } else if (intent === "creative") {
        intentRule = `The user wants creative output (a write, draft, or composition). The search results are background context, not the main content. Produce the requested creative output directly; cite sources only if you actually used specific facts from them.`;
      } else if (intent === "factual") {
        intentRule = `The user is asking a factual question. Give a concise, direct answer (one short paragraph). Always cite the source so the user can verify. If the search returned multiple sources, cross-check them and prefer the most authoritative (Wikipedia > news > blogs).`;
      } else if (intent === "news") {
        intentRule = `The user is asking about recent news / current events. For "top N" questions produce a numbered list of N distinct items, each starting with **bold headline**. For "what's happening with X" give a 2–4 sentence summary with the most recent timestamped facts.`;
      } else {
        intentRule = `Answer the user's question directly using the search results as primary evidence. If the search results don't fully cover the question, supplement from your training data but flag anything not from the sources.`;
      }

      systemPrompt =
        `${prefix}` +
        `[SYSTEM OVERRIDE — live-web search is on]\n` +
        `A real-time web search was performed on the panel's question and the most current, on-topic results are below.\n\n` +
        `**MEMORY PRIORITY**: the user/team memory entries in the "Known context" section below are AUTHORITATIVE for this project. If the memory says "we use X", the project uses X — even if web search results describe a different X. Web search is general world knowledge; the memory describes THIS user's project.\n\n` +
        `Detected query intent: ${intent}. ${intentRule}\n\n` +
        `Formatting rules (always follow):\n` +
        `1. Start with a markdown heading (## or ###) for the answer topic.\n` +
        `2. One bold (**...**) lead sentence that directly answers the question.\n` +
        `3. Use bullet/numbered lists, tables, or short paragraphs as fits the intent. Use \`code\` for technical terms.\n` +
        `4. For lists, each item must reference a distinct source URL — never split one article into multiple items.\n` +
        `5. End the reply with a "## Sources" heading listing every URL you cited, one bullet per source in the form: - [descriptive title](https://full.url).\n` +
        `6. If the search returned nothing useful, the Sources section must contain exactly: "no fresh web results available".\n` +
        `Do not mention "training data" in your reply. Render the reply as proper markdown — never output raw asterisks for emphasis.\n\n` +
        `${retrievedContext}`;
    } else if (systemPrompt) {
      // keep base prompt
    } else {
      systemPrompt = "";
    }

    const history = await sql<{ role: string; content: string }[]>`
      SELECT role, content FROM messages
      WHERE panel_id = ${data.panelId}::uuid
      ORDER BY created_at DESC LIMIT 50
    `;
    history.reverse();

    try {
      let assembled = "";
      let completionTokens = 0;
      for await (const chunk of adapter.chat({
        model: model.external_id,
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          ...history.map((h) => ({
            role: h.role as "user" | "assistant",
            content: h.content,
          })),
        ],
      })) {
        if (chunk.done) {
          completionTokens = chunk.completionTokens ?? Math.ceil(assembled.length / 4);
          break;
        }
        if (chunk.delta) {
          assembled += chunk.delta;
          broadcast(data.panelId, { type: "token", delta: chunk.delta });
        }
      }
      // Auto-append the full Sources list. Mirrors chat.ts — many
      // models emit the ## Sources heading but only cite a few URLs.
      // We dedupe against URLs already in the response and append
      // the rest so every real article the search found is cited.
      if (searchSources.length > 0) {
        const existing = new Set<string>();
        for (const m of assembled.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
          existing.add(m[1]!);
        }
        const missing = searchSources.filter((s) => !existing.has(s.url));
        if (missing.length > 0) {
          const bullets = missing.map((s) => `- [${s.title}](${s.url})`).join("\n");
          const hasHeading = /^##\s+Sources\s*$/im.test(assembled);
          const addition = hasHeading
            ? "\n" + bullets + "\n"
            : "\n\n## Sources\n" + bullets + "\n";
          assembled += addition;
          broadcast(data.panelId, { type: "token", delta: addition });
        }
      }
      const aRows = await sql<{ id: string }[]>`
        INSERT INTO messages (panel_id, model_id, role, content, tokens)
        VALUES (${data.panelId}::uuid, ${model.id}::uuid, 'assistant', ${assembled}, ${completionTokens})
        RETURNING id
      `;
      broadcast(data.panelId, {
        type: "message",
        id: aRows[0]!.id,
        role: "assistant",
        content: assembled,
        senderName: model.display_name,
        modelId: model.id,
        modelName: model.display_name,
        createdAt: new Date().toISOString(),
      });
      // Take a time-travel snapshot of the panel state at this turn.
      // The replay UI uses these to scrub / branch the conversation
      // from any assistant message. Best-effort — failure doesn't
      // block the chat response.
      try {
        await takePanelSnapshot({
          panelId: data.panelId,
          messageId: aRows[0]!.id,
          userId: data.userId,
        });
      } catch (err) {
        console.warn("snapshot failed:", (err as Error).message);
      }
      await logAudit({
        userId: data.userId,
        target: data.panelId,
        action: "panel_assistant_message",
        tokens: completionTokens,
        metadata: { model_id: model.id, model_name: model.display_name, mentioned: mentionedModelId !== null },
      });
      broadcast(data.panelId, {
        type: "done",
        completionTokens,
        modelId: model.id,
        modelName: model.display_name,
      });
    } catch (err) {
      const message = (err as Error).message || "model request failed";
      // Persist a synthetic assistant message so the error is visible in
      // the thread and doesn't leave the user staring at "thinking".
      const eRows = await sql<{ id: string }[]>`
        INSERT INTO messages (panel_id, model_id, role, content, tokens)
        VALUES (${data.panelId}::uuid, ${model?.id ?? null}::uuid, 'assistant',
                ${`⚠ model error: ${message.slice(0, 500)}`}, 0)
        RETURNING id
      `;
      broadcast(data.panelId, {
        type: "message",
        id: eRows[0]!.id,
        role: "assistant",
        content: `⚠ model error: ${message.slice(0, 500)}`,
        senderName: model?.display_name ?? "system",
        modelId: model?.id ?? null,
        modelName: model?.display_name ?? "system",
        createdAt: new Date().toISOString(),
      });
      broadcast(data.panelId, { type: "error", message });
      ws.send(JSON.stringify({ type: "error", message }));
    }
  },
};