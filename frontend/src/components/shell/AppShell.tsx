// AppShell — fixed left sidebar + flexible right canvas. Wraps every
// authenticated page. v2 adds:
//   - a thin status banner above the workspace header that shows
//     cluster-wide health (degraded → rust, healthy → teal).
//   - a `data-route` attribute on <main> so the CSS route-transition
//     animation kicks in on every navigation.
//   - body scroll lock when the mobile drawer is open.

import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { AlertTriangleIcon, CheckIcon } from "../ui/Icon";
import { apiGet } from "../../api/client";

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();

  // Lock body scroll while the mobile drawer is open so the page under
  // doesn't drift when the user tries to scroll the nav.
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
    return;
  }, [open]);

  return (
    <div className="h-full flex bg-bg">
      {/* Desktop sidebar */}
      <div className="hidden md:block h-full">
        <Sidebar />
      </div>
      {/* Mobile drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="h-full">
            <Sidebar onNavigate={() => setOpen(false)} />
          </div>
          <button
            aria-label="Close sidebar"
            onClick={() => setOpen(false)}
            className="flex-1 bg-black/60"
          />
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="md:hidden h-10 border-b border-border bg-bg flex items-center px-3">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open sidebar"
            className="mono-caps text-[11px] text-brass border border-brassSoft px-2 h-7"
          >
            ☰ Menu
          </button>
          <span className="ml-3 font-display tracking-[0.18em] text-text">HELM</span>
        </div>
        <SystemBanner />
        <WorkspaceHeader />
        <main key={loc.pathname} data-route className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

interface HealthResp {
  ok: boolean;
  ts: number;
}

/**
 * A thin cluster-status banner that sits between the mobile menu bar and
 * the workspace header. It only renders when something is wrong (degraded)
 * — we don't waste a row when everything's healthy. The "healthy" pill
 * is shown inside the header instead.
 */
function SystemBanner() {
  const [degraded, setDegraded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiGet<HealthResp>("/health");
        if (!cancelled) setDegraded(!r.ok);
      } catch {
        if (!cancelled) setDegraded(true);
      }
    };
    tick();
    const handle = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  if (!degraded) return null;
  return (
    <div className="h-8 px-4 flex items-center gap-2 bg-rust/10 border-b border-rust/40 text-[12px]">
      <AlertTriangleIcon size={14} className="text-rust" />
      <span className="text-rust mono-caps text-[10px] tracking-wider">degraded</span>
      <span className="text-textMuted">— api responded with errors. retrying…</span>
    </div>
  );
}

// Re-export CheckIcon so the bundle doesn't tree-shake it from this module.
export const _checkIcon = CheckIcon;
