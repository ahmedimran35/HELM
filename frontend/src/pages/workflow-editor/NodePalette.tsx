// NodePalette — left rail node catalog.
//
// Searchable, grouped list of every node kind. Each item is both:
//   - a drag source (HTML5 dataTransfer, MIME "text/x-node-kind")
//     dropped onto the canvas to place a node at the cursor.
//   - a click target — clicking places a node at the canvas center.
//
// Same color stripe + icon-chip pattern as the existing palette, with
// a search box at the top.

import { useMemo, useState } from "react";
import { SearchIcon } from "../../components/ui/Icon";
import {
  NODE_KIND_META,
  PALETTE_CATEGORIES,
  PALETTE_WIDTH_PX,
} from "./constants";
import type { NodeKind } from "./types";

interface Props {
  onDragStart: (kind: NodeKind) => void;
  onPick: (kind: NodeKind) => void;
}

export function NodePalette({ onDragStart, onPick }: Props) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return PALETTE_CATEGORIES;
    return PALETTE_CATEGORIES.map((c) => ({
      ...c,
      kinds: c.kinds.filter((k) => {
        const meta = NODE_KIND_META[k];
        return (
          meta.label.toLowerCase().includes(needle) ||
          meta.description.toLowerCase().includes(needle) ||
          k.toLowerCase().includes(needle)
        );
      }),
    })).filter((c) => c.kinds.length > 0);
  }, [q]);

  const totalVisible = filtered.reduce((acc, c) => acc + c.kinds.length, 0);

  return (
    <aside
      className="flex-shrink-0 bg-gradient-to-b from-panel/60 to-panel/30 border-r border-border flex flex-col"
      style={{ width: PALETTE_WIDTH_PX }}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-borderSoft">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-brass" />
          <div className="mono-caps text-[10px] text-brass tracking-wider font-semibold">
            Nodes
          </div>
          <div className="flex-1" />
          <span className="mono-caps text-[9px] text-textFaint">{totalVisible}</span>
        </div>
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textFaint pointer-events-none">
            <SearchIcon size={12} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search kinds…"
            className="w-full h-8 bg-panelAlt border border-border text-text pl-7 pr-2 text-[12px] placeholder:text-textFaint focus:border-brass"
          />
        </div>
      </div>

      {/* Categories */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-textFaint mt-2">
            No kinds match "{q}". Try "agent", "http", or "trigger".
          </div>
        ) : (
          filtered.map((cat) => (
            <div key={cat.name}>
              <div className="mono-caps text-[9px] text-textFaint tracking-wider px-2 mb-1.5 uppercase">
                {cat.name}
              </div>
              <div className="space-y-1.5">
                {cat.kinds.map((kind) => {
                  const meta = NODE_KIND_META[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/x-node-kind", kind);
                        e.dataTransfer.effectAllowed = "copy";
                        onDragStart(kind);
                      }}
                      onClick={() => onPick(kind)}
                      className="group w-full flex items-center gap-2.5 px-2.5 py-2 bg-panel border border-border hover:border-brass/40 hover:bg-panelAlt transition-all cursor-grab active:cursor-grabbing text-left"
                      style={{ boxShadow: `inset 3px 0 0 ${meta.color}40` }}
                    >
                      <div
                        className="w-7 h-7 flex items-center justify-center text-[15px] font-mono flex-shrink-0"
                        style={{
                          color: meta.color,
                          background: meta.color + "15",
                          border: `1px solid ${meta.color}30`,
                        }}
                      >
                        {meta.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-medium truncate">
                          {meta.label}
                        </div>
                        <div className="text-[10px] text-textFaint truncate">
                          {meta.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div className="border-t border-borderSoft px-3 py-2 text-[10px] text-textFaint leading-snug">
        Drag onto canvas, or click to center.
      </div>
    </aside>
  );
}
