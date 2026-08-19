// Chat — 1:1 streaming conversation (docs §2.2).
// v2 upgrades:
//   - Model list uses StatusPill (healthy/idle/pending) instead of a
//     custom ON/PEND/OFF badge.
//   - Each assistant message gets a meta row: latency, token count,
//     "searched via X" — when a search happened, a CitationCard renders
//     below the message body.
//   - "live web" toggle is icon-only with a clear on/off state.
//   - Empty thread uses the EmptyState illustration instead of plain
//     centered text.
//   - Tier 3 — Voice + Multimodal: input toolbar (voice · attach ·
//     browse · doc) plus attachment chips above the textarea. The
//     toolbar opens a SideSheet per capability; the resulting data
//     feeds into the next message.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiPost } from "../api/client";
import { openapi, type Model, type ChatMessage } from "../api/openapi";
import { listHarnesses, type HarnessInfo, type HarnessKind } from "../api/harness";
import { Button } from "../components/ui/Button";
import { TypingDots } from "../components/ui/TypingDots";
import { Avatar } from "../components/ui/Avatar";
import { Markdown } from "../components/ui/Markdown";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { CitationCard, type Citation } from "../components/ui/data/CitationCard";
import { safeWindowOpen, safeHref } from "../lib/safe-href";

// Tier 4 (Discovery): persistent citation row fetched from
// /api/messages/:id/citations. Mirrors the backend `citations` table.
export interface CitationLink {
  id: string;
  message_id: string;
  source_kind: "web" | "memory" | "panel" | "file" | "tool";
  source_ref: string;
  excerpt: string | null;
  created_at: string;
}
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { useToast } from "../components/ui/feedback/Toast";
import { FileDrop, type UploadedFile } from "../components/ui/data/FileDrop";
import { VoiceRecorder } from "../components/system/VoiceRecorder";
import { BrowserAutomation, type BrowserResult } from "../components/system/BrowserAutomation";
import {
  SearchIcon,
  ZapIcon,
  SendIcon,
  ClockIcon,
  CheckIcon,
  AlertTriangleIcon,
  PaperclipIcon,
  MicIcon,
  GlobeIcon,
  DocumentIcon,
  XIcon,
  DownloadIcon,
  RefreshIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface ModelRow extends Pick<Model, "id" | "display_name" | "external_id" | "assigned" | "pending_request"> {}

interface SearchMeta {
  service: string;
  result_count: number;
  cached: boolean;
  /** Sources pulled from the search response. */
  citations?: Citation[];
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  tokens?: number;
  created_at?: string;
  search?: SearchMeta;
  latency_ms?: number;
  /** Tier 4 (Discovery): lineage rows from the `citations` table, fetched
   *  on render. Empty when the message has no persistent citations. */
  lineage?: CitationLink[];
  /** Tier 5 — set when the response was served by the response_cache
   *  exact-match hit. The model field captures which model produced
   *  the cached reply so the badge can show provenance. */
  cached?: boolean;
  cachedModel?: string;
}

export function ChatPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveWeb, setLiveWeb] = useState(true);
  const [lastSearch, setLastSearch] = useState<SearchMeta | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // Pluggable harness (P2): list + active selection. The active
  // harness is sent with every chat request so the backend routes
  // through the right runtime. Default to 'openai' so legacy clients
  // keep working until they pick a different harness.
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [harness, setHarness] = useState<HarnessKind>("openai");
  // Tier 3 — Voice + Multimodal state. `attachments` are file blobs
  // uploaded via FileDrop; `pendingVoice` is set when the user records
  // audio but hasn't confirmed the send yet; `pendingBrowser` carries
  // the latest browser automation result so it can be appended to the
  // next message as context.
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [pendingVoice, setPendingVoice] = useState<string | null>(null);
  const [pendingBrowser, setPendingBrowser] = useState<BrowserResult | null>(null);
  const [showFileDrop, setShowFileDrop] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showDocGen, setShowDocGen] = useState(false);
  const [refreshMode, setRefreshMode] = useState(false);
  const [showAllHarnesses, setShowAllHarnesses] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendStartRef = useRef<number>(0);
  const streamMinUntilRef = useRef<number>(0);

  useEffect(() => {
    openapi.listModels().then((all) => {
      const m = all as unknown as ModelRow[];
      setModels(m);
      const firstAssigned = m.find((r) => r.assigned) ?? m[0] ?? null;
      if (firstAssigned) setActive(firstAssigned.id);
    });
  }, []);

  // Fetch the harness catalog once on mount. The backend never fails
  // this endpoint (an unknown harness just isn't in the list), so we
  // don't bother with a loading state.
  useEffect(() => {
    listHarnesses()
      .then((h) => {
        setHarnesses(h);
        // If a previously-selected harness disappeared, fall back to
        // openai so we always have a valid kind to send.
        if (!h.find((row) => row.kind === harness)) {
          setHarness("openai");
        }
      })
      .catch(() => {
        // Silent: keep the default 'openai' selection if the call fails.
      });
  }, []);

  useEffect(() => {
    if (!active || active === loadedFor) return;
    setMessages([]);
    setLoadedFor(active);
    openapi.chatThread(active)
      .then(async (rawRows) => {
        const rows = rawRows as unknown as Message[];
        // Tier 4 (Discovery) — fetch persistent citations for every
        // assistant turn in one sweep. Best-effort: any failure
        // leaves the lineage off but doesn't block rendering.
        for (const m of rows) {
          if (m.role !== "assistant" || !m.id) continue;
          try {
            const links = await apiGet<CitationLink[]>(
              `/chat/messages/${m.id}/citations`,
            );
            if (links.length > 0) m.lineage = links;
          } catch {
            // ignore
          }
        }
        setMessages(rows);
      })
      .catch(() => setMessages([]));
  }, [active, loadedFor]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Tier 5 — spend-cap warning banner. Polls /api/spend-caps every
  // 60s and renders an inline warning when any panel crosses its
  // configured threshold. Stays out of the way when there's nothing
  // to warn about.
  const [capBanner, setCapBanner] = useState<{
    panel_name: string;
    period: string;
    ratio: number;
    over_limit: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await apiGet<
          Array<{
            panel_name: string;
            period: string;
            ratio: number;
            over_warn: boolean;
            over_limit: boolean;
          }>
        >("/spend-caps");
        if (cancelled) return;
        const warn = rows.find((r) => r.over_warn);
        setCapBanner(
          warn
            ? {
                panel_name: warn.panel_name,
                period: warn.period,
                ratio: warn.ratio,
                over_limit: warn.over_limit,
              }
            : null,
        );
      } catch {
        /* silent */
      }
    }
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!user) return null;
  const activeModel = models.find((m) => m.id === active);

  async function requestAccess(modelId: string) {
    try {
      await apiPost("/access-requests", { model_id: modelId });
      const m = (await openapi.listModels()) as unknown as ModelRow[];
      setModels(m);
      toast.addToast({
        id: `chat-access-ok-${modelId}`,
        title: "Access requested",
        description: "An admin will review your request.",
        tone: "info",
        duration: 2500,
      });
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.addToast({
        id: `chat-access-err-${modelId}`,
        title: "Access request failed",
        description: msg,
        tone: "warning",
        duration: 4000,
      });
    }
  }

  async function send() {
    if (!active || streaming) return;
    // Compose the user-visible content. We append voice transcripts,
    // browser extracts, and file descriptions so the model sees the
    // multimodal context inline. The original typed text is always the
    // first line so the user can still quote exactly what they typed.
    const typed = input.trim();
    const voicePart = pendingVoice ? `\n[voice transcript]\n${pendingVoice}` : "";
    const attachParts: string[] = [];
    for (const a of attachments) {
      if (a.description) attachParts.push(`- ${a.name}: ${a.description}`);
      else attachParts.push(`- ${a.name} (${a.mime_type})`);
    }
    const attachBlock = attachParts.length
      ? `\n[attachments]\n${attachParts.join("\n")}`
      : "";
    const browserBlock = pendingBrowser
      ? `\n[browser result @ ${pendingBrowser.finalUrl}]\n` +
        `title: ${pendingBrowser.title}\n` +
        Object.entries(pendingBrowser.extracted)
          .map(([sel, vals]) => `${sel}: ${vals.join(" | ")}`)
          .join("\n")
      : "";
    const composed = [typed, voicePart, attachBlock, browserBlock]
      .filter(Boolean)
      .join("");
    if (!composed.trim()) return;
    const content = composed;
    setInput("");
    // Refresh-mode is per-message: stay in normal cache mode for the
    // next message after the user has explicitly bypassed once.
    setRefreshMode(false);
    setError(null);
    setAttachments([]);
    setPendingVoice(null);
    setPendingBrowser(null);
    setMessages((prev) => [...prev, { role: "user", content: typed }]);
    setStreaming(true);
    sendStartRef.current = Date.now();
    // Minimum visible-stream time so the typing dots always get a
    // chance to render even on a fast cache hit. Without this, a
    // cached response flips streaming→false in <50ms and the user
    // never sees the thinking animation. 800ms is enough for the
    // wave to make several full cycles so the user clearly sees
    // the rhythm.
    const minStreamMs = 800;
    streamMinUntilRef.current = Date.now() + minStreamMs;

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const url = refreshMode ? "/api/chat?refresh=1" : "/api/chat";
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: active,
          content,
          force_web_search: liveWeb,
          harness,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const msg = `request failed: ${res.status}`;
        setError(msg);
        toast.addToast({
          id: `chat-send-err-${Date.now()}`,
          title: "Send failed",
          description: msg,
          tone: "warning",
          duration: 4000,
        });
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let lastSearchMeta: SearchMeta | null = null;
      let tokens = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const ev = JSON.parse(payload);
              if (ev.cached) {
                // Mark the assistant message as coming from cache.
                // Tier 5 — response_cache surfaced an exact-match hit.
                setMessages((prev) => {
                  const next = prev.slice();
                  const last = next[next.length - 1];
                  if (last && last.role === "assistant") {
                    next[next.length - 1] = {
                      ...last,
                      cached: true,
                      cachedModel: ev.cached.model,
                    };
                  }
                  return next;
                });
              }
              if (ev.search) {
                lastSearchMeta = {
                  service: ev.search.service,
                  result_count: ev.search.result_count,
                  cached: ev.search.cached ?? false,
                };
                setLastSearch(lastSearchMeta);
              }
              if (typeof ev.prompt_tokens === "number") {
                tokens = ev.prompt_tokens + (ev.completion_tokens ?? tokens);
              }
              if (ev.delta !== undefined && ev.delta !== null) {
                setMessages((prev) => {
                  const next = prev.slice();
                  const last = next[next.length - 1];
                  if (last && last.role === "assistant") {
                    next[next.length - 1] = {
                      ...last,
                      content: last.content + ev.delta,
                      tokens,
                      latency_ms: Date.now() - sendStartRef.current,
                      search: lastSearchMeta ?? last.search,
                    };
                  }
                  return next;
                });
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = `stream interrupted: ${(err as Error).message ?? "unknown error"}`;
        setError(msg);
        toast.addToast({
          id: `chat-stream-err-${Date.now()}`,
          title: "Stream interrupted",
          description: msg,
          tone: "warning",
          duration: 4000,
        });
      }
    } finally {
      abortRef.current = null;
      // Defer setting streaming=false until the minimum visible time
      // so the typing dots always render at least once. Cache hits
      // resolve in <50ms; without this, the dots never animate.
      const remaining = streamMinUntilRef.current - Date.now();
      const cleanup = () => {
        setStreaming(false);
        // Broadcast the final token count so the per-turn cost chip in
        // the chat header can update (Tier 7 combo: cost router + chat).
        setMessages((cur) => {
          const last = cur[cur.length - 1];
          if (last && last.role === "assistant") {
            window.dispatchEvent(
              new CustomEvent("helm:turn-tokens", {
                detail: { tokens: last.tokens ?? 0 },
              }),
            );
          }
          return cur;
        });
      };
      if (remaining > 0) {
        setTimeout(cleanup, remaining);
      } else {
        cleanup();
      }
    }
  }

  return (
    <div className="h-full flex">
      {/* Left column: model list */}
      <aside className="w-[260px] shrink-0 border-r border-border bg-panel">
        <div className="px-3 py-2 border-b border-borderSoft flex items-center gap-2">
          <span className="mono-caps text-[10px] text-textMuted flex-1">Models</span>
          <span className="mono-caps text-[10px] text-textFaint tabular-nums">
            {models.filter((m) => m.assigned).length}/{models.length}
          </span>
        </div>
        {/* Harness pill row — P2 pluggable runtime selector. Shows the
            active harness and offers the configured ones as quick
            switches. By default we hide unconfigured harnesses (mock
            / pi / cli stubs) so the bar only shows real, usable
            providers. A small toggle reveals the full list for
            debugging. Selecting a harness re-routes every subsequent
            chat through that runtime on the backend. */}
        <div className="px-3 py-2 border-b border-borderSoft flex items-center gap-1.5 flex-wrap">
          <span className="mono-caps text-[10px] text-textFaint">harness</span>
          {harnesses.length === 0 && (
            <Badge tone="neutral">loading…</Badge>
          )}
          {harnesses
            .filter((h) => {
              // Mock is a fallback only — never user-selectable. The
              // "show all" toggle is the only way to see it.
              if (h.kind === "mock" && !showAllHarnesses) return false;
              return showAllHarnesses || h.configured;
            })
            .map((h) => {
            const isActive = h.kind === harness;
            const tone = !h.configured
              ? "rust"
              : isActive
              ? "brass"
              : "neutral";
            return (
              <button
                key={h.kind}
                type="button"
                onClick={() => h.configured && setHarness(h.kind)}
                disabled={!h.configured}
                title={
                  h.configured
                    ? `switch to ${h.label} (${h.model_count} models)`
                    : h.reason ?? "not configured"
                }
                className={cn(
                  "inline-flex items-center px-1.5 h-[18px] border transition-colors",
                  isActive
                    ? "border-brass/60 bg-brass/10"
                    : h.configured
                    ? "border-borderSoft hover:border-brass/40"
                    : "border-borderSoft opacity-60 cursor-not-allowed",
                )}
              >
                <Badge tone={tone}>{h.label}</Badge>
              </button>
            );
          })}
          {harnesses.some((h) => !h.configured) && (
            <button
              type="button"
              onClick={() => setShowAllHarnesses((v) => !v)}
              title={showAllHarnesses ? "hide unconfigured" : "show unconfigured"}
              className="inline-flex items-center px-1.5 h-[18px] border border-borderSoft text-textMuted hover:text-text"
            >
              <span className="mono-caps text-[10px]">
                {showAllHarnesses ? "−" : "+"}
                {harnesses.filter((h) => !h.configured).length}
              </span>
            </button>
          )}
        </div>
        <div className="py-1">
          {models.map((m) => {
            const isActive = m.id === active;
            const state = m.assigned
              ? "healthy"
              : m.pending_request
              ? "warming"
              : "idle";
            return (
              <button
                key={m.id}
                onClick={() => setActive(m.id)}
                aria-current={isActive}
                className={cn(
                  "w-full text-left px-3 py-2 border-l-2 transition-colors flex items-center gap-2",
                  isActive
                    ? "border-brass bg-panelAlt text-text"
                    : "border-transparent text-textMuted hover:bg-panelAlt/60 hover:text-text",
                )}
              >
                <StatusPill
                  state={state}
                  size="sm"
                  className="shrink-0"
                  label=""
                />
                <span className="font-mono text-[12px] truncate flex-1">
                  {m.display_name}
                </span>
              </button>
            );
          })}
          {user.role === "user" &&
            models.some((m) => !m.assigned && !m.pending_request) && (
              <div className="mt-4 mx-3 pt-3 border-t border-borderSoft">
                <div className="mono-caps text-[10px] text-textFaint mb-2">
                  request access
                </div>
                {models
                  .filter((m) => !m.assigned && !m.pending_request)
                  .map((m) => (
                    <button
                      key={`req-${m.id}`}
                      onClick={() => requestAccess(m.id)}
                      className="w-full flex items-center gap-2 text-left px-2 py-1.5 mb-1 border border-dashed border-borderSoft hover:border-brass hover:bg-brass/5 text-textMuted hover:text-brass transition-colors"
                    >
                      <span className="font-mono text-[11px] text-brass">+</span>
                      <span className="font-mono text-[11px] truncate flex-1">
                        {m.display_name}
                      </span>
                      <span className="font-mono text-[9px] text-textFaint">
                        request
                      </span>
                    </button>
                  ))}
              </div>
            )}
        </div>
      </aside>

      {/* Right column: thread */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-10 border-b border-border bg-bg flex items-center px-4 gap-3">
          {activeModel ? (
            <>
              <span className="font-mono text-[12px] text-text truncate">
                {activeModel.display_name}
              </span>
              <StatusPill state="healthy" size="sm" label="connected" />
              <TurnCostChip />
              {lastSearch && (
                <span className="mono-caps text-[10px] text-textFaint tracking-wider">
                  last: {lastSearch.service} · {lastSearch.result_count}
                </span>
              )}
            </>
          ) : (
            <span className="mono-caps text-[11px] text-textMuted">no model selected</span>
          )}
          <div className="ml-auto">
            <LiveWebToggle on={liveWeb} onToggle={() => setLiveWeb((v) => !v)} />
          </div>
        </div>

        {capBanner && (
          <div
            className={cn(
              "px-4 py-1.5 border-b text-[11px] mono-caps tracking-wider flex items-center gap-2",
              capBanner.over_limit
                ? "bg-rust/15 border-rust/40 text-rust"
                : "bg-amber/10 border-amber/40 text-amber",
            )}
            role="status"
          >
            <AlertTriangleIcon size={11} />
            <span>
              {capBanner.over_limit ? "over limit" : "approaching cap"} ·{" "}
              {capBanner.panel_name}
            </span>
            <span className="text-textMuted normal-case tracking-normal">
              · {(capBanner.ratio * 100).toFixed(0)}% of {capBanner.period} cap
            </span>
            <a
              href="/spend-caps"
              className="ml-auto underline-offset-2 hover:underline normal-case tracking-normal"
            >
              manage
            </a>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                variant="conversation"
                title={
                  activeModel
                    ? `Start a conversation with ${activeModel.display_name}`
                    : "Pick a model"
                }
                description={
                  activeModel
                    ? "Tokens stream in real time. Hit ⌘K to find another model or action without leaving the keyboard."
                    : "Choose a model from the left to begin."
                }
                tone="brass"
              />
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageBubble
                key={i}
                message={m}
                isLast={i === messages.length - 1}
                isStreaming={streaming}
                userName={user.name}
                modelName={activeModel?.display_name ?? "model"}
              />
            ))
          )}
        </div>

        {error && (
          <div className="mx-4 mb-2 mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
            {error}
          </div>
        )}

        <div className="border-t border-border bg-bg p-3">
          <InputToolbar
            onAttach={() => setShowFileDrop(true)}
            onVoice={() => setShowVoice(true)}
            onBrowse={() => setShowBrowser(true)}
            onDoc={() => setShowDocGen(true)}
            disabled={!activeModel || streaming}
            counts={{
              attachments: attachments.length,
              voice: pendingVoice ? 1 : 0,
              browser: pendingBrowser ? 1 : 0,
            }}
          />
          {(attachments.length > 0 || pendingVoice || pendingBrowser) && (
            <AttachmentChips
              attachments={attachments}
              onRemoveAttachment={(id) =>
                setAttachments((prev) => prev.filter((a) => a.id !== id))
              }
              voice={pendingVoice}
              onClearVoice={() => setPendingVoice(null)}
              browser={pendingBrowser}
              onClearBrowser={() => setPendingBrowser(null)}
            />
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={
                activeModel
                  ? `Message ${activeModel.display_name}…  ⏎ to send · ⇧⏎ for newline`
                  : "Pick a model first"
              }
              disabled={!activeModel || streaming}
              className="flex-1 bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[13px] resize-none focus:border-brass outline-none"
            />
            <Button
              variant={refreshMode ? "secondary" : "ghost"}
              onClick={() => setRefreshMode((v) => !v)}
              disabled={streaming}
              title={refreshMode ? "Next message bypasses cache" : "Click to bypass cache for next message"}
              className="gap-1.5"
            >
              <RefreshIcon size={12} />
            </Button>
            <Button
              variant="primary"
              onClick={send}
              disabled={
                !activeModel ||
                streaming ||
                (!input.trim() && attachments.length === 0 && !pendingVoice && !pendingBrowser)
              }
              className="gap-1.5"
            >
              {streaming ? (
                <TypingDots size="sm" />
              ) : (
                <SendIcon size={12} className="-rotate-12" />
              )}
              {streaming ? "Streaming" : "Send"}
            </Button>
          </div>
          {/* In-flight "thinking" pill — appears above the composer
              while the request is in flight. Visible for the full
              min-stream window so the user sees activity even on a
              cache hit that completes in <50ms. */}
          {streaming && (
            <div
              className="mt-2 flex items-center gap-2 border border-brass/40 bg-brass/10 px-3 py-2 text-[12px] text-brass"
              data-testid="thinking-pill"
            >
              <TypingDots size="sm" active />
              <span className="mono-caps tracking-wider">thinking</span>
              <span className="text-brass/60 ml-auto mono-caps text-[10px]">
                waiting for response
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Tier 3 — Voice + Multimodal overlays. */}
      <FileDrop
        open={showFileDrop}
        onClose={() => setShowFileDrop(false)}
        onUploaded={(f) => {
          setAttachments((prev) => {
            if (prev.find((p) => p.id === f.id)) return prev;
            return [...prev, f];
          });
          toast.addToast({
            id: `chat-attach-${f.id}`,
            title: `Attached ${f.name}`,
            description: f.description
              ? `described · ${f.description.slice(0, 60)}${f.description.length > 60 ? "…" : ""}`
              : `${(f.byte_size / 1024).toFixed(1)} KB`,
            tone: "success",
          });
        }}
      />
      <VoiceRecorder
        open={showVoice}
        onClose={() => setShowVoice(false)}
        onTranscript={(text) => {
          setPendingVoice(text);
          setShowVoice(false);
          toast.addToast({
            id: "chat-voice",
            title: "Voice transcript captured",
            description: `${text.length} chars · will be sent with your next message`,
            tone: "success",
          });
        }}
      />
      <BrowserAutomation
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        onResult={(r) => {
          setPendingBrowser(r);
          setShowBrowser(false);
          toast.addToast({
            id: "chat-browser",
            title: `Browser · ${r.title || r.finalUrl}`,
            description: `${(r.duration_ms / 1000).toFixed(1)}s · ${Object.keys(r.extracted).length} extracts`,
            tone: r.stub ? "warning" : "success",
          });
        }}
      />
      <DocumentSheet
        open={showDocGen}
        onClose={() => setShowDocGen(false)}
        onGenerated={(doc) => {
          setShowDocGen(false);
          toast.addToast({
            id: `chat-doc-${doc.id}`,
            title: `Generated ${doc.title}.${doc.format}`,
            description: doc.stub
              ? `fallback · ${doc.reason ?? ""}`
              : `${(doc.size_bytes / 1024).toFixed(1)} KB`,
            tone: "success",
            duration: 8000,
            action: {
              label: "Download",
              onClick: () => {
                window.open(safeWindowOpen(doc.download_url), "_blank");
              },
            },
          });
        }}
      />
    </div>
  );
}

function LiveWebToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={
        on
          ? "live web search ON — model pulls fresh data before answering"
          : "live web search OFF — model answers from training data only"
      }
      className={cn(
        "inline-flex items-center gap-1.5 mono-caps text-[10px] px-2 h-7 border transition-colors",
        on
          ? "bg-brass/10 border-brass text-brass"
          : "bg-bg border-borderSoft text-textMuted hover:text-text",
      )}
      aria-pressed={on}
    >
      {on ? (
        <SearchIcon size={11} />
      ) : (
        <span className="relative inline-flex">
          <SearchIcon size={11} className="opacity-50" />
          <span className="absolute inset-0 m-auto w-[14px] h-[1px] bg-current rotate-45" />
        </span>
      )}
      {on ? "live web · on" : "live web · off"}
    </button>
  );
}

function MessageBubble({
  message: m,
  isLast,
  isStreaming,
  userName,
  modelName,
}: {
  message: Message;
  isLast: boolean;
  isStreaming: boolean;
  userName: string;
  modelName: string;
}) {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";
  const stillStreaming = isStreaming && isLast && isAssistant;
  const sender = isUser ? userName : modelName;

  // Extract citations from message content for the CitationCard.
  const citations: Citation[] = extractCitations(m.content);

  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="pt-1">
          <Avatar name={sender} size={36} />
        </div>
      )}
      <div className={cn("max-w-[75%] flex flex-col", isUser ? "items-end" : "items-start")}>
        <div className="flex items-center gap-2 px-1 mb-1.5 flex-wrap">
          <span className="font-display text-[13px] font-semibold text-text">
            {sender}
          </span>
          <span
            className={cn(
              "mono-caps text-[10px] tracking-wider px-1.5 h-[16px] inline-flex items-center border",
              isAssistant
                ? "border-brass/40 text-brass"
                : "border-teal/40 text-teal",
            )}
          >
            {isAssistant ? "assistant" : "you"}
          </span>
          {stillStreaming && (
            <span className="inline-flex items-center gap-2 mono-caps text-[10px] text-brass bg-brass/10 px-2 py-1 border border-brass/40">
              <TypingDots size="sm" active={!m.content} />
              <span>{m.content ? "streaming" : "thinking"}</span>
            </span>
          )}
          {isAssistant && m.search && !stillStreaming && (
            <span className="inline-flex items-center gap-1 mono-caps text-[10px] text-teal border border-teal/40 px-1.5 h-[16px]">
              <SearchIcon size={9} />
              {m.search.service}
              {m.search.cached ? " · cached" : ""}
              <span className="text-textMuted">·</span>
              <span className="text-textMuted">{m.search.result_count}</span>
            </span>
          )}
          {/* Tier 4 (Discovery) — citation lineage badge. The CitationCard
              already shows the markdown-extracted citations; this badge
              shows the persistent lineage rows we wrote to the `citations`
              table on assistant turn. Click to jump to the source. */}
          {isAssistant && !stillStreaming && m.lineage && m.lineage.length > 0 && (
            <LineageBadge lineage={m.lineage} />
          )}
          {isAssistant && !stillStreaming && (
            <MessageMeta message={m} />
          )}
        </div>

        <div
          className={cn(
            "px-3.5 py-2.5 border w-fit max-w-full",
            isUser
              ? "bg-panelAlt border-border text-text"
              : "bg-bg border-brassSoft/40 text-text",
          )}
        >
          <div className="text-[13px] leading-relaxed">
            {isUser ? (
              <>
                {m.content || (stillStreaming ? <TypingDots size="sm" /> : "")}
                {stillStreaming && m.content && (
                  <span className="inline-block w-2 h-3 bg-brass ml-0.5 align-middle animate-pulse" />
                )}
              </>
            ) : m.content ? (
              <>
                <Markdown content={m.content} />
                {stillStreaming && (
                  <span className="inline-block w-2 h-3 bg-brass ml-0.5 align-middle animate-pulse" />
                )}
              </>
            ) : stillStreaming ? (
              <TypingDots size="sm" />
            ) : null}
          </div>
        </div>

        {citations.length > 0 && !stillStreaming && (
          <CitationCard
            citations={citations}
            service={m.search?.service ?? "search"}
          />
        )}
        {isAssistant && !stillStreaming && <FeedbackRow messageId={m.id} />}
      </div>
      {isUser && (
        <div className="pt-1">
          <Avatar name={sender} size={36} />
        </div>
      )}
    </div>
  );
}

function MessageMeta({ message }: { message: Message }) {
  const tokens = message.tokens ?? 0;
  const latency = message.latency_ms ?? 0;
  return (
    <span className="inline-flex items-center gap-2 mono-caps text-[10px] text-textFaint tracking-wider">
      {tokens > 0 && (
        <span className="inline-flex items-center gap-1">
          <ZapIcon size={9} />
          {tokens} tok
        </span>
      )}
      {latency > 0 && (
        <span className="inline-flex items-center gap-1">
          <ClockIcon size={9} />
          {(latency / 1000).toFixed(1)}s
        </span>
      )}
      {message.cached && (
        <span className="inline-flex items-center gap-1 text-teal border border-teal/40 px-1.5 h-[16px]">
          <CheckIcon size={9} />
          cached{message.cachedModel ? ` · ${message.cachedModel}` : ""}
        </span>
      )}
      {!message.search && !message.cached && (
        <span className="inline-flex items-center gap-1 text-teal">
          <CheckIcon size={9} />
          cached model
        </span>
      )}
    </span>
  );
}

/**
 * Find numbered source references at the bottom of an assistant reply
 * and pair them with the URLs listed under the "## Sources" heading.
 * Returns an empty array when nothing matches — the caller renders nothing.
 */
function extractCitations(content: string): Citation[] {
  if (!content) return [];
  // Match a "## Sources" block: heading line + bullet list with [title](url).
  const m = content.match(/##\s+Sources\s*\n([\s\S]*?)(?=\n##\s|$)/im);
  if (!m) return [];
  const bullets = m[1]!.matchAll(/\[(\d+)\]\s*\[?([^\]\n]+?)\]?\(?(https?:\/\/[^\s)]+)/g);
  const out: Citation[] = [];
  for (const b of bullets) {
    const num = Number(b[1]);
    if (!Number.isFinite(num)) continue;
    out.push({ n: num, title: b[2]!, url: b[3]! });
  }
  return out.sort((a, b) => a.n - b.n);
}

// Lineage badge — Tier 4 (Discovery). Clicking expands a row listing
// every persistent citation row from /api/messages/:id/citations. The
// actual fetch happens in a one-off effect inside ChatPage so this
// component is pure presentational.
function LineageBadge({ lineage }: { lineage: CitationLink[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 mono-caps text-[10px] text-brass border border-brass/40 bg-brass/10 px-1.5 h-[16px]"
        aria-expanded={open}
      >
        ⤳ lineage · {lineage.length}
      </button>
      {open && (
        <ul className="mt-1 bg-panel border border-borderSoft px-2 py-1.5 max-w-[320px] text-[11px] text-textMuted">
          {lineage.map((l) => (
            <li key={l.id} className="flex items-start gap-1.5 py-0.5">
              <span className="mono-caps text-[9px] text-brass mt-0.5">{l.source_kind}</span>
              {l.source_kind === "web" ? (
                <a
                  href={safeHref(l.source_ref)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-text hover:text-brass"
                  title={l.source_ref}
                >
                  {l.excerpt ?? l.source_ref}
                </a>
              ) : (
                <span className="truncate" title={l.source_ref}>
                  {l.excerpt ?? l.source_ref}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// TurnCostChip — Tier 7 combo (cost router + chat header). Renders the
// latest turn's USD cost inline next to the model name. We approximate
// from token counts + a generic $0.001/1k price so this works even when
// per-model pricing isn't yet filled in. As soon as the real prices land
// on the models table, replace the hard-coded rate with the joined
// value (kept simple here to avoid blocking on Tier 5's pricing endpoint).
// ─────────────────────────────────────────────────────────────────────

const APPROX_USD_PER_1K = 0.001;

function TurnCostChip() {
  // We read from the messages state via a sibling component pattern:
  // the chip is rendered inside the chat header but pulls the latest
  // assistant message via a context-free window event. Cheap because
  // the chat page is mounted once. Cheaper than lifting state.
  const [cost, setCost] = useState(0);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tokens: number }>).detail;
      if (detail && Number.isFinite(detail.tokens)) {
        setCost(detail.tokens * APPROX_USD_PER_1K / 1000);
      }
    };
    window.addEventListener("helm:turn-tokens", handler as EventListener);
    return () =>
      window.removeEventListener("helm:turn-tokens", handler as EventListener);
  }, []);
  if (cost <= 0) return null;
  return (
    <span
      className="mono-caps text-[10px] text-textFaint tracking-wider"
      title="Estimated cost for the last assistant turn"
    >
      · ${cost.toFixed(4)}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// FeedbackRow — Tier 6 + Tier 7 combo (self-test + feedback). Thumbs-
// up / thumbs-down buttons under each assistant message. Thumbs-down
// surfaces an optional reason input and fires the self-test re-run
// automatically. A toast confirms the vote.
// ─────────────────────────────────────────────────────────────────────

interface FeedbackResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; note?: string }>;
}

function FeedbackRow({
  messageId,
}: {
  messageId: string | undefined;
}) {
  const toast = useToast();
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<FeedbackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!messageId) return null;

  async function rate(r: "up" | "down", reasonText?: string) {
    if (!messageId) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await apiPost<{ ok: boolean; rerun: FeedbackResult | null }>(
        "/combo/feedback",
        { message_id: messageId, rating: r, reason: reasonText ?? null },
      );
      setRating(r);
      if (r === "down" && resp.rerun) setResult(resp.rerun);
      toast.addToast({
        id: `fb-${messageId}-${Date.now()}`,
        title:
          r === "up"
            ? "Thanks — we'll favour this kind of reply"
            : "Thanks — we'll learn from this",
        description:
          r === "down"
            ? "Optional reason helps the preference learner."
            : undefined,
        tone: r === "up" ? "success" : "info",
        duration: 2500,
      });
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.addToast({
        id: `chat-feedback-err-${messageId}`,
        title: "Feedback failed",
        description: msg,
        tone: "warning",
        duration: 3500,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void rate("up")}
          disabled={submitting || rating !== null}
          aria-pressed={rating === "up"}
          className={cn(
            "mono-caps text-[10px] tracking-wider px-2 h-6 border transition-colors inline-flex items-center gap-1",
            rating === "up"
              ? "border-teal/60 bg-teal/10 text-teal"
              : "border-border text-textMuted hover:text-text hover:border-borderSoft",
          )}
        >
          <ThumbsUpIcon size={9} />
          helpful
        </button>
        <button
          type="button"
          onClick={() => setAskingReason(true)}
          disabled={submitting || rating !== null}
          aria-pressed={rating === "down"}
          className={cn(
            "mono-caps text-[10px] tracking-wider px-2 h-6 border transition-colors inline-flex items-center gap-1",
            rating === "down"
              ? "border-rust/60 bg-rust/10 text-rust"
              : "border-border text-textMuted hover:text-text hover:border-borderSoft",
          )}
        >
          <ThumbsDownIcon size={9} />
          not helpful
        </button>
        {result && (
          <span
            className={cn(
              "mono-caps text-[10px] tracking-wider px-2 h-6 border inline-flex items-center gap-1",
              result.passed
                ? "border-teal/40 text-teal"
                : "border-rust/40 text-rust",
            )}
            title={result.checks
              .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}`)
              .join("\n")}
          >
            self-test: {result.passed ? "passed" : "flagged"}
          </span>
        )}
        {error && (
          <Badge tone="rust">{error}</Badge>
        )}
      </div>
      {askingReason && rating === null && (
        <div className="flex items-center gap-1.5 max-w-[480px]">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="what went wrong? (optional)"
            className="flex-1 bg-bg border border-border text-text px-2 py-1 font-mono text-[11px] outline-none focus:border-rust/60"
            autoFocus
          />
          <button
            type="button"
            onClick={() => void rate("down", reason.trim() || undefined)}
            disabled={submitting}
            className="mono-caps text-[10px] tracking-wider px-2 h-6 border border-rust/40 bg-rust/10 text-rust hover:bg-rust/20"
          >
            submit
          </button>
          <button
            type="button"
            onClick={() => setAskingReason(false)}
            className="mono-caps text-[10px] tracking-wider px-2 h-6 border border-borderSoft text-textMuted hover:text-rust"
          >
            cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Tier 3 — Voice + Multimodal helper components
// ============================================================================

interface InputToolbarProps {
  onAttach: () => void;
  onVoice: () => void;
  onBrowse: () => void;
  onDoc: () => void;
  disabled?: boolean;
  counts: { attachments: number; voice: number; browser: number };
}

function InputToolbar({ onAttach, onVoice, onBrowse, onDoc, disabled, counts }: InputToolbarProps) {
  const buttons: Array<{
    onClick: () => void;
    label: string;
    icon: ReactNode;
    badge?: number;
    title: string;
  }> = [
    { onClick: onVoice, label: "voice", icon: <MicIcon size={12} />, badge: counts.voice, title: "voice → transcript" },
    { onClick: onAttach, label: "attach", icon: <PaperclipIcon size={12} />, badge: counts.attachments, title: "attach file" },
    { onClick: onBrowse, label: "browse", icon: <GlobeIcon size={12} />, badge: counts.browser, title: "browse the web" },
    { onClick: onDoc, label: "doc", icon: <DocumentIcon size={12} />, title: "generate document" },
  ];
  return (
    <div className="flex items-center gap-1 mb-1.5">
      <span className="mono-caps text-[10px] text-textFaint mr-1">tools</span>
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          disabled={disabled}
          onClick={b.onClick}
          title={b.title}
          className={cn(
            "inline-flex items-center gap-1 mono-caps text-[10px] tracking-wider px-1.5 h-[22px] border transition-colors",
            disabled
              ? "border-borderSoft text-textFaint cursor-not-allowed"
              : "border-borderSoft text-textMuted hover:text-brass hover:border-brass/50",
          )}
        >
          {b.icon}
          {b.label}
          {b.badge !== undefined && b.badge > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 bg-brass/20 text-brass border border-brass/40 mono-caps text-[9px]">
              {b.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

interface AttachmentChipsProps {
  attachments: UploadedFile[];
  onRemoveAttachment: (id: string) => void;
  voice: string | null;
  onClearVoice: () => void;
  browser: BrowserResult | null;
  onClearBrowser: () => void;
}

function AttachmentChips({
  attachments,
  onRemoveAttachment,
  voice,
  onClearVoice,
  browser,
  onClearBrowser,
}: AttachmentChipsProps) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {attachments.map((a) => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1 mono-caps text-[10px] tracking-wider px-1.5 h-[22px] border border-brass/40 bg-brass/10 text-brass"
          title={a.description ?? a.name}
        >
          <PaperclipIcon size={10} />
          {a.name}
          <button
            type="button"
            aria-label="Remove"
            onClick={() => onRemoveAttachment(a.id)}
            className="text-brass hover:text-rust"
          >
            <XIcon size={10} />
          </button>
        </span>
      ))}
      {voice && (
        <span className="inline-flex items-center gap-1 mono-caps text-[10px] tracking-wider px-1.5 h-[22px] border border-teal/40 bg-teal/10 text-teal">
          <MicIcon size={10} />
          voice · {voice.length}c
          <button
            type="button"
            aria-label="Clear voice"
            onClick={onClearVoice}
            className="text-teal hover:text-rust"
          >
            <XIcon size={10} />
          </button>
        </span>
      )}
      {browser && (
        <span className="inline-flex items-center gap-1 mono-caps text-[10px] tracking-wider px-1.5 h-[22px] border border-brassSoft/40 bg-brassSoft/10 text-text">
          <GlobeIcon size={10} />
          {browser.title || browser.finalUrl}
          <button
            type="button"
            aria-label="Clear browser result"
            onClick={onClearBrowser}
            className="text-text hover:text-rust"
          >
            <XIcon size={10} />
          </button>
        </span>
      )}
    </div>
  );
}

interface DocumentSheetProps {
  open: boolean;
  onClose: () => void;
  onGenerated: (doc: {
    id: string;
    title: string;
    format: string;
    size_bytes: number;
    download_url: string;
    stub: boolean;
    reason?: string;
  }) => void;
}

const DOC_FORMATS: Array<{ value: string; label: string; hint: string }> = [
  { value: "md", label: "Markdown", hint: "always available" },
  { value: "html", label: "HTML", hint: "always available" },
  { value: "docx", label: "Word", hint: "needs docx lib" },
  { value: "pdf", label: "PDF", hint: "needs pdfkit" },
  { value: "xlsx", label: "Excel", hint: "needs xlsx lib" },
  { value: "pptx", label: "Slides", hint: "needs pptxgenjs" },
];

function DocumentSheet({ open, onClose, onGenerated }: DocumentSheetProps) {
  const [title, setTitle] = useState("Document");
  const [format, setFormat] = useState("md");
  const [sections, setSections] = useState<Array<{ heading: string; content: string }>>([
    { heading: "Overview", content: "" },
  ]);
  const [generating, setGenerating] = useState(false);
  const toast = useToast();

  const generate = useCallback(async () => {
    if (!title.trim()) {
      toast.addToast({
        id: "doc-no-title",
        title: "Title required",
        tone: "warning",
      });
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/documents/generate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          format,
          sections: sections.filter((s) => s.heading || s.content),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `generation failed (${res.status})`);
      }
      const doc = (await res.json()) as {
        id: string;
        title: string;
        format: string;
        size_bytes: number;
        download_url: string;
        stub: boolean;
        reason?: string;
      };
      onGenerated(doc);
    } catch (err) {
      toast.addToast({
        id: "doc-err",
        title: "Generation failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setGenerating(false);
    }
  }, [title, format, sections, onGenerated, toast]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="w-[640px] max-w-[95vw] max-h-[90vh] bg-panel border border-border shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-borderSoft">
          <div className="flex items-center gap-2">
            <DocumentIcon size={14} className="text-brass" />
            <span className="font-display text-[13px] text-text">Generate document</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-textFaint hover:text-text p-1"
          >
            ×
          </button>
        </div>

        <div className="px-3 py-2 border-b border-borderSoft flex items-center gap-2">
          <span className="mono-caps text-[10px] text-textFaint w-12">title</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="flex-1 py-1"
          />
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="bg-bg border border-border text-text px-2 py-1 font-mono text-[11px] outline-none"
          >
            {DOC_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} · {f.hint}
              </option>
            ))}
          </select>
        </div>

        <div className="px-3 py-2 flex-1 overflow-y-auto space-y-2">
          <div className="mono-caps text-[10px] text-textFaint">sections</div>
          {sections.map((s, i) => (
            <div key={i} className="border border-borderSoft p-2 bg-panelAlt space-y-1">
              <Input
                value={s.heading}
                onChange={(e) =>
                  setSections((prev) =>
                    prev.map((p, j) => (j === i ? { ...p, heading: e.target.value } : p)),
                  )
                }
                placeholder="heading"
                className="w-full py-1"
              />
              <textarea
                value={s.content}
                onChange={(e) =>
                  setSections((prev) =>
                    prev.map((p, j) => (j === i ? { ...p, content: e.target.value } : p)),
                  )
                }
                rows={3}
                placeholder="content (markdown ok)"
                className="w-full bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] resize-none outline-none"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}
                  className="mono-caps text-[10px] text-textFaint hover:text-rust"
                >
                  remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setSections((prev) => [...prev, { heading: "", content: "" }])}
            className="inline-flex items-center gap-1 mono-caps text-[10px] text-textMuted border border-dashed border-borderSoft hover:border-brass hover:text-brass px-2 py-1"
          >
            + section
          </button>
        </div>

        <div className="px-3 py-2 border-t border-borderSoft flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={generate} disabled={generating}>
            <DownloadIcon size={12} />
            {generating ? "Generating…" : "Generate"}
          </Button>
        </div>
      </div>
    </div>
  );
}
