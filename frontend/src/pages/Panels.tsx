// Panels — list + detail with WebSocket multiplayer chat (docs §2.3).
// v3 redesign:
//   - Chat is the only primary surface. Members, skills, knowledge, and
//     agent settings sit behind a "Settings" sheet (right-side drawer)
//     so the chat input is always above the fold.
//   - Adding a panel auto-selects it (no extra click to start chatting).
//   - The agent status pill stays in the compact header so the user
//     instantly knows whether the panel has a model assigned.
//   - Empty thread uses EmptyState (no surprise wall of blanks).
//   - Auto-scroll the thread to the bottom on new messages.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { CallSign } from "../components/ui/CallSign";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Avatar } from "../components/ui/Avatar";
import { AvatarStack } from "../components/ui/data/AvatarStack";
import { PresenceDot } from "../components/ui/data/PresenceDot";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { TypingDots } from "../components/ui/TypingDots";
import { Markdown } from "../components/ui/Markdown";
import { useToast } from "../components/ui/feedback/Toast";
import {
  SettingsIcon,
  PlusIcon,
  XIcon,
  CheckIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  AlertTriangleIcon,
} from "../components/ui/Icon";
import { SideSheet, SheetTabs } from "../components/ui/layout/SideSheet";
import {
  PresenceLayer,
  WatchingPill,
  PresenceAvatarStack,
  presenceHighlightClass,
  useTypingBeacon,
  type PresenceUser,
} from "../components/system/PresenceLayer";
import { ReplayBranchButton } from "../components/system/ReplayBar";
import { cn } from "../lib/cn";

interface KnowledgeDoc {
  id: string;
  name: string;
  chunk_count: number;
  total_tokens?: number;
  uploaded_at: string;
}

interface PanelSkillRow {
  id: string;
  pack_id: string | null;
  name: string;
  description: string;
  scope: "org" | "panel" | "user";
  kind: "prompt" | "tool" | "workflow";
  granted_by: string | null;
  granted_at: string;
}

interface AvailableSkill {
  id: string;
  pack_id: string | null;
  name: string;
  description: string;
  scope: "org" | "panel" | "user";
  kind: "prompt" | "tool" | "workflow";
  available_to_user: boolean;
}

interface AvailableUser {
  id: string;
  name: string;
  username: string;
  role: "admin" | "user";
}

interface AvailableModel {
  id: string;
  external_id: string;
  display_name: string;
  provider_type: string;
  assigned: boolean;
}

interface PanelSummary {
  id: string;
  name: string;
  agent_model_id: string | null;
  persona_id: string | null;
  member_count: number;
  message_count: number;
  created_at: string;
}

interface PanelDetail extends PanelSummary {
  agent_model_name: string | null;
  persona_name: string | null;
  members: Array<{
    user_id: string;
    username: string;
    name: string;
    role: "admin" | "user";
  }>;
}

interface PanelMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  sender_name: string | null;
  created_at: string;
}

interface Approval {
  id: string;
  user_id: string;
  panel_id: string | null;
  tool_name: string;
  tool_args: Record<string, unknown>;
  reason: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  expires_at: string;
  created_at: string;
}

type SettingsTab = "members" | "skills" | "knowledge" | "summary";

export function PanelsPage() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [panels, setPanels] = useState<PanelSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<PanelDetail | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeDoc[]>([]);
  const [knowledgeName, setKnowledgeName] = useState("");
  const [knowledgeText, setKnowledgeText] = useState("");
  const [input, setInput] = useState("");
  const [allUsers, setAllUsers] = useState<AvailableUser[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [grantedSkills, setGrantedSkills] = useState<PanelSkillRow[]>([]);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
  const [agentThinking, setAgentThinking] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [mentionedModelId, setMentionedModelId] = useState<string | null>(null);
  const [lastPickedExternalId, setLastPickedExternalId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("members");
  // Tier 1 co-pilot state.
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null);
  const [humanTypers, setHumanTypers] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messageRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  const isAdmin = user?.role === "admin";
  const navigate = useNavigate();
  const markTyping = useTypingBeacon(wsRef.current, null);

  // Listen for presence-highlight events from the PresenceLayer so we
  // can attach the brass outline class to the right message node.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail || detail.panelId !== active) return;
      setHighlightId(detail.messageId ?? null);
      if (detail.messageId) {
        setTimeout(() => setHighlightId(null), 2000);
      }
    };
    window.addEventListener("helm:presence-highlight", handler);
    return () => window.removeEventListener("helm:presence-highlight", handler);
  }, [active]);

  // Branch-creation event — refresh the panel list and select the
  // new branch.
  useEffect(() => {
    const handler = async (_ev: Event) => {
      const list = await apiGet<PanelSummary[]>("/panels");
      setPanels(list);
    };
    window.addEventListener("helm:branch-created", handler);
    return () => window.removeEventListener("helm:branch-created", handler);
  }, []);

  // Late-joiner fetch: when the WS first opens we don't have any
  // presence_update frames yet, so pull the snapshot via REST so the
  // "X watching" pill is correct from frame 0.
  useEffect(() => {
    if (!active) return;
    setPresenceLoaded(false);
    apiGet<PresenceUser[]>(`/panels/${active}/presence`)
      .then((list) => {
        setPresence(list);
        setPresenceLoaded(true);
      })
      .catch(() => setPresenceLoaded(true));
  }, [active]);

  // Poll pending approvals for the current user so the inline overlay
  // appears when the agent pauses. For v1 we only show the most recent
  // pending one on this panel; the user can see all of them at
  // /approvals.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      try {
        const rows = await apiGet<Approval[]>(`/approvals?status=pending`);
        if (cancelled) return;
        const here = rows.find((r) => r.panel_id === active) ?? null;
        setPendingApproval(here);
      } catch {
        /* ignore */
      }
    }
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  useEffect(() => {
    apiGet<PanelSummary[]>("/panels").then(setPanels);
  }, []);

  // Load detail + messages when active changes.
  useEffect(() => {
    if (!active) {
      setDetail(null);
      setMessages([]);
      setKnowledge([]);
      setGrantedSkills([]);
      return;
    }
    apiGet<PanelDetail>(`/panels/${active}`).then(setDetail);
    apiGet<PanelMessage[]>(`/panels/${active}/messages`).then(setMessages);
    apiGet<KnowledgeDoc[]>(`/panels/${active}/knowledge`).then(setKnowledge);
    apiGet<PanelSkillRow[]>(`/panels/${active}/skills`)
      .then(setGrantedSkills)
      .catch(() => setGrantedSkills([]));
    apiGet<AvailableSkill[]>(`/skills`)
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]));
  }, [active]);

  // Auto-scroll the thread to the bottom whenever messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, active]);

  // Admins see the full user list so they can invite. Users see the
  // same list so they know who's already on the panel (read-only).
  useEffect(() => {
    if (!user) return;
    if (user.role !== "admin") return;
    apiGet<AvailableUser[]>("/users").then(setAllUsers).catch(() => {});
  }, [user?.role]);

  // Load available models for the current panel when it changes.
  // Admin: every model. Users: only those they have access to.
  useEffect(() => {
    if (!active) return;
    apiGet<AvailableModel[]>(`/panels/${active}/available-models`)
      .then(setAvailableModels)
      .catch(() => setAvailableModels([]));
  }, [active]);

  async function addMember(userId: string) {
    if (!active) return;
    await apiPost(`/panels/${active}/members`, { user_ids: [userId] });
    const d = await apiGet<PanelDetail>(`/panels/${active}`);
    setDetail(d);
    addToast({
      id: `panel-add-${userId}-${Date.now()}`,
      title: "Member added",
      tone: "info",
      duration: 2500,
    });
  }

  async function toggleGrant(skillId: string, currentlyGranted: boolean) {
    if (!active) return;
    if (currentlyGranted) {
      await apiDelete(`/panels/${active}/skills/${skillId}`);
    } else {
      await apiPost(`/panels/${active}/skills/${skillId}/grant`);
    }
    const next = await apiGet<PanelSkillRow[]>(`/panels/${active}/skills`);
    setGrantedSkills(next);
    addToast({
      id: `panel-skill-${skillId}-${Date.now()}`,
      title: currentlyGranted ? "Skill revoked" : "Skill granted",
      tone: "info",
      duration: 2500,
    });
  }

  async function removeMember(userId: string) {
    if (!active) return;
    await apiDelete(`/panels/${active}/members/${userId}`);
    const d = await apiGet<PanelDetail>(`/panels/${active}`);
    setDetail(d);
    addToast({
      id: `panel-remove-${userId}-${Date.now()}`,
      title: "Member removed",
      tone: "info",
      duration: 3000,
    });
  }

  // WebSocket subscription while a panel is active.
  useEffect(() => {
    if (!active) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/panels/${active}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "message") {
          setAgentThinking(false);
          setMessages((prev) => {
            const withoutDup = prev.filter(
              (p) => p.id !== msg.id && !(p.role === "assistant" && p.id === ""),
            );
            return [
              ...withoutDup,
              {
                id: msg.id,
                role: msg.role,
                content: msg.content,
                sender_name: msg.senderName ?? null,
                created_at: msg.createdAt,
              },
            ];
          });
        } else if (msg.type === "typing") {
          // Server-side typing frames distinguish "a human is composing"
          // (msg.userId set) from "the agent is composing" (no userId).
          // The agent case is handled by the same logic as before; the
          // human case adds a small "X is typing…" hint in the chat.
          if (msg.userId) {
            setHumanTypers((cur) => {
              const next = new Set(cur);
              next.add(msg.userId);
              return next;
            });
            // Auto-clear after 6s if no further typing frame arrives.
            setTimeout(() => {
              setHumanTypers((cur) => {
                const next = new Set(cur);
                next.delete(msg.userId);
                return next;
              });
            }, 6000);
          } else {
            setAgentThinking(true);
          }
        } else if (msg.type === "token" && typeof msg.delta === "string") {
          setAgentThinking(false);
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && last.id === "") {
              next[next.length - 1] = {
                ...last,
                content: last.content + msg.delta,
              };
            } else {
              next.push({
                id: "",
                role: "assistant",
                content: msg.delta,
                sender_name: null,
                created_at: new Date().toISOString(),
              });
            }
            return next;
          });
        } else if (msg.type === "done") {
          setAgentThinking(false);
        } else if (msg.type === "error") {
          setAgentThinking(false);
        } else if (msg.type === "presence_update" && Array.isArray(msg.users)) {
          // Dispatch on the window so the PresenceLayer (mounted
          // separately) can pick it up and update the header pill.
          setPresence(msg.users as PresenceUser[]);
          window.dispatchEvent(
            new CustomEvent("helm:panel-frame", {
              detail: { panelId: active, frame: msg },
            }),
          );
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [active]);

  function pickModel(m: AvailableModel) {
    const external = m.external_id;
    const m2 = input.match(/(.*)@(\S*)$/);
    let replaced: string;
    if (m2) {
      const before = m2[1] ?? "";
      replaced = `${before}@${external} `;
    } else {
      replaced = `${input} @${external} `.replace(/^\s+/, "");
    }
    setInput(replaced);
    setMentionedModelId(m.id);
    setLastPickedExternalId(external);
    setMentionOpen(false);
  }

  function onInputChange(value: string) {
    setInput(value);
    if (value.trim().length > 0) markTyping();
    if (lastPickedExternalId && !value.includes(`@${lastPickedExternalId}`)) {
      setMentionedModelId(null);
      setLastPickedExternalId(null);
    }
    const m = value.match(/(?:^|\s)@(\S*)$/);
    if (!m) {
      if (mentionOpen) setMentionOpen(false);
      return;
    }
    const token = m[1] ?? "";
    const matchesKnown =
      token.length > 0 &&
      availableModels.some(
        (a) => a.external_id === token || a.display_name === token,
      );
    const sameAsPicked = lastPickedExternalId !== null && token === lastPickedExternalId;
    if (matchesKnown || sameAsPicked) {
      if (mentionOpen) setMentionOpen(false);
      return;
    }
    setMentionQuery(token);
    setMentionSelectedIdx(0);
    setMentionOpen(true);
  }

  async function send() {
    if (!active || !input.trim() || !wsRef.current) return;
    const content = input.trim();
    setInput("");
    setMentionOpen(false);
    const previousMentionId = mentionedModelId;
    setMentionedModelId(null);
    setLastPickedExternalId(null);
    const frame: { type: string; content: string; mentioned_model_id?: string } = {
      type: "send",
      content,
    };
    if (previousMentionId) frame.mentioned_model_id = previousMentionId;
    wsRef.current.send(JSON.stringify(frame));
    // Return focus to the textarea so the user can keep typing.
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function createPanel() {
    if (!newName.trim()) return;
    const created = await apiPost<PanelSummary>("/panels", { name: newName.trim() });
    setNewName("");
    setCreating(false);
    const list = await apiGet<PanelSummary[]>("/panels");
    setPanels(list);
    // Auto-select the freshly-created panel so the user lands directly in chat.
    setActive(created.id);
    addToast({
      id: `panel-created-${created.id}`,
      title: "Panel created",
      description: `"${created.name}" is ready. Start chatting.`,
      tone: "info",
      duration: 3000,
    });
  }

  if (!user) return null;

  return (
    <div className="h-full flex">
      <h1 className="sr-only">Panels</h1>

      {/* Left column — slim panel list */}
      <aside className="w-[260px] shrink-0 border-r border-border bg-panel flex flex-col">
        <div className="px-3 py-2 border-b border-borderSoft flex items-center justify-between">
          <span className="mono-caps text-[10px] text-textMuted">Panels</span>
          {isAdmin && (
            <button
              onClick={() => setCreating((v) => !v)}
              className="mono-caps text-[10px] text-brass hover:underline"
            >
              {creating ? "cancel" : "+ new"}
            </button>
          )}
        </div>
        {creating && (
          <div className="p-3 border-b border-borderSoft space-y-2">
            <Input
              name="panel-name"
              placeholder="Panel name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createPanel();
              }}
              autoFocus
            />
            <Button
              variant="primary"
              onClick={createPanel}
              className="w-full"
              disabled={!newName.trim()}
            >
              Create
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {panels.length === 0 && (
            <div className="px-3 py-6 text-center">
              <div className="mono-caps text-[10px] text-textFaint">no panels</div>
              {isAdmin && (
                <div className="text-textMuted text-[12px] mt-1">
                  Click + new to spin one up.
                </div>
              )}
            </div>
          )}
          {panels.map((p) => {
            const isActive = p.id === active;
            return (
              <button
                key={p.id}
                onClick={() => setActive(p.id)}
                className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${
                  isActive
                    ? "border-brass bg-panelAlt text-text"
                    : "border-transparent text-textMuted hover:bg-panelAlt/60 hover:text-text"
                }`}
              >
                <div className="flex items-center gap-2">
                  <CallSign id={`PNL-${p.id.slice(0, 4).toUpperCase()}`} />
                  <span className="font-mono text-[12px] truncate">{p.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 mono-caps text-[10px] text-textFaint">
                  <span>{p.member_count} mb</span>
                  <span>{p.message_count} msg</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Right column — chat is the primary surface */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        {!detail ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              variant="conversation"
              title="Pick a panel"
              description={
                isAdmin
                  ? "Create one with + new, or pick from the left to start chatting."
                  : "Pick a panel from the left to open the multiplayer thread."
              }
              tone="brass"
            />
          </div>
        ) : (
          <>
            {/* Compact header — name + agent status + member stack + Settings */}
            <div className="h-12 border-b border-border bg-panel flex items-center px-4 gap-3 shrink-0">
              <CallSign id={`PNL-${detail.id.slice(0, 4).toUpperCase()}`} />
              <span className="font-display text-[14px] font-semibold text-text truncate">
                {detail.name}
              </span>
              {detail.persona_name && (
                <span className="mono-caps text-[10px] text-textMuted border border-borderSoft px-1.5 h-[16px] inline-flex items-center shrink-0">
                  persona · {detail.persona_name}
                </span>
              )}
              {detail.agent_model_name ? (
                <StatusPill
                  state="healthy"
                  label={`agent: ${detail.agent_model_name}`}
                />
              ) : (
                <StatusPill
                  state="idle"
                  label="no agent — type @model to route"
                />
              )}
              <div className="ml-auto flex items-center gap-2">
                <PresenceAvatarStack
                  members={detail.members}
                  users={presence}
                  size={22}
                  max={5}
                />
                <WatchingPill
                  users={presence}
                  currentUserId={user?.id ?? ""}
                />
                <button
                  type="button"
                  onClick={() => navigate(`/replay/${detail.id}`)}
                  className="inline-flex items-center gap-1 mono-caps text-[10px] text-textMuted hover:text-brass border border-borderSoft hover:border-brass px-2 h-7"
                  title="Open the time-travel replay for this panel"
                >
                  replay
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="inline-flex items-center gap-1 mono-caps text-[10px] text-textMuted hover:text-brass border border-borderSoft hover:border-brass px-2 h-7"
                  title="Panel settings (members, skills, knowledge)"
                >
                  <SettingsIcon size={12} />
                  settings
                </button>
              </div>
            </div>

            {/* Mount the live presence layer — drives the heartbeat,
                the message-cursor highlight, and the watching pill. */}
            {user && detail && (
              <PresenceLayer
                panelId={detail.id}
                currentUserId={user.id}
                ws={wsRef.current}
                members={detail.members}
                scrollRef={scrollRef}
                messageRefs={messageRefs}
              />
            )}

            {/* Chat thread — the only thing in the main scroll area */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
              {messages.length === 0 && (
                <EmptyState
                  variant="conversation"
                  title="Empty thread"
                  description={`Say hi to the agent or @-mention a model to route this turn. ${detail.members.length === 1 ? "You're the only member so far — open Settings to invite collaborators." : ""}`}
                  tone="brass"
                />
              )}
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                const isAssistant = m.role === "assistant";
                const isStreaming =
                  (agentThinking || (m.role === "assistant" && m.id === "" && m.content === "")) &&
                  i === messages.length - 1 &&
                  isAssistant;
                const sender = m.sender_name || (isUser ? user.name : "agent");
                const senderRole: "admin" | "user" | "assistant" = isAssistant
                  ? "assistant"
                  : (detail?.members.find(
                      (mm) => mm.name === m.sender_name || mm.username === m.sender_name,
                    )?.role ?? "user");
                return (
                  <div
                    key={m.id || i}
                    ref={(el) => {
                      if (m.id) messageRefs.current.set(m.id, el);
                    }}
                    data-message-id={m.id || undefined}
                    className={cn(
                      "group relative flex gap-3",
                      isUser ? "justify-end" : "justify-start",
                      m.id && highlightId === m.id ? presenceHighlightClass : "",
                    )}
                  >
                    {!isUser && (
                      <div className="flex flex-col items-center gap-1 pt-1">
                        <Avatar name={sender} size={32} role={senderRole === "admin" ? "admin" : "user"} />
                      </div>
                    )}
                    <div className={`max-w-[75%] ${isUser ? "items-end" : "items-start"} flex flex-col`}>
                      <div className="flex items-center gap-2 px-1 mb-1">
                        <span className="font-display text-[13px] font-semibold text-text">
                          {sender}
                        </span>
                        <Badge tone={senderRole === "assistant" ? "brass" : senderRole === "admin" ? "brass" : "teal"}>
                          {senderRole}
                        </Badge>
                        <span className="mono-caps text-[10px] text-textFaint">
                          {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        {isStreaming && (
                          <span className="inline-flex items-center gap-1.5 mono-caps text-[10px] text-brass">
                            <TypingDots size="sm" /> thinking
                          </span>
                        )}
                        {/* Tier 1: branch button on each assistant message */}
                        {isAssistant && m.id && detail && (
                          <ReplayBranchButton panelId={detail.id} messageId={m.id} />
                        )}
                        {/* Tier 6 — self-test badge under each assistant
                            message. Polls /api/messages/:id/self-test once
                            on mount and renders a small teal/rust chip. */}
                        {isAssistant && m.id && (
                          <SelfTestBadge messageId={m.id} />
                        )}
                      </div>
                      <div
                        className={`px-3 py-2 border w-fit max-w-full ${
                          isUser
                            ? "bg-panelAlt border-border text-text"
                            : isAssistant
                            ? "bg-bg border-brassSoft/40 text-text"
                            : "bg-bg border-borderSoft text-textMuted"
                        }`}
                      >
                        <div className="text-[13px] leading-relaxed whitespace-pre-wrap">
                          {m.role === "user" ? (
                            <>
                              {m.content || (isStreaming ? <TypingDots size="sm" /> : "")}
                              {isStreaming && m.content && (
                                <span className="inline-block w-2 h-3 bg-brass ml-0.5 align-middle animate-pulse" />
                              )}
                            </>
                          ) : m.content ? (
                            <>
                              <Markdown content={m.content} />
                              {isStreaming && (
                                <span className="inline-block w-2 h-3 bg-brass ml-0.5 align-middle animate-pulse" />
                              )}
                            </>
                          ) : isStreaming ? (
                            <TypingDots size="sm" />
                          ) : null}
                        </div>
                      </div>
                      {/* Tier 6 — thumbs feedback under each assistant
                          message. Reuses the /combo/feedback endpoint so
                          we also kick off a self-test re-run on a
                          thumbs-down. */}
                      {isAssistant && m.id && !isStreaming && (
                        <PanelFeedbackRow
                          messageId={m.id}
                          onRated={(r) =>
                            addToast({
                              id: `fb-${m.id}-${Date.now()}`,
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
                            })
                          }
                        />
                      )}
                    </div>
                    {isUser && (
                      <div className="flex flex-col items-center gap-1 pt-1">
                        <Avatar name={sender} size={32} role={senderRole === "admin" ? "admin" : "user"} />
                      </div>
                    )}
                  </div>
                );
              })}
              {agentThinking &&
                (messages.length === 0 ||
                  messages[messages.length - 1]?.role !== "assistant" ||
                  (messages[messages.length - 1]?.id === "" &&
                    (messages[messages.length - 1]?.content?.length ?? 0) > 0)) && (
                  <div className="flex gap-3 justify-start">
                    <div className="pt-1">
                      <Avatar name="agent" size={32} />
                    </div>
                    <div className="flex flex-col items-start">
                      <div className="flex items-center gap-2 px-1 mb-1">
                        <span className="font-display text-[13px] font-semibold text-text">agent</span>
                        <Badge tone="brass">assistant</Badge>
                        <span className="inline-flex items-center gap-1.5 mono-caps text-[10px] text-brass">
                          <TypingDots size="sm" /> thinking
                        </span>
                      </div>
                      <div className="px-3 py-2 border w-fit max-w-full bg-bg border-brassSoft/40 text-text">
                        <TypingDots size="sm" />
                      </div>
                    </div>
                  </div>
                )}

              {/* Tier 1: human-typing indicator. Shows who's composing
                  right now (excludes the current user). */}
              {humanTypers.size > 0 && (
                <div className="flex items-center gap-2 px-2 py-1 text-textMuted">
                  <TypingDots size="sm" />
                  <span className="text-[12px]">
                    {Array.from(humanTypers)
                      .map((uid) => {
                        const m = detail?.members.find((mm) => mm.user_id === uid);
                        return m?.name ?? "someone";
                      })
                      .slice(0, 3)
                      .join(", ")}{" "}
                    {humanTypers.size === 1 ? "is" : "are"} typing…
                  </span>
                </div>
              )}
            </div>

            {/* Tier 1: inline approval overlay — shown when the agent
                pauses on a dangerous tool. Renders over the input so
                the user can approve / deny without leaving the chat. */}
            {pendingApproval && (
              <ApprovalOverlay
                approval={pendingApproval}
                onDecide={async (decision) => {
                  try {
                    await apiPost(`/approvals/${pendingApproval.id}/decide`, {
                      decision,
                    });
                    setPendingApproval(null);
                    addToast({
                      id: `approval-${decision}-${pendingApproval.id}`,
                      title: decision === "approved" ? "Approved" : "Denied",
                      description: pendingApproval.tool_name,
                      tone: decision === "approved" ? "success" : "warning",
                      duration: 2500,
                    });
                  } catch (err) {
                    addToast({
                      id: `approval-err-${pendingApproval.id}`,
                      title: "Decision failed",
                      description: (err as Error).message,
                      tone: "warning",
                      duration: 4000,
                    });
                  }
                }}
                onDismiss={() => setPendingApproval(null)}
              />
            )}

            {/* Chat input — pinned to the bottom, always visible */}
            <div className="border-t border-border bg-panel p-3 shrink-0">
              <div className="flex items-end gap-2 relative">
                <div className="flex-1 relative">
                  {mentionOpen && availableModels.length > 0 && (
                    <MentionPicker
                      models={availableModels}
                      query={mentionQuery}
                      selectedIdx={mentionSelectedIdx}
                      onHover={setMentionSelectedIdx}
                      onPick={pickModel}
                    />
                  )}
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => onInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (mentionOpen) {
                        const filtered = availableModels.filter(
                          (m) =>
                            m.display_name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
                            m.external_id.toLowerCase().includes(mentionQuery.toLowerCase()),
                        );
                        if (e.key === "ArrowDown" && filtered.length) {
                          e.preventDefault();
                          setMentionSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
                          return;
                        }
                        if (e.key === "ArrowUp" && filtered.length) {
                          e.preventDefault();
                          setMentionSelectedIdx((i) => Math.max(i - 1, 0));
                          return;
                        }
                        if (e.key === "Enter" && filtered.length && filtered[mentionSelectedIdx]) {
                          e.preventDefault();
                          pickModel(filtered[mentionSelectedIdx]!);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setMentionOpen(false);
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    rows={2}
                    placeholder={`Message ${detail.name}… (type @ to mention a model, Enter to send)`}
                    className="w-full bg-bg border border-border text-text px-3 py-2 font-mono text-[13px] resize-none focus:border-brass"
                  />
                </div>
                <Button variant="primary" onClick={send} disabled={!input.trim()}>
                  Send
                </Button>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="mono-caps text-[10px] text-textFaint">
                  ⏎ send · ⇧⏎ newline · @ to mention a model
                </span>
                {mentionedModelId && !input.startsWith("@") && (
                  <span className="mono-caps text-[10px] text-brass">
                    → mentioned model selected
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Settings sheet — only rendered when a panel is active */}
      {detail && (
        <SideSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title={`${detail.name} · settings`}
          description="members · skills · knowledge · summary"
        >
          <SheetTabs<SettingsTab>
            tabs={[
              { id: "members", label: "Members", count: detail.members.length },
              { id: "skills", label: "Skills", count: grantedSkills.length },
              { id: "knowledge", label: "Knowledge", count: knowledge.length },
              { id: "summary", label: "Summary", count: undefined },
            ]}
            active={settingsTab}
            onChange={setSettingsTab}
          />
          <div className="p-4">
            {settingsTab === "members" && (
              <MembersTab
                detail={detail}
                allUsers={allUsers}
                user={user}
                isAdmin={isAdmin}
                onAdd={addMember}
                onRemove={removeMember}
              />
            )}
            {settingsTab === "summary" && active && (
              <SummaryTab
                panelId={active}
                onCollapsed={() => {
                  apiGet<PanelMessage[]>(`/panels/${active}/messages`).then(setMessages);
                }}
              />
            )}
            {settingsTab === "skills" && (
              <SkillsTab
                granted={grantedSkills}
                available={availableSkills}
                onToggle={(id) => toggleGrant(id, grantedSkills.some((s) => s.id === id))}
                isAdmin={isAdmin}
              />
            )}
            {settingsTab === "knowledge" && (
              <KnowledgeTab
                docs={knowledge}
                name={knowledgeName}
                text={knowledgeText}
                setName={setKnowledgeName}
                setText={setKnowledgeText}
                onUpload={async () => {
                  if (!active || !knowledgeName.trim() || !knowledgeText.trim()) return;
                  try {
                    await apiPost(`/panels/${active}/knowledge`, {
                      name: knowledgeName.trim(),
                      text: knowledgeText,
                    });
                    const list = await apiGet<KnowledgeDoc[]>(`/panels/${active}/knowledge`);
                    setKnowledge(list);
                    setKnowledgeName("");
                    setKnowledgeText("");
                    addToast({
                      id: `kb-${Date.now()}`,
                      title: "Knowledge indexed",
                      description: `${list.length} docs in this panel.`,
                      tone: "info",
                      duration: 2500,
                    });
                  } catch (err) {
                    addToast({
                      id: `kb-err-${Date.now()}`,
                      title: "Index failed",
                      description: (err as Error).message,
                      tone: "warning",
                      duration: 4000,
                    });
                  }
                }}
              />
            )}
          </div>
        </SideSheet>
      )}
    </div>
  );
}

// ─── Settings sub-tabs ──────────────────────────────────────────────────────

function MembersTab({
  detail,
  allUsers,
  user,
  isAdmin,
  onAdd,
  onRemove,
}: {
  detail: PanelDetail;
  allUsers: AvailableUser[];
  user: { id: string; username: string; role: "admin" | "user" };
  isAdmin: boolean;
  onAdd: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-textMuted">
        People on this panel. Members can read and post messages; the agent
        answers as configured.
      </p>
      <ul className="space-y-1.5">
        {detail.members.map((m) => (
          <li
            key={m.user_id}
            className="flex items-center gap-2.5 bg-panelAlt border border-border px-2 py-1.5"
          >
            <span className="relative shrink-0">
              <Avatar name={m.name} size={24} role={m.role} />
              <PresenceDot
                presence="online"
                size={8}
                className="absolute -bottom-0 -right-0"
              />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-text truncate font-medium">{m.name}</div>
              <div className="mono-caps text-[10px] text-textFaint truncate">
                @{m.username}
              </div>
            </div>
            <Badge tone={m.role === "admin" ? "brass" : "neutral"}>{m.role}</Badge>
            {isAdmin && m.username !== user.username && (
              <button
                className="text-textMuted hover:text-rust p-0.5"
                title="Remove from panel"
                aria-label="Remove from panel"
                onClick={() => onRemove(m.user_id)}
              >
                <XIcon size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <div className="pt-2 border-t border-borderSoft">
          <AddMemberPicker
            allUsers={allUsers}
            existingIds={detail.members.map((m) => m.user_id)}
            onAdd={onAdd}
          />
        </div>
      )}
    </div>
  );
}

function SkillsTab({
  granted,
  available,
  onToggle,
  isAdmin,
}: {
  granted: PanelSkillRow[];
  available: AvailableSkill[];
  onToggle: (id: string) => void;
  isAdmin: boolean;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-textMuted">
        Skills are reusable agent behaviours ({granted.length} granted on this panel).
      </p>
      {granted.length > 0 && (
        <ul className="space-y-1.5">
          {granted.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 bg-panelAlt border border-border px-2 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-text truncate font-medium">{s.name}</div>
                <div className="mono-caps text-[10px] text-textFaint truncate">
                  {s.kind} · {s.scope}
                </div>
              </div>
              <Badge
                tone={s.kind === "tool" ? "teal" : s.kind === "workflow" ? "brass" : "neutral"}
              >
                {s.kind}
              </Badge>
              {isAdmin && (
                <button
                  className="text-textMuted hover:text-rust p-0.5"
                  title="Revoke skill from panel"
                  aria-label="Revoke skill"
                  onClick={() => onToggle(s.id)}
                >
                  <XIcon size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 ? (
        <SkillGrantPicker
          grantedIds={granted.map((s) => s.id)}
          available={available}
          onToggle={(id) => onToggle(id)}
        />
      ) : (
        <div className="mono-caps text-[10px] text-textFaint">
          no skills available — ask an admin to create one on /skills
        </div>
      )}
    </div>
  );
}

// Tier 4 (Discovery): conversation summarisation settings. Lets the
// user collapse every message older than N days into a single summary
// message — runs once on demand. We keep the originals (so audit
// survives) and just front-load the new summary message.
//
// Tier 6 — auto-summarize (the second Run button) re-chunks the panel
// in 20-message windows and persists each chunk as a `system` row whose
// metadata lists the source message ids. Originals are preserved.
function SummaryTab({
  panelId,
  onCollapsed,
}: {
  panelId: string;
  onCollapsed: () => void;
}) {
  const { addToast } = useToast();
  const [days, setDays] = useState(7);
  const [running, setRunning] = useState(false);
  const [autoDays, setAutoDays] = useState(30);
  const [autoRunning, setAutoRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      const r = await apiPost<{ ok: boolean; collapsed?: number; error?: string }>(
        `/panels/${panelId}/summarize?days=${days}`,
      );
      if (r.ok) {
        addToast({
          id: `sum-${Date.now()}`,
          title: "Summarised",
          description: `Collapsed ${r.collapsed ?? 0} message${r.collapsed === 1 ? "" : "s"} into one summary.`,
          tone: "info",
          duration: 2500,
        });
        onCollapsed();
      } else {
        addToast({
          id: `sum-err-${Date.now()}`,
          title: "Summarise failed",
          description: r.error ?? "unknown",
          tone: "warning",
          duration: 3500,
        });
      }
    } catch (err) {
      addToast({
        id: `sum-err-${Date.now()}`,
        title: "Summarise failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 3500,
      });
    } finally {
      setRunning(false);
    }
  }
  async function runAuto() {
    setAutoRunning(true);
    try {
      const r = await apiPost<{
        chunks: number;
        summaries_inserted: number;
        source_messages: number;
      }>(`/panels/${panelId}/auto-summarize?days=${autoDays}`);
      addToast({
        id: `autosum-${Date.now()}`,
        title: "Auto-summary done",
        description: `${r.summaries_inserted} chunk${r.summaries_inserted === 1 ? "" : "s"} · ${r.source_messages} source message${r.source_messages === 1 ? "" : "s"}`,
        tone: "info",
        duration: 3000,
      });
      onCollapsed();
    } catch (err) {
      addToast({
        id: `autosum-err-${Date.now()}`,
        title: "Auto-summarise failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 3500,
      });
    } finally {
      setAutoRunning(false);
    }
  }
  return (
    <div className="space-y-4">
      {/* Tier 4 — single-shot summarise into one summary row. */}
      <div className="space-y-2">
        <p className="text-[12px] text-textMuted">
          Collapse every message older than N days into a single summary.
          Originals are kept so audit + time-travel still work — the
          summary just gets prepended to the next agent turn.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <span className="mono-caps text-[10px] text-textFaint">older than</span>
          <Input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 7))}
            className="w-20 h-8 mono-caps text-[12px]"
          />
          <span className="mono-caps text-[10px] text-textFaint">days</span>
          <Button variant="primary" size="sm" onClick={run} disabled={running}>
            {running ? "Running…" : "Run"}
          </Button>
        </div>
      </div>

      {/* Tier 6 — auto-summarise in 20-message chunks. Each chunk
          becomes its own `system` row tagged with the source ids so
          the originals remain queryable. */}
      <div className="space-y-2 pt-3 border-t border-borderSoft">
        <p className="text-[12px] text-textMuted">
          Auto-summarise older than N days. Messages are chunked in
          groups of 20 and each chunk becomes its own summary — useful
          for long-running panels where one giant blob would lose detail.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <span className="mono-caps text-[10px] text-textFaint">older than</span>
          <Input
            type="number"
            min={1}
            max={365}
            value={autoDays}
            onChange={(e) => setAutoDays(Math.max(1, Number(e.target.value) || 30))}
            className="w-20 h-8 mono-caps text-[12px]"
          />
          <span className="mono-caps text-[10px] text-textFaint">days</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={runAuto}
            disabled={autoRunning}
          >
            {autoRunning ? "Running…" : "Run"}
          </Button>
        </div>
      </div>

      <div className="pt-2 border-t border-borderSoft mono-caps text-[10px] text-textFaint">
        Tip: pair this with /kg → Extract from selection on the same
        message to seed the knowledge graph.
      </div>
    </div>
  );
}

function KnowledgeTab({
  docs,
  name,
  text,
  setName,
  setText,
  onUpload,
}: {
  docs: KnowledgeDoc[];
  name: string;
  text: string;
  setName: (v: string) => void;
  setText: (v: string) => void;
  onUpload: () => void | Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-textMuted">
        Docs the agent can search before answering. {docs.length} doc(s) indexed.
      </p>
      {docs.length > 0 && (
        <ul className="space-y-1.5">
          {docs.map((k) => (
            <li
              key={k.id}
              className="bg-panelAlt border border-border px-2 py-1.5"
            >
              <div className="text-[12px] text-text truncate font-medium">{k.name}</div>
              <div className="mono-caps text-[10px] text-textFaint">
                {k.chunk_count} chunks · {k.total_tokens ?? "?"} tokens ·{" "}
                {new Date(k.uploaded_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="pt-2 border-t border-borderSoft space-y-2">
        <Input
          name="knowledge-name"
          placeholder="Doc name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="Paste text. We chunk on word boundaries (~200 words per chunk) and build a tsvector index for retrieval."
          className="w-full bg-bg border border-border text-text px-3 py-2 font-mono text-[12px] resize-none focus:border-brass"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={onUpload}
          disabled={!name.trim() || !text.trim()}
        >
          Index doc
        </Button>
      </div>
    </div>
  );
}

// ─── Mention picker (kept inline; small enough to live with the page) ─────

function MentionPicker({
  models,
  query,
  selectedIdx,
  onHover,
  onPick,
}: {
  models: AvailableModel[];
  query: string;
  selectedIdx: number;
  onHover: (i: number) => void;
  onPick: (m: AvailableModel) => void;
}) {
  const filtered = models.filter(
    (m) =>
      m.display_name.toLowerCase().includes(query.toLowerCase()) ||
      m.external_id.toLowerCase().includes(query.toLowerCase()) ||
      m.provider_type.toLowerCase().includes(query.toLowerCase()),
  );
  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-2 z-20">
        <div className="bg-panel border border-borderSoft rounded-none shadow-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-textFaint">@</span>
            <span className="font-mono text-[12px] text-text">{query || "…"}</span>
          </div>
          <div className="mt-2 mono-caps text-[10px] text-textFaint">
            no models match · ask an admin to add or grant access
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-20">
      <div className="bg-panel border border-brassSoft/60 shadow-2xl">
        <div className="px-4 py-2 border-b border-borderSoft bg-panelAlt flex items-center justify-between">
          <span className="mono-caps text-[10px] text-brass">
            Mention a model
          </span>
          <span className="mono-caps text-[10px] text-textFaint">
            ↑↓ pick · ↵ send · esc close
          </span>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {filtered.map((m, i) => {
            const isActive = i === selectedIdx;
            const providerColor = providerAccent(m.provider_type);
            return (
              <button
                key={m.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(m);
                }}
                onMouseEnter={() => onHover(i)}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 border-l-2 transition-colors ${
                  isActive
                    ? "bg-brass/10 text-text border-brass"
                    : "border-transparent text-text hover:bg-panelAlt/60"
                }`}
              >
                <span
                  className="w-2 h-8 rounded-none shrink-0"
                  style={{ backgroundColor: providerColor }}
                  title={m.provider_type}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[13px] text-text truncate">
                    {m.display_name}
                  </div>
                  <div className="font-mono text-[10px] text-textFaint truncate mt-0.5">
                    {m.provider_type} · {m.external_id}
                  </div>
                </div>
                {m.assigned ? (
                  <span className="inline-flex items-center gap-1 mono-caps text-[10px] text-teal border border-teal/40 bg-teal/10 px-1.5 py-0.5 shrink-0">
                    <span className="w-1 h-1 bg-teal rounded-full" />
                    ON
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 mono-caps text-[10px] text-textMuted border border-borderSoft bg-bg/40 px-1.5 py-0.5 shrink-0">
                    <span className="w-1 h-1 bg-textFaint rounded-full" />
                    OFF
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {query && filtered.length > 0 && (
          <div className="px-4 py-2 border-t border-borderSoft bg-panelAlt mono-caps text-[10px] text-textFaint">
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </div>
        )}
      </div>
    </div>
  );
}

function providerAccent(t: string): string {
  const k = t.toLowerCase();
  if (k.includes("anthropic")) return "#C9A227";
  if (k.includes("openai")) return "#4C9C90";
  if (k.includes("deepseek")) return "#7DA8D9";
  if (k.includes("minimax") || k.includes("minimax")) return "#9CB87C";
  if (k.includes("z-ai") || k.includes("glm")) return "#D89B5C";
  if (k.includes("brave")) return "#B98FC2";
  if (k.includes("serp")) return "#86C292";
  return "#8A9098";
}

// ─── Skill grant picker (kept inline) ─────────────────────────────────────

function SkillGrantPicker({
  grantedIds,
  available,
  onToggle,
}: {
  grantedIds: string[];
  available: AvailableSkill[];
  onToggle: (id: string) => void;
}) {
  const granted = grantedIds; // local alias for the granted set
  const sorted = [...available].sort((a, b) => {
    const ag = grantedIds.includes(a.id) ? 1 : 0;
    const bg = grantedIds.includes(b.id) ? 1 : 0;
    return ag - bg;
  });
  if (sorted.length === 0) {
    return (
      <div className="mono-caps text-[10px] text-textFaint">
        no skills available — ask an admin to create one on /skills
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {sorted.map((s) => {
        const granted = grantedIds.includes(s.id);
        return (
          <li
            key={s.id}
            className="flex items-center gap-2 bg-panelAlt border border-border px-2 py-1.5"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-text truncate font-medium">{s.name}</div>
              <div className="mono-caps text-[10px] text-textFaint truncate">
                {s.kind} · {s.scope}
                {s.description ? ` · ${s.description}` : ""}
              </div>
            </div>
            {granted ? (
              <span className="inline-flex items-center gap-1 mono-caps text-[10px] text-teal border border-teal/40 bg-teal/10 px-1.5 py-0.5 shrink-0">
                <CheckIcon size={10} />
                on
              </span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onToggle(s.id)}
                title="Grant skill to panel"
              >
                <PlusIcon size={10} />
                grant
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AddMemberPicker({
  allUsers,
  existingIds,
  onAdd,
}: {
  allUsers: AvailableUser[];
  existingIds: string[];
  onAdd: (id: string) => Promise<void> | void;
}) {
  const candidates = allUsers.filter((u) => !existingIds.includes(u.id));
  if (candidates.length === 0) {
    return (
      <div className="mono-caps text-[10px] text-textFaint">
        every user is already on this panel
      </div>
    );
  }
  const [picked, setPicked] = useState<string>("");
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-2">
      <p className="mono-caps text-[10px] text-textMuted">Add a member</p>
      <select
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="w-full h-8 bg-panelAlt border border-border text-text px-2 font-mono text-[12px]"
      >
        <option value="">— pick a user —</option>
        {candidates.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} (@{u.username}) — {u.role}
          </option>
        ))}
      </select>
      <Button
        variant="primary"
        size="sm"
        disabled={!picked || adding}
        onClick={async () => {
          if (!picked) return;
          setAdding(true);
          try {
            await onAdd(picked);
            setPicked("");
          } finally {
            setAdding(false);
          }
        }}
      >
        {adding ? "adding…" : "Add member"}
      </Button>
    </div>
  );
}

// ─── Tier 1: Approval overlay (inline above the chat input) ────────────────

// ─── Tier 6: PanelFeedbackRow ──────────────────────────────────────────────
//
// Thumbs-up / thumbs-down under each assistant message in a panel. Click
// thumb-down → inline reason input → submit to /combo/feedback. Toast
// on save keeps the action visible without crowding the bubble.
function PanelFeedbackRow({
  messageId,
  onRated,
}: {
  messageId: string;
  onRated: (r: "up" | "down") => void;
}) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(r: "up" | "down", reasonText?: string) {
    setBusy(true);
    try {
      await apiPost("/combo/feedback", {
        message_id: messageId,
        rating: r,
        reason: reasonText ?? null,
      });
      setRating(r);
      setAskingReason(false);
      onRated(r);
    } catch {
      /* ignore — user can retry */
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
        <button
          type="button"
          aria-label="Thumbs up"
          title="Helpful"
          disabled={busy || rating !== null}
          onClick={() => void submit("up")}
          className={cn(
            "inline-flex items-center justify-center w-5 h-5 border transition-colors",
            rating === "up"
              ? "border-teal/60 bg-teal/10 text-teal"
              : "border-transparent text-textFaint hover:text-teal hover:border-teal/40",
          )}
        >
          <ThumbsUpIcon size={10} />
        </button>
        <button
          type="button"
          aria-label="Thumbs down"
          title="Not helpful"
          disabled={busy || rating !== null}
          onClick={() => {
            setAskingReason(true);
          }}
          className={cn(
            "inline-flex items-center justify-center w-5 h-5 border transition-colors",
            rating === "down"
              ? "border-rust/60 bg-rust/10 text-rust"
              : "border-transparent text-textFaint hover:text-rust hover:border-rust/40",
          )}
        >
          <ThumbsDownIcon size={10} />
        </button>
        {rating && (
          <span
            className={cn(
              "mono-caps text-[9px] tracking-wider",
              rating === "up" ? "text-teal" : "text-rust",
            )}
          >
            {rating === "up" ? "marked helpful" : "marked not helpful"}
          </span>
        )}
      </div>
      {askingReason && rating === null && (
        <div className="flex items-center gap-1.5 max-w-[420px]">
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
            onClick={() => void submit("down", reason.trim() || undefined)}
            disabled={busy}
            className="mono-caps text-[10px] tracking-wider px-2 h-6 border border-rust/40 bg-rust/10 text-rust hover:bg-rust/20"
          >
            submit
          </button>
          <button
            type="button"
            onClick={() => void submit("down")}
            disabled={busy}
            className="mono-caps text-[10px] tracking-wider px-2 h-6 border border-borderSoft text-textMuted hover:text-rust"
          >
            skip
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Tier 6: SelfTestBadge ─────────────────────────────────────────────────
//
// Polls /api/messages/:id/self-test once per message render. Shows a small
// teal "self-checked" chip when the agent's reply passed its own quality
// checks, or a rust "flagged" chip with the issues inline when it didn't.
function SelfTestBadge({ messageId }: { messageId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "passed" }
    | { kind: "failed"; issues: string[] }
  >({ kind: "idle" });
  useEffect(() => {
    let cancelled = false;
    apiGet<{
      available: boolean;
      result?: {
        passed: boolean;
        checks: Array<{ name: string; passed: boolean; note?: string }>;
      };
    }>(`/chat/messages/${messageId}/self-test`)
      .then((res) => {
        if (cancelled) return;
        if (!res.available || !res.result) return;
        if (res.result.passed) {
          setState({ kind: "passed" });
        } else {
          const issues = res.result.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name}${c.note ? ` — ${c.note}` : ""}`);
          setState({ kind: "failed", issues });
        }
      })
      .catch(() => {
        /* silent — chip stays hidden if judge isn't ready */
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);
  if (state.kind === "idle") return null;
  if (state.kind === "passed") {
    return (
      <span
        className="inline-flex items-center gap-1 mono-caps text-[10px] text-teal border border-teal/40 bg-teal/10 px-1.5 h-[16px]"
        title="Self-test passed all checks"
      >
        <CheckIcon size={9} />
        self-checked
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 mono-caps text-[10px] text-rust border border-rust/40 bg-rust/10 px-1.5 h-[16px]"
      title={`Self-test failed: ${state.issues.join("; ")}`}
    >
      <AlertTriangleIcon size={9} />
      flagged
    </span>
  );
}

// ─── Tier 1: Approval overlay (inline above the chat input) ────────────────

function ApprovalOverlay({
  approval,
  onDecide,
  onDismiss,
}: {
  approval: Approval;
  onDecide: (decision: "approved" | "denied") => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState<"approved" | "denied" | null>(null);
  return (
    <div className="border-t border-brass/50 bg-panel p-3 shrink-0">
      <div className="flex items-start gap-3 border border-brass/40 bg-bg p-3">
        <div className="shrink-0 mt-0.5">
          <span className="inline-block w-2 h-2 rounded-full bg-brass animate-pulse" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-semibold text-text">
              Approval required
            </span>
            <Badge tone="brass">{approval.tool_name}</Badge>
          </div>
          {approval.reason && (
            <p className="mt-1 text-[12px] text-textMuted leading-[1.5]">
              {approval.reason}
            </p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer mono-caps text-[10px] text-textMuted hover:text-brass">
              args preview
            </summary>
            <pre className="mt-1.5 px-2 py-1.5 bg-panelAlt border border-borderSoft text-[11px] font-mono text-textMuted overflow-x-auto max-h-32">
              {JSON.stringify(approval.tool_args, null, 2)}
            </pre>
          </details>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("approved");
              try {
                await onDecide("approved");
              } finally {
                setBusy(null);
              }
            }}
          >
            <CheckIcon size={12} />
            {busy === "approved" ? "approving…" : "Approve"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("denied");
              try {
                await onDecide("denied");
              } finally {
                setBusy(null);
              }
            }}
          >
            <XIcon size={12} />
            {busy === "denied" ? "denying…" : "Deny"}
          </Button>
          <button
            type="button"
            className="mono-caps text-[10px] text-textFaint hover:text-textMuted"
            onClick={onDismiss}
          >
            dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
