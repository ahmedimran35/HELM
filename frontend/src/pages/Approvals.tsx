// Approvals — Tier 1 co-pilot: inline approval gates UI.
//
// Lists pending approval_requests for the current user. Each row shows
// the tool, args preview, time remaining, and Approve / Deny buttons.
// Admins see their own + (read-only) everyone else's. Non-admins see
// only what they own.
//
// The page also polls `/api/approvals?status=pending` every 15s so a
// newly-arrived request from the agent shows up without a manual
// refresh. Status filter is a small pill row at the top.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { Avatar } from "../components/ui/Avatar";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import { CheckIcon, XIcon, ClockIcon } from "../components/ui/Icon";
import { cn } from "../lib/cn";

type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

interface Approval {
  id: string;
  user_id: string;
  panel_id: string | null;
  tool_name: string;
  tool_args: Record<string, unknown>;
  reason: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
}

const STATUS_TABS: ReadonlyArray<{ id: ApprovalStatus; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Approved" },
  { id: "denied", label: "Denied" },
  { id: "expired", label: "Expired" },
];

function timeRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m >= 1) return `${m}m ${s}s left`;
  return `${s}s left`;
}

export function ApprovalsPage() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [active, setActive] = useState<ApprovalStatus>("pending");
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);

  const isAdmin = user?.role === "admin";

  // Reload whenever the tab changes. Pending also refreshes itself
  // on a 15s timer — once an approval is decided the row moves to
  // a different tab automatically.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const rows = await apiGet<Approval[]>(`/approvals?status=${active}`);
        if (!cancelled) setItems(rows);
      } catch (err) {
        addToast({
          id: `approvals-load-${Date.now()}`,
          title: "Couldn't load approvals",
          description: (err as Error).message,
          tone: "warning",
          duration: 3500,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    if (active !== "pending") return;
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, addToast]);

  async function decide(id: string, decision: "approved" | "denied") {
    try {
      const updated = await apiPost<Approval>(`/approvals/${id}/decide`, {
        decision,
      });
      // Move the row out of the pending list immediately so the UI
      // feels responsive. The next poll will refresh from the server.
      setItems((cur) => cur.filter((r) => r.id !== id));
      addToast({
        id: `approval-${decision}-${id}`,
        title: decision === "approved" ? "Approved" : "Denied",
        description: `${updated.tool_name} on ${updated.panel_id ?? "(no panel)"}`,
        tone: decision === "approved" ? "success" : "warning",
        duration: 3000,
      });
    } catch (err) {
      addToast({
        id: `approval-err-${id}`,
        title: "Decision failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 4000,
      });
    }
  }

  const counts = useMemo(() => {
    const map: Record<ApprovalStatus, number> = {
      pending: 0,
      approved: 0,
      denied: 0,
      expired: 0,
    };
    for (const it of items) map[it.status] += 1;
    return map;
  }, [items]);

  if (!user) return null;

  return (
    <div className="h-full overflow-y-auto p-6 max-w-[920px] mx-auto">
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-text">
          Approvals
        </h1>
        <p className="mt-1 text-[13px] text-textMuted leading-relaxed">
          Tools the agent wants to run, paused until a human signs off.
          {isAdmin
            ? " As an admin you can decide any user's approvals."
            : " Approve or deny the requests you've been asked about."}
        </p>
      </div>

      {/* Tab strip — keep it simple, no routing, just a local state. */}
      <div className="flex border-b border-border mb-4">
        {STATUS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            className={cn(
              "px-4 py-2 mono-caps text-[11px] border-b-2 transition-colors",
              active === t.id
                ? "border-brass text-text"
                : "border-transparent text-textMuted hover:text-text",
            )}
          >
            {t.label}
            {counts[t.id] > 0 && (
              <span className="ml-1.5 text-textFaint">{counts[t.id]}</span>
            )}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="mono-caps text-[11px] text-textFaint py-12 text-center">
          loading…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          variant="allClear"
          title={active === "pending" ? "Nothing pending" : `No ${active} approvals`}
          description={
            active === "pending"
              ? "The agent hasn't asked for permission to do anything destructive lately."
              : "When the agent requests a tool and you decide, it'll show up here."
          }
          tone="teal"
        />
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              currentUserId={user.id}
              isAdmin={isAdmin}
              onDecide={decide}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────────

function ApprovalCard({
  approval,
  currentUserId,
  isAdmin,
  onDecide,
}: {
  approval: Approval;
  currentUserId: string;
  isAdmin: boolean;
  onDecide: (id: string, decision: "approved" | "denied") => Promise<void>;
}) {
  const canDecide =
    approval.status === "pending" &&
    (approval.user_id === currentUserId || isAdmin);

  const argsJson = useMemo(() => {
    try {
      return JSON.stringify(approval.tool_args, null, 2);
    } catch {
      return "(unserialisable args)";
    }
  }, [approval.tool_args]);

  return (
    <li className="bg-panelAlt border border-border p-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <Avatar
            name={
              approval.user_id === currentUserId
                ? "you"
                : approval.panel_id ?? approval.user_id
            }
            size={28}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-[14px] font-semibold text-text">
              {approval.tool_name}
            </span>
            <Badge tone={badgeTone(approval.status)}>{approval.status}</Badge>
            {approval.panel_id && (
              <span className="mono-caps text-[10px] text-textFaint">
                panel · {approval.panel_id.slice(0, 8)}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1 mono-caps text-[10px] text-textFaint">
              <ClockIcon size={10} />
              {timeRemaining(approval.expires_at)}
            </span>
          </div>
          {approval.reason && (
            <p className="mt-1 text-[12px] text-textMuted leading-[1.5]">
              {approval.reason}
            </p>
          )}
          <details className="mt-2 group">
            <summary className="cursor-pointer mono-caps text-[10px] text-textMuted hover:text-brass">
              args preview
            </summary>
            <pre className="mt-1.5 px-2 py-1.5 bg-bg border border-borderSoft text-[11px] font-mono text-textMuted overflow-x-auto max-h-48">
              {argsJson}
            </pre>
          </details>
          <div className="mt-3 flex items-center gap-2">
            {canDecide ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void onDecide(approval.id, "approved")}
                >
                  <CheckIcon size={12} />
                  Approve
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void onDecide(approval.id, "denied")}
                >
                  <XIcon size={12} />
                  Deny
                </Button>
              </>
            ) : (
              <span className="mono-caps text-[10px] text-textFaint">
                decided by{" "}
                {approval.decided_by ? approval.decided_by.slice(0, 8) : "system"}
                {approval.decided_at
                  ? ` · ${new Date(approval.decided_at).toLocaleString()}`
                  : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function badgeTone(status: ApprovalStatus): "brass" | "teal" | "rust" | "neutral" {
  switch (status) {
    case "approved":
      return "teal";
    case "denied":
    case "expired":
      return "rust";
    default:
      return "brass";
  }
}