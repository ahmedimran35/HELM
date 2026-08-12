// CitationCard — collapsible list of sources an assistant message drew
// from (web search results, RAG chunks, knowledge docs). Replaces the
// inline "## Sources" markdown section the model used to emit.
//
// Each row:
//   - numeric badge ([1], [2], …) — the same numbers the assistant
//     used inline in its reply, kept consistent via the `n` prop.
//   - the title (truncated with ellipsis if too long)
//   - the host (parsed from the URL)
//   - a chevron toggle to expand a snippet or full URL
//
// The card has a brass left border (matches the "live-web search" banner)
// and a subtle hover state. It's also used as a building block for the
// "searched wikipedia" / "searched lightpanda" banners under each
// assistant message.

import { useState } from "react";
import { ChevronDownIcon } from "../Icon";
import { cn } from "../../../lib/cn";
import { safeHref } from "../../../lib/safe-href";

export interface Citation {
  /** 1-indexed badge number. */
  n: number;
  title: string;
  url: string;
  /** Optional snippet shown on expand. */
  snippet?: string;
}

interface Props {
  citations: Citation[];
  service?: string;
  /** Default expanded? Default true so users see the proof. */
  defaultExpanded?: boolean;
  className?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function CitationCard({
  citations,
  service,
  defaultExpanded = true,
  className = "",
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (citations.length === 0) return null;
  return (
    <div
      className={cn(
        "mt-2.5 border-l-2 border-brass bg-panel border border-border border-l-brass",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-panelAlt transition-colors"
        aria-expanded={expanded}
      >
        <ChevronDownIcon
          size={12}
          className={cn(
            "text-textMuted transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <span className="mono-caps text-[10px] text-brass tracking-wider">
          Sources
        </span>
        <span className="mono-caps text-[10px] text-textMuted tracking-wider">
          {citations.length}
        </span>
        {service && (
          <span className="mono-caps text-[10px] text-textFaint tracking-wider ml-auto">
            via {service}
          </span>
        )}
      </button>
      {expanded && (
        <ol className="border-t border-border">
          {citations.map((c) => (
            <CitationRow key={c.n} citation={c} />
          ))}
        </ol>
      )}
    </div>
  );
}

function CitationRow({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-borderSoft last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-1.5 hover:bg-panelAlt transition-colors">
        <span className="font-mono text-[10px] text-brass tabular-nums w-4 text-center">
          [{citation.n}]
        </span>
        <a
          href={safeHref(citation.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 min-w-0 truncate text-[12px] text-text hover:text-brass"
        >
          {citation.title}
        </a>
        <span className="font-mono text-[10px] text-textFaint tabular-nums shrink-0">
          {hostOf(citation.url)}
        </span>
        {citation.snippet && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-textMuted hover:text-text p-0.5"
            aria-label={open ? "Hide snippet" : "Show snippet"}
          >
            <ChevronDownIcon
              size={12}
              className={cn("transition-transform", !open && "-rotate-90")}
            />
          </button>
        )}
      </div>
      {citation.snippet && open && (
        <p className="px-3 pb-2 text-[11px] text-textMuted leading-[1.5]">
          {citation.snippet}
        </p>
      )}
    </li>
  );
}
