// Universal Search (Tier 4: Discovery).
//
// A single search box that hits every panel, app, memory entry, kg entity,
// workspace file, knowledge doc, and marketplace entry at once. Mirrors
// the Cmd+K palette visually but is dedicated to the surfaces a power
// user wants to grep — and is reachable via the `/` keyboard shortcut
// anywhere in the app.
//
// Layout:
//   - Left rail: scope toggles (All / Panels / Apps / Memory) + popular
//     query chips.
//   - Right: grouped results, one section per source type. Each row
//     shows the title, a snippet with the matched term emphasised, and
//     the source badge.
//   - Empty state shows the "Did you mean?" suggestions fetched from
//     /api/search/suggest.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import {
  SearchIcon,
  ArrowRightIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

type GroupKind =
  | "panel"
  | "app"
  | "memory"
  | "entity"
  | "file"
  | "knowledge"
  | "marketplace";

interface GroupResult {
  id: string;
  kind: GroupKind;
  title: string;
  subtitle?: string;
  path?: string;
  snippet?: string;
  highlight?: string;
  score: number;
  created_at?: string;
}

interface Groups {
  panel: GroupResult[];
  app: GroupResult[];
  memory: GroupResult[];
  entity: GroupResult[];
  file: GroupResult[];
  knowledge: GroupResult[];
  marketplace: GroupResult[];
}

interface SearchResponse {
  query: string;
  scope: string;
  total: number;
  groups: Groups;
}

interface SuggestionResponse {
  suggestions: string[];
  popular: string[];
}

const GROUP_ORDER: Array<{ key: keyof Groups; label: string; accent: string }> = [
  { key: "panel", label: "Panels", accent: "text-brass" },
  { key: "app", label: "Apps", accent: "text-teal" },
  { key: "memory", label: "Memory", accent: "text-brassSoft" },
  { key: "entity", label: "Entities", accent: "text-brassSoft" },
  { key: "file", label: "Files", accent: "text-textFaint" },
  { key: "knowledge", label: "Knowledge docs", accent: "text-teal" },
  { key: "marketplace", label: "Marketplace", accent: "text-rust" },
];

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [scope, setScope] = useState<"all" | "panels" | "apps" | "memory">(
    (searchParams.get("scope") as "all" | "panels" | "apps" | "memory" | null) ?? "all",
  );
  const [data, setData] = useState<SearchResponse | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Debounce keystrokes 300 ms before firing — same budget as marketplace
  // filters, keeps the wire rate gentle without making the UI feel laggy.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(handle);
  }, [q]);

  // Sync the active query + scope into the URL so links are shareable.
  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedQ) next.set("q", debouncedQ);
    if (scope !== "all") next.set("scope", scope);
    setSearchParams(next, { replace: true });
  }, [debouncedQ, scope, setSearchParams]);

  // Universal search.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams();
    if (debouncedQ) qs.set("q", debouncedQ);
    if (scope !== "all") qs.set("scope", scope);
    qs.set("limit", "8");
    apiGet<SearchResponse>(`/search/universal?${qs.toString()}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, scope]);

  // Only ask for "did you mean?" when the user has typed and the
  // backend returned zero hits. Cheap because the SQL is tiny.
  const totalHits = data?.total ?? 0;
  useEffect(() => {
    if (!debouncedQ || totalHits > 0) {
      setSuggestions(null);
      return;
    }
    let cancelled = false;
    apiGet<SuggestionResponse>(`/search/suggest?q=${encodeURIComponent(debouncedQ)}`)
      .then((r) => {
        if (!cancelled) setSuggestions(r);
      })
      .catch(() => {
        if (!cancelled) setSuggestions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, totalHits]);

  // `/` shortcut — focuses the search box from anywhere in the page.
  // Escape blurs it back. Mounted once on the page; ignore when typing
  // inside the input itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const orderedGroups = useMemo(() => {
    if (!data) return [];
    return GROUP_ORDER
      .map((g) => ({ ...g, items: data.groups[g.key] ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [data]);

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <header className="flex flex-col md:flex-row md:items-end gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <div className="mono-caps text-[11px] text-textFaint">WORKSPACE / SEARCH</div>
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-text">
            Search
          </h1>
          <p className="mt-1 text-[13px] text-textMuted max-w-[640px]">
            Press <Kbd>/</Kbd> anywhere to focus this box. Results stream
            from panels, apps, memory, knowledge docs, and the marketplace.
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
        {/* Left rail */}
        <aside className="bg-panel border border-border p-3 space-y-4 self-start lg:sticky lg:top-3">
          <section>
            <h3 className="mono-caps text-[10px] text-textFaint mb-2">Scope</h3>
            <div className="flex flex-col gap-1">
              {(["all", "panels", "apps", "memory"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={cn(
                    "text-left px-2 h-7 mono-caps text-[10px] tracking-wider border inline-flex items-center",
                    scope === s
                      ? "border-brass text-brass bg-brass/10"
                      : "border-borderSoft text-textMuted hover:text-text hover:border-border",
                  )}
                  aria-pressed={scope === s}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3 className="mono-caps text-[10px] text-textFaint mb-2">Popular</h3>
            <ul className="space-y-1">
              {(suggestions?.popular ?? []).map((p) => (
                <li key={p}>
                  <button
                    onClick={() => setQ(p)}
                    className="text-left text-[12px] text-textMuted hover:text-text truncate w-full"
                    title={p}
                  >
                    {p}
                  </button>
                </li>
              ))}
              {!suggestions?.popular?.length && (
                <li className="mono-caps text-[10px] text-textFaint">
                  Search to see related catalogue entries
                </li>
              )}
            </ul>
          </section>
        </aside>

        {/* Right column */}
        <div>
          <div className="bg-panel border border-border p-2 mb-4">
            <div className="flex items-center gap-2">
              <SearchIcon size={16} className="text-textFaint ml-1.5" />
              <Input
                ref={inputRef}
                placeholder="Search across panels, apps, memory, files…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="flex-1 border-0 bg-transparent focus:border-0 px-1 h-9 text-[13px]"
              />
              {q && (
                <button
                  onClick={() => setQ("")}
                  className="mono-caps text-[10px] text-textFaint hover:text-text px-2"
                >
                  clear
                </button>
              )}
              <Kbd>/</Kbd>
            </div>
          </div>

          {/* Status row */}
          <div className="flex items-center justify-between mb-3 mono-caps text-[10px] text-textFaint">
            <span>
              {loading
                ? "searching…"
                : debouncedQ
                  ? `${totalHits} match${totalHits === 1 ? "" : "es"} for "${debouncedQ}"`
                  : "type to search"}
            </span>
            {data && (
              <span>
                {orderedGroups.length} group{orderedGroups.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {/* Empty: prompt with / or suggestions */}
          {!debouncedQ && (
            <EmptyState
              title="Search anywhere"
              description="Type to query every panel, app, memory entry, knowledge doc, and marketplace entry. Press / to focus the box."
            />
          )}

          {/* No results */}
          {debouncedQ && !loading && totalHits === 0 && (
            <div className="bg-panel border border-border p-5">
              <h3 className="font-display text-[15px] text-text mb-1">No results</h3>
              <p className="text-[12px] text-textMuted mb-3">
                Nothing matches "{debouncedQ}" across the surfaces you searched.
              </p>
              {suggestions?.suggestions && suggestions.suggestions.length > 0 && (
                <div className="space-y-2">
                  <h4 className="mono-caps text-[10px] text-textFaint">Did you mean…</h4>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {suggestions.suggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => setQ(s)}
                        className="border border-borderSoft hover:border-brass px-2 h-7 mono-caps text-[10px] tracking-wider text-textMuted hover:text-brass"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Grouped results */}
          {orderedGroups.length > 0 && (
            <div className="space-y-5">
              {orderedGroups.map((g) => (
                <section key={g.key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <h3
                      className={cn(
                        "mono-caps text-[11px] tracking-wider",
                        g.accent,
                      )}
                    >
                      {g.label}
                    </h3>
                    <span className="mono-caps text-[10px] text-textFaint">
                      {g.items.length} match{g.items.length === 1 ? "" : "es"}
                    </span>
                  </div>
                  <ul className="bg-panel border border-border divide-y divide-borderSoft">
                    {g.items.map((r) => (
                      <li key={r.id}>
                        <button
                          onClick={() => r.path && navigate(r.path)}
                          className="w-full text-left px-3 py-2.5 hover:bg-panelAlt flex items-start gap-2 group"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] text-text font-medium truncate">
                              {r.title}
                            </div>
                            {r.snippet && (
                              <p className="text-[12px] text-textMuted leading-snug mt-0.5 line-clamp-2">
                                {highlight(r.snippet, r.highlight)}
                              </p>
                            )}
                            {r.subtitle && (
                              <div className="mono-caps text-[10px] text-textFaint mt-0.5 truncate">
                                {r.subtitle}
                              </div>
                            )}
                          </div>
                          <ArrowRightIcon
                            size={12}
                            className="text-textFaint group-hover:text-brass mt-1 shrink-0"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, needle: string | undefined): React.ReactNode {
  if (!needle) return text;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-brass/30 text-text px-0.5">
        {text.slice(idx, idx + needle.length)}
      </mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[18px] inline-flex items-center text-textMuted">
      {children}
    </kbd>
  );
}
