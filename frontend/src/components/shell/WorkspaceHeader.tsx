// WorkspaceHeader v2 — the slim bar across the top of every workspace
// page. It carries:
//   - The breadcrumb tail (WORKSPACE / <SECTION>) rendered in mono caps.
//   - A search trigger that opens the command palette. Click or ⌘K.
//   - A live "system health" pill on the right (degraded / healthy).
//   - A voice activity indicator (Tier 7 combo: panel presence).
//   - A real-time spend cap warning banner (Tier 7 combo: cost router).
//
// The header is intentionally minimal — heavier chrome lives inside the
// page itself (cards, status pills, charts). The header exists so the
// user always knows where they are and how to get out.

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { NAV_ITEMS } from "../../nav/items";
import { useCommandPalette } from "../system/CommandPalette";
import {
  SearchIcon,
  CheckIcon,
  AlertTriangleIcon,
  MicIcon,
  DollarSignIcon,
} from "../ui/Icon";
import { cn } from "../../lib/cn";
import { apiGet } from "../../api/client";
import { NotificationCenter } from "../system/NotificationCenter";

interface HealthState {
  state: "healthy" | "degraded" | "unknown";
  detail?: string;
}

export function WorkspaceHeader() {
  const loc = useLocation();
  const item = NAV_ITEMS.find((i) => i.path === loc.pathname);
  const section = item?.section ?? "ROOT";
  const { open: openPalette } = useCommandPalette();
  const navigate = useNavigate();

  // Live system health — polls a tiny /health endpoint every 30s.
  const [health, setHealth] = useState<HealthState>({ state: "unknown" });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiGet<{ ok: boolean; ts: number }>("/health");
        if (!cancelled) setHealth({ state: r.ok ? "healthy" : "degraded" });
      } catch {
        if (!cancelled) setHealth({ state: "degraded", detail: "api unreachable" });
      }
    };
    tick();
    const handle = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  // Detect mac for the ⌘ vs Ctrl hint.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform));
    }
  }, []);

  return (
    <header className="h-12 border-b border-border bg-bg flex items-center px-4 gap-4">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="mono-caps text-[11px] text-textMuted hover:text-text transition-colors"
        >
          WORKSPACE
        </button>
        <span className="text-brass mono-caps text-[11px]">/</span>
        <span className="mono-caps text-[11px] text-text truncate">{section}</span>
      </nav>

      {/* Search trigger */}
      <button
        type="button"
        onClick={openPalette}
        aria-label="Open search (⌘K)"
        className={cn(
          "ml-4 flex-1 max-w-[420px] flex items-center gap-2",
          "h-8 px-3 border border-borderSoft bg-panel",
          "text-[12px] text-textFaint hover:text-textMuted hover:border-border transition-colors",
        )}
      >
        <SearchIcon size={14} className="text-textFaint" />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[16px] inline-flex items-center">
          {isMac ? "⌘" : "Ctrl"}K
        </kbd>
      </button>

      {/* Right cluster: status + version */}
      <div className="ml-auto flex items-center gap-3">
        <SpendIndicator />
        <VoiceIndicator />
        <HealthPill health={health} />
        <NotificationCenter />
        <span className="mono-caps text-[10px] text-textFaint hidden md:inline">
          HELM · v0.2.0
        </span>
      </div>
    </header>
  );
}

// Tier 7 combo — voice activity indicator. Reads panel_presence.status
// for the URL's ?panel= query param (set when the user is in a panel).
// Falls back to a hidden chip when no panel is in scope or the API
// isn't ready (Tier 3 dependency).

function VoiceIndicator() {
  const loc = useLocation();
  const panelId = new URLSearchParams(loc.search).get("panel");
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!panelId) {
      setSpeaking(false);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiGet<{
          members: Array<{ status: string }>;
        }>(`/combo/presence?panel_id=${encodeURIComponent(panelId)}`);
        if (cancelled) return;
        setSpeaking(r.members.some((m) => m.status === "speaking" || m.status === "typing"));
      } catch {
        if (!cancelled) setSpeaking(false);
      }
    };
    tick();
    const handle = setInterval(tick, 8000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [panelId]);
  if (!panelId) return null;
  if (!speaking) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 mono-caps text-[10px] tracking-wider px-2 h-7 border border-brass/40 text-brass"
      title="Someone is recording audio in this panel"
    >
      <MicIcon size={12} />
      <span>voice</span>
    </span>
  );
}

// Tier 7 combo — real-time spend indicator. Reads /api/combo/spend-caps
// and shows the panel's warning pill when a cap is approaching or
// exceeded. Gracefully degrades when the spend_caps table doesn't
// exist yet (Tier 5 not migrated).

function SpendIndicator() {
  const [caps, setCaps] = useState<Array<{ panel_name: string; level: string; ratio: number }>>([]);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await apiGet<{ panels: Array<{ panel_name: string; level: string; ratio: number }> }>(
          "/combo/spend-caps",
        );
        if (!cancelled) setCaps(r.panels.filter((p) => p.level !== "ok"));
      } catch {
        if (!cancelled) setCaps([]);
      }
    };
    tick();
    const handle = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);
  if (caps.length === 0) return null;
  const top = caps[0]!;
  const tone =
    top.level === "exceeded"
      ? "border-rust/40 text-rust"
      : "border-brass/40 text-brass";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 mono-caps text-[10px] tracking-wider px-2 h-7 border",
        tone,
      )}
      title={`${top.panel_name}: ${Math.round(top.ratio * 100)}% of cap used`}
    >
      <DollarSignIcon size={11} />
      <span>
        {Math.round(top.ratio * 100)}% of cap · {top.level}
      </span>
    </span>
  );
}

function HealthPill({ health }: { health: HealthState }) {
  const tone = health.state === "healthy" ? "teal" : health.state === "degraded" ? "rust" : "muted";
  const dotClass =
    health.state === "healthy"
      ? "bg-teal shadow-[0_0_6px_rgb(76_156_144/0.6)]"
      : health.state === "degraded"
      ? "bg-rust shadow-[0_0_6px_rgb(181_83_60/0.6)]"
      : "bg-textFaint";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 mono-caps text-[10px] tracking-wider px-2 h-7 border",
        tone === "teal" && "border-teal/40 text-teal",
        tone === "rust" && "border-rust/40 text-rust",
        tone === "muted" && "border-border text-textMuted",
      )}
      title={health.detail ?? "api status"}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dotClass)} />
      {health.state === "healthy" ? (
        <>
          <CheckIcon size={10} />
          <span>healthy</span>
        </>
      ) : health.state === "degraded" ? (
        <>
          <AlertTriangleIcon size={10} />
          <span>degraded</span>
        </>
      ) : (
        <span>connecting…</span>
      )}
    </span>
  );
}
