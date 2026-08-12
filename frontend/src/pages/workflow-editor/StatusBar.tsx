// StatusBar — thin 32px bottom strip replacing the old 240px drawer.
//
// Left: dirty/saving indicator, last run id + status, polling spinner.
// Right: snap-to-grid toggle, mini-map toggle, zoom %, keyboard hints.

import {
  LightningIcon,
  SaveIcon,
  LayersIcon,
} from "../../components/ui/Icon";
import type { WorkflowRun } from "./types";

interface Props {
  dirty: boolean;
  saving: boolean;
  lastSaveAt: string | null;
  pollRun: WorkflowRun | null;
  pollActive: boolean;
  viewScale: number;
  snapToGrid: boolean;
  showMiniMap: boolean;
  onToggleSnap: () => void;
  onToggleMiniMap: () => void;
  onFit: () => void;
  onOpenLog: () => void;
  cursorPos: { x: number; y: number } | null;
  totalNodes: number;
  totalEdges: number;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function statusTone(status: WorkflowRun["status"]) {
  switch (status) {
    case "completed":
      return "text-teal";
    case "failed":
      return "text-rust";
    case "running":
      return "text-brass";
    default:
      return "text-textFaint";
  }
}

export function StatusBar({
  dirty,
  saving,
  lastSaveAt,
  pollRun,
  pollActive,
  viewScale,
  snapToGrid,
  showMiniMap,
  onToggleSnap,
  onToggleMiniMap,
  onFit,
  onOpenLog,
  cursorPos,
  totalNodes,
  totalEdges,
}: Props) {
  return (
    <div
      className="bg-panel/80 border-t border-border flex items-center px-3 gap-3 flex-shrink-0"
      style={{ height: 32 }}
    >
      {/* LEFT cluster */}
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={
            saving
              ? "mono-caps text-[10px] text-brass flex items-center gap-1"
              : dirty
              ? "mono-caps text-[10px] text-brass flex items-center gap-1"
              : "mono-caps text-[10px] text-textFaint flex items-center gap-1"
          }
        >
          <span
            className={
              saving
                ? "w-1.5 h-1.5 rounded-full bg-brass animate-pulse"
                : dirty
                ? "w-1.5 h-1.5 rounded-full bg-brass"
                : "w-1.5 h-1.5 rounded-full bg-teal"
            }
          />
          {saving ? "saving" : dirty ? "unsaved" : "auto-saved"}
          <span className="text-textFaint ml-1">{fmtAgo(lastSaveAt)}</span>
        </span>

        {pollRun && (
          <span className="mono-caps text-[10px] text-textFaint flex items-center gap-1">
            <LightningIcon size={10} />
            run {pollRun.id.slice(0, 6)}
            <span className={statusTone(pollRun.status)}>{pollRun.status}</span>
            {pollActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-brass animate-pulse" />
            )}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* CENTER cluster */}
      <div className="flex items-center gap-3 mono-caps text-[10px] text-textFaint">
        <span>
          {totalNodes} nodes · {totalEdges} edges
        </span>
        {cursorPos && (
          <span className="font-mono text-textMuted">
            x {Math.round(cursorPos.x)} · y {Math.round(cursorPos.y)}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* RIGHT cluster */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleSnap}
          className={
            snapToGrid
              ? "mono-caps text-[10px] h-6 px-2 border border-brass/40 bg-brass/10 text-brass hover:bg-brass/20"
              : "mono-caps text-[10px] h-6 px-2 border border-border text-textMuted hover:text-text"
          }
          title="Snap to grid"
        >
          snap
        </button>
        <button
          type="button"
          onClick={onToggleMiniMap}
          className={
            showMiniMap
              ? "mono-caps text-[10px] h-6 px-2 border border-brass/40 bg-brass/10 text-brass hover:bg-brass/20"
              : "mono-caps text-[10px] h-6 px-2 border border-border text-textMuted hover:text-text"
          }
          title="Toggle mini-map"
        >
          map
        </button>
        <button
          type="button"
          onClick={onOpenLog}
          className="mono-caps text-[10px] h-6 px-2 border border-border text-textMuted hover:text-text flex items-center gap-1"
          title="Open run history"
        >
          <LightningIcon size={10} />
          log
        </button>
        <button
          type="button"
          onClick={onFit}
          className="flex items-center gap-1 mono-caps text-[10px] h-6 px-2 border border-border text-textMuted hover:text-text"
          title="Fit to content"
        >
          <LayersIcon size={10} />
          fit
        </button>
        <div className="border-l border-border h-5" />
        <span className="mono-caps text-[10px] text-textFaint tabular-nums">
          {Math.round(viewScale * 100)}%
        </span>
        <div className="border-l border-border h-5" />
        <div className="flex items-center gap-1.5 mono-caps text-[9px] text-textFaint">
          <kbd className="border border-border px-1">Del</kbd>
          <kbd className="border border-border px-1">⌘S</kbd>
          <kbd className="border border-border px-1">⌘Z</kbd>
          <kbd className="border border-border px-1">Space</kbd>
          <kbd className="border border-border px-1">F</kbd>
        </div>
        <SaveIcon size={10} className="hidden" />
      </div>
    </div>
  );
}
