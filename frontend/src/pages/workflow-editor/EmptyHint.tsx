// EmptyHint — overlay shown on a fresh canvas (no nodes) to nudge the
// user. Three quick-start chips call addNodeAtCenter, matching the
// existing AddNodePopup pattern.

import { LightningIcon, ZapIcon, SendIcon } from "../../components/ui/Icon";
import { NODE_KIND_META } from "./constants";
import type { NodeKind } from "./types";

interface Props {
  onPick: (kind: NodeKind) => void;
}

const QUICK_KINDS: { kind: NodeKind; label: string; Icon: typeof LightningIcon }[] = [
  { kind: "trigger", label: "Trigger", Icon: LightningIcon },
  { kind: "agent_run", label: "Agent run", Icon: ZapIcon },
  { kind: "http_post", label: "HTTP POST", Icon: SendIcon },
];

export function EmptyHint({ onPick }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto bg-panel border border-brass/40 shadow-2xl px-6 py-5 max-w-[420px]">
        <div className="flex items-start gap-3">
          {/* Left-pointing arrow that nudges the user to the palette */}
          <div className="self-center -ml-1 animate-pulse">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <path
                d="M30 20 L12 20 M12 20 L18 14 M12 20 L18 26"
                stroke="#C9A227"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="flex-1">
            <div className="mono-caps text-[10px] text-brass tracking-wider mb-1">
              EMPTY CANVAS
            </div>
            <h3 className="font-display text-[16px] font-medium text-text mb-1">
              Build your first step
            </h3>
            <p className="text-[12px] text-textMuted leading-[1.55] mb-3">
              Drag a node from the left rail onto the canvas, or click a
              quick-start below to drop one in the center.
            </p>
            <div className="flex flex-wrap gap-2">
              {QUICK_KINDS.map(({ kind, label, Icon }) => {
                const meta = NODE_KIND_META[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onPick(kind)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-panelAlt border border-border hover:border-brass/40 transition-colors"
                    style={{ borderLeft: `3px solid ${meta.color}` }}
                  >
                    <Icon size={12} />
                    <span className="text-[12px] font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
