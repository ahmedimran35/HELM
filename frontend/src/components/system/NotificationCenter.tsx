// NotificationCenter — the bell in the top-right of the workspace
// header. Polls /api/notifications every 30s for the unread count, and
// opens a dropdown with the 20 most recent items on click.
//
// Each row is keyboard-accessible: click marks the notification read
// and navigates to its `link` in one step. Clicking outside the panel
// closes it. Refreshing the visible list after a mark-read keeps the
// unread badge honest.
//
// Priority bands drive the left-edge accent:
//   urgent   → rust
//   high     → brass
//   normal   → textFaint
//   low      → border

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../../api/client";
import { BellIcon, CheckIcon } from "../ui/Icon";
import { cn } from "../../lib/cn";

type Priority = "low" | "normal" | "high" | "urgent";
type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  priority: Priority;
  read_at: string | null;
  created_at: string;
};

const PRIORITY_ACCENT: Record<Priority, string> = {
  urgent: "border-l-rust",
  high: "border-l-brass",
  normal: "border-l-textFaint",
  low: "border-l-border",
};

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "URGENT",
  high: "HIGH",
  normal: "NORMAL",
  low: "LOW",
};

const KIND_LABEL: Record<string, string> = {
  budget_alert: "Budget",
  approval_needed: "Approval",
  summary_due: "Summary",
  mention: "Mention",
  general: "General",
};

export function NotificationCenter() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Poll the unread count every 30s; light fetch — the endpoint only
  // returns the count + last 20 items.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiGet<{ rows: Notification[]; unread: number }>("/notifications?limit=20");
        if (cancelled) return;
        setUnread(r.unread);
        setItems(r.rows ?? []);
      } catch {
        if (!cancelled) {
          setUnread(0);
          setItems([]);
        }
      }
    };
    tick();
    const handle = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  async function markRead(id: string) {
    await apiPost(`/notifications/${id}/read`);
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
  }

  async function markAllRead() {
    await apiPost(`/notifications/read-all`);
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnread(0);
  }

  async function activate(n: Notification) {
    if (!n.read_at) await markRead(n.id);
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        onClick={() => setOpen((v) => !v)}
        className="relative text-textMuted hover:text-text p-1.5"
        title={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "No new notifications"}
      >
        <BellIcon size={16} />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 mono-caps text-[9px] tabular-nums px-1 min-w-[16px] h-[16px] inline-flex items-center justify-center bg-rust text-text rounded-full"
            aria-hidden
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[380px] max-w-[92vw] bg-panel border border-border shadow-2xl z-[120]"
          role="dialog"
          aria-label="Notifications"
        >
          <header className="flex items-center justify-between px-3 py-2 border-b border-borderSoft">
            <div>
              <h3 className="font-display text-[14px] text-text font-semibold">Notifications</h3>
              <p className="mono-caps text-[10px] text-textFaint">
                {unread > 0 ? `${unread} unread` : "all caught up"}
              </p>
            </div>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              className={cn(
                "mono-caps text-[10px] px-2 h-7 border",
                unread === 0
                  ? "border-borderSoft text-textFaint cursor-not-allowed"
                  : "border-brassSoft text-brass hover:border-brass",
              )}
            >
              Mark all read
            </button>
          </header>
          <ul className="max-h-[420px] overflow-y-auto divide-y divide-borderSoft">
            {items.length === 0 && (
              <li className="px-4 py-6 text-textMuted mono-caps text-[10px] text-center">
                nothing here yet
              </li>
            )}
            {items.map((n) => {
              const age = formatAge(n.created_at);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => activate(n)}
                    className={cn(
                      "block w-full text-left px-3 py-2.5 border-l-2 hover:bg-panelAlt flex items-start gap-2",
                      PRIORITY_ACCENT[n.priority] ?? PRIORITY_ACCENT.normal,
                      !n.read_at && "bg-brass/[0.04]",
                    )}
                  >
                    {!n.read_at && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-brass mt-1.5 shrink-0"
                        aria-hidden
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-text font-medium truncate">
                          {n.title}
                        </span>
                        <span className="mono-caps text-[9px] text-textFaint whitespace-nowrap">
                          {PRIORITY_LABEL[n.priority] ?? "NORMAL"} · {KIND_LABEL[n.kind] ?? "General"}
                        </span>
                      </div>
                      {n.body && (
                        <p className="text-[12px] text-textMuted line-clamp-2 mt-0.5">
                          {n.body}
                        </p>
                      )}
                      <div className="mt-1 flex items-center justify-between">
                        <span className="mono-caps text-[9px] text-textFaint">{age}</span>
                        {n.read_at && (
                          <span className="mono-caps text-[9px] text-textFaint inline-flex items-center gap-1">
                            <CheckIcon size={9} /> read
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <footer className="border-t border-borderSoft px-3 py-2 flex items-center justify-between">
            <span className="mono-caps text-[10px] text-textFaint">auto-refresh 30s</span>
            <button
              type="button"
              onClick={async () => {
                await apiGet<{ rows: Notification[]; unread: number }>("/notifications?limit=20").then((r) => {
                  setItems(r.rows ?? []);
                  setUnread(r.unread);
                });
              }}
              className="mono-caps text-[10px] text-textFaint hover:text-text"
            >
              refresh
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function formatAge(iso: string): string {
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
