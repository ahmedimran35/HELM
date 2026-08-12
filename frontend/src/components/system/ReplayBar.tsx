// ReplayBar + ReplayPage — Tier 1 co-pilot: time-travel debugging.
//
// Two surfaces:
//   1. <ReplayBranchButton/> on each assistant message in Panels.tsx —
//      hover the message, see a "branch from here" button, click to
//      fork a new panel seeded with everything up to that turn.
//   2. <ReplayPage/> — a /replay/:panelId route that lists every
//      snapshot for the panel as a vertical timeline; click one to
//      scrub the message list to that point in time.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../api/client";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { CallSign } from "../ui/CallSign";
import { EmptyState } from "../ui/feedback/EmptyState";
import { Markdown } from "../ui/Markdown";
import { useToast } from "../ui/feedback/Toast";
import { cn } from "../../lib/cn";

interface SnapshotMessage {
  id: string;
  role: string;
  content: string;
  user_id: string | null;
  model_id: string | null;
  tokens: number;
  created_at: string;
  sender_name: string | null;
}

interface SnapshotState {
  panel_id: string;
  panel_name: string;
  agent_model_id: string | null;
  agent_model_name: string | null;
  persona_id: string | null;
  persona_name: string | null;
  member_count: number;
  messages: SnapshotMessage[];
}

interface SnapshotRow {
  id: string;
  panel_id: string;
  message_id: string;
  user_id: string;
  state: SnapshotState;
  label: string | null;
  created_at: string;
}

// ─── Branch button (used in Panels.tsx) ─────────────────────────────────────

/**
 * ReplayBranchButton — small ghost button that hovers over each
 * assistant message. Click it to fork a new panel seeded with every
 * message up to and including this one.
 */
export function ReplayBranchButton({
  panelId,
  messageId,
}: {
  panelId: string;
  messageId: string;
}) {
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function fork() {
    setBusy(true);
    try {
      const created = await apiPost<{ id: string; name: string }>(
        `/panels/${panelId}/replay`,
        { from_message_id: messageId },
      );
      addToast({
        id: `branch-${created.id}`,
        title: "Branched",
        description: created.name,
        tone: "info",
        duration: 3000,
      });
      navigate(`/panels`);
      // Soft-select: the parent will pick it up via the panel list refresh.
      // We don't navigate to the new panel directly because the URL
      // shape lives in Panels.tsx, not here.
      window.dispatchEvent(
        new CustomEvent("helm:branch-created", { detail: created }),
      );
    } catch (err) {
      addToast({
        id: `branch-err-${Date.now()}`,
        title: "Branch failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 4000,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={fork}
      disabled={busy}
      title="Branch a new panel from this message"
      className="opacity-0 group-hover:opacity-100 transition-opacity"
    >
      {busy ? "branching…" : "↳ branch"}
    </Button>
  );
}

// ─── Replay page (/replay/:panelId) ─────────────────────────────────────────

export function ReplayPage() {
  const params = useParams<{ panelId: string }>();
  const panelId = params.panelId;
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!panelId) return;
    let cancelled = false;
    setLoading(true);
    apiGet<SnapshotRow[]>(`/panels/${panelId}/replay`)
      .then((rows) => {
        if (cancelled) return;
        setSnapshots(rows);
        if (rows.length > 0) setActive(rows[rows.length - 1]!.id);
      })
      .catch(() => {
        if (!cancelled) setSnapshots([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [panelId]);

  const activeSnapshot = useMemo(
    () => snapshots.find((s) => s.id === active) ?? null,
    [snapshots, active],
  );

  if (!panelId) {
    return (
      <div className="p-6">
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2 inline-block">
          missing panel id
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="mono-caps text-[11px] text-textFaint">loading replay…</div>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <EmptyState
          variant="ledger"
          title="No snapshots yet"
          description="Once the agent replies in this panel, each turn will be checkpointed here for replay and branching."
          tone="brass"
        />
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* Timeline column */}
      <aside className="w-[300px] shrink-0 border-r border-border bg-panel flex flex-col">
        <div className="px-4 py-3 border-b border-borderSoft">
          <span className="mono-caps text-[10px] text-textMuted">Replay</span>
          <div className="mt-0.5 font-display text-[14px] font-semibold text-text truncate">
            {activeSnapshot?.state.panel_name ?? "panel"}
          </div>
        </div>
        <ol className="flex-1 overflow-y-auto">
          {snapshots.map((s, i) => {
            const isActive = s.id === active;
            const label = s.label || `turn ${i + 1}`;
            const msg = s.state.messages[s.state.messages.length - 1];
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setActive(s.id)}
                  className={cn(
                    "w-full text-left px-4 py-3 border-l-2 transition-colors",
                    isActive
                      ? "border-brass bg-panelAlt"
                      : "border-transparent hover:bg-panelAlt/60",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-text">
                      {label}
                    </span>
                    <span className="ml-auto mono-caps text-[10px] text-textFaint">
                      {new Date(s.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {msg && (
                    <div className="mt-0.5 text-[11px] text-textMuted truncate">
                      {msg.sender_name ?? msg.role} ·{" "}
                      {msg.content.slice(0, 60)}
                      {msg.content.length > 60 ? "…" : ""}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      {/* Detail column */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        {activeSnapshot ? (
          <>
            <div className="h-12 border-b border-border bg-panel flex items-center px-4 gap-3 shrink-0">
              <CallSign
                id={`PNL-${activeSnapshot.panel_id.slice(0, 4).toUpperCase()}`}
              />
              <span className="font-display text-[14px] font-semibold text-text truncate">
                {activeSnapshot.state.panel_name}
              </span>
              <Badge tone="brass">
                {activeSnapshot.state.messages.length} messages
              </Badge>
              {activeSnapshot.state.agent_model_name && (
                <Badge tone="neutral">
                  agent · {activeSnapshot.state.agent_model_name}
                </Badge>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeSnapshot.state.messages.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "flex gap-3",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {m.role !== "user" && (
                    <div className="pt-1">
                      <Avatar
                        name={m.sender_name ?? m.role}
                        size={28}
                      />
                    </div>
                  )}
                  <div className="max-w-[70%]">
                    <div className="flex items-center gap-2 px-1 mb-1">
                      <span className="font-display text-[13px] font-semibold text-text">
                        {m.sender_name ?? m.role}
                      </span>
                      <Badge tone={m.role === "user" ? "teal" : "brass"}>
                        {m.role}
                      </Badge>
                      <span className="mono-caps text-[10px] text-textFaint">
                        {new Date(m.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="px-3 py-2 border border-brassSoft/40 bg-bg">
                      <div className="text-[13px] leading-relaxed">
                        {m.role === "user" ? (
                          <span className="whitespace-pre-wrap">
                            {m.content}
                          </span>
                        ) : (
                          <Markdown content={m.content} />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <span className="mono-caps text-[11px] text-textFaint">
              pick a snapshot
            </span>
          </div>
        )}
      </div>
    </div>
  );
}