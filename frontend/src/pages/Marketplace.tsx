// Marketplace — public catalogue of installable skill packs, app templates,
// workflow templates, and personas. Powered by /api/marketplace.
//
// Layout:
//   - Top filter bar: kind select, search input, sort radio (popular /
//     rating / newest). All filter state lives in the URL so the user
//     can share or bookmark a filtered view.
//   - Card grid with one tile per entry. Tiles show kind badge, name,
//     description preview, rating, install count, and a primary install
//     button. Click anywhere on the tile opens a detail sheet.
//   - Detail sheet (SideSheet) shows the full description, the manifest
//     preview, install/uninstall toggle, and the reviews list. Reviews
//     can be submitted in-place with a 1-5 rating + comment.
//
// All copy uses design tokens via Tailwind classes — no inline colours.
// The kind → accent mapping happens once at the top so the same colour
// is used across card, badge, and detail sheet.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import {
  XIcon,
  CheckIcon,
  StarIcon,
  DownloadIcon,
} from "../components/ui/Icon";
import { SideSheet } from "../components/ui/layout/SideSheet";
import { cn } from "../lib/cn";

type Kind = "skill_pack" | "app" | "workflow_template" | "persona";
type SortKey = "popular" | "rating" | "newest";

interface Entry {
  id: string;
  kind: Kind;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  tags: string[];
  install_count: number;
  rating: number | null;
  manifest: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  installed: boolean;
}

interface Review {
  id: string;
  username: string | null;
  name: string | null;
  rating: number;
  comment: string | null;
  created_at: string;
}

const KIND_ORDER: Kind[] = ["skill_pack", "app", "workflow_template", "persona"];

const KIND_LABEL: Record<Kind, string> = {
  skill_pack: "Skill pack",
  app: "App",
  workflow_template: "Workflow",
  persona: "Persona",
};

// Brand-tone border per kind — kept distinct so the card grid has
// variety without needing real product art.
const KIND_ACCENT: Record<Kind, string> = {
  skill_pack: "border-brass/50 text-brass",
  app: "border-teal/50 text-teal",
  workflow_template: "border-brassSoft/40 text-text",
  persona: "border-rust/40 text-rust",
};

export function MarketplacePage() {
  const { addToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [kind, setKind] = useState<Kind | "">(
    (searchParams.get("kind") as Kind | null) ?? "",
  );
  const [sort, setSort] = useState<SortKey>(
    (searchParams.get("sort") as SortKey | null) ?? "popular",
  );
  const [activeId, setActiveId] = useState<string | null>(
    searchParams.get("id") ?? null,
  );
  const [detail, setDetail] = useState<{ entry: Entry; reviews: Review[] } | null>(null);

  // Debounce search input — 300 ms keeps the request rate gentle while
  // feeling instant to the user.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Reflect the active filter state back into the URL so the page is
  // shareable. Skip if nothing changed (keeps the history quiet).
  useEffect(() => {
    const next = new URLSearchParams();
    if (kind) next.set("kind", kind);
    if (debouncedSearch) next.set("search", debouncedSearch);
    if (sort !== "popular") next.set("sort", sort);
    setSearchParams(next, { replace: true });
  }, [kind, debouncedSearch, sort, setSearchParams]);

  // Fetch entries when filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (debouncedSearch) qs.set("search", debouncedSearch);
    if (sort) qs.set("sort", sort);
    apiGet<{ entries: Entry[] }>(`/marketplace?${qs.toString()}`)
      .then((r) => {
        if (!cancelled) setEntries(r.entries ?? []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, debouncedSearch, sort]);

  // Detail sheet — only fetched when an id is active.
  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    apiGet<{ entry: Entry; reviews: Review[] }>(`/marketplace/${activeId}`)
      .then((r) => {
        if (!cancelled) setDetail(r);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const counts = useMemo(() => {
    const c: Record<Kind | "all", number> = { all: entries.length, skill_pack: 0, app: 0, workflow_template: 0, persona: 0 };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entries]);

  async function toggleInstall(entry: Entry) {
    if (entry.installed) {
      await apiDelete(`/marketplace/${entry.id}/install`);
      addToast({ id: `mp-rm-${entry.id}`, title: `Removed ${entry.name}`, tone: "info", duration: 2000 });
    } else {
      await apiPost(`/marketplace/${entry.id}/install`);
      addToast({ id: `mp-add-${entry.id}`, title: `Installed ${entry.name}`, tone: "info", duration: 2000 });
    }
    // Refresh entry list and detail so install_count + installed flag update.
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (debouncedSearch) qs.set("search", debouncedSearch);
    if (sort) qs.set("sort", sort);
    const fresh = await apiGet<{ entries: Entry[] }>(`/marketplace?${qs.toString()}`);
    setEntries(fresh.entries ?? []);
    if (activeId) {
      const d = await apiGet<{ entry: Entry; reviews: Review[] }>(`/marketplace/${activeId}`);
      setDetail(d);
    }
  }

  async function submitReview(rating: number, comment: string) {
    if (!activeId) return;
    await apiPost(`/marketplace/${activeId}/reviews`, { rating, comment });
    addToast({ id: `rv-${Date.now()}`, title: "Review submitted", tone: "info", duration: 2000 });
    const d = await apiGet<{ entry: Entry; reviews: Review[] }>(`/marketplace/${activeId}`);
    setDetail(d);
    const fresh = await apiGet<{ entries: Entry[] }>(
      `/marketplace?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(debouncedSearch ? { search: debouncedSearch } : {}), sort }).toString()}`,
    );
    setEntries(fresh.entries ?? []);
  }

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <div className="mono-caps text-[11px] text-textFaint">WORKSPACE / MARKETPLACE</div>
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-text">
            Marketplace
          </h1>
          <p className="mt-1 text-[13px] text-textMuted max-w-[640px]">
            Browse installable skill packs, app templates, workflows, and personas.
            Install with a click; uninstall any time.
          </p>
        </div>
        <div className="mono-caps text-[10px] text-textFaint">
          {loading ? "loading…" : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}
        </div>
      </header>

      {/* Filter bar */}
      <div className="bg-panel border border-border p-3 mb-5 flex flex-col lg:flex-row gap-3">
        <div className="flex items-center gap-2 lg:gap-3 flex-wrap">
          {(["", ...KIND_ORDER] as const).map((k) => {
            const active = k === kind;
            const label = k ? KIND_LABEL[k] : "All";
            const count = k ? (counts[k] ?? 0) : counts.all;
            return (
              <button
                key={k || "all"}
                onClick={() => setKind(k as Kind | "")}
                className={cn(
                  "px-2.5 h-7 border mono-caps text-[10px] tracking-wider inline-flex items-center gap-1.5",
                  active
                    ? "border-brass text-brass bg-brass/10"
                    : "border-borderSoft text-textMuted hover:text-text hover:border-border",
                )}
                aria-pressed={active}
              >
                {label}
                <span className="text-textFaint">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 lg:ml-auto">
          <Input
            placeholder="Search marketplace…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-[200px] lg:w-[260px]"
          />
          <div className="flex items-center border border-borderSoft bg-bg h-8">
            {(["popular", "rating", "newest"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={cn(
                  "px-2 h-full mono-caps text-[10px] tracking-wider",
                  sort === s
                    ? "bg-panelAlt text-brass"
                    : "text-textMuted hover:text-text",
                )}
                aria-pressed={sort === s}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <SkeletonGrid />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No entries match"
          description="Try widening the kind filter, clearing the search, or switching sort to 'newest'."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {entries.map((e) => (
            <MarketCard
              key={e.id}
              entry={e}
              onOpen={() => setActiveId(e.id)}
              onToggle={() => toggleInstall(e)}
            />
          ))}
        </div>
      )}

      {/* Detail sheet */}
      <SideSheet
        open={!!activeId}
        onClose={() => setActiveId(null)}
        title={detail?.entry.name ?? "Loading…"}
        description={
          detail
            ? `${KIND_LABEL[detail.entry.kind]} · v${detail.entry.version}${
                detail.entry.author ? ` · ${detail.entry.author}` : ""
              }`
            : ""
        }
        widthClass="w-[520px] max-w-[90vw]"
      >
        {detail ? (
          <DetailBody
            detail={detail}
            onToggle={() => toggleInstall(detail.entry)}
            onReview={submitReview}
          />
        ) : (
          <div className="p-6 text-textMuted text-[12px]">Loading…</div>
        )}
      </SideSheet>
    </div>
  );
}

function MarketCard({
  entry,
  onOpen,
  onToggle,
}: {
  entry: Entry;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <article
      className={cn(
        "bg-panel border border-border flex flex-col",
        "hover:border-brass/60 transition-colors",
      )}
    >
      <button
        onClick={onOpen}
        className="text-left p-4 flex-1 flex flex-col gap-2.5 focus:outline-none"
      >
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "border px-1.5 h-[18px] inline-flex items-center mono-caps text-[9px] tracking-wider",
              KIND_ACCENT[entry.kind],
            )}
          >
            {KIND_LABEL[entry.kind]}
          </span>
          {entry.installed && (
            <span className="border border-teal/40 text-teal px-1.5 h-[18px] inline-flex items-center mono-caps text-[9px] tracking-wider">
              <CheckIcon size={9} className="mr-1" />
              INSTALLED
            </span>
          )}
        </div>
        <h3 className="font-display text-[16px] font-semibold text-text truncate">
          {entry.name}
        </h3>
        <p className="text-[12px] text-textMuted line-clamp-3 leading-snug min-h-[54px]">
          {entry.description}
        </p>
      </button>
      <div className="px-4 py-2.5 border-t border-borderSoft flex items-center justify-between">
        <div className="flex items-center gap-3 mono-caps text-[10px] text-textFaint">
          <span className="inline-flex items-center gap-1 text-brass">
            <StarIcon size={10} />
            {entry.rating != null ? entry.rating.toFixed(1) : "—"}
          </span>
          <span className="inline-flex items-center gap-1">
            <DownloadIcon size={10} />
            {entry.install_count.toLocaleString()}
          </span>
          {entry.author && <span className="truncate max-w-[100px]">@{entry.author}</span>}
        </div>
        <Button
          size="sm"
          variant={entry.installed ? "ghost" : "primary"}
          onClick={(ev) => {
            ev.stopPropagation();
            onToggle();
          }}
          aria-pressed={entry.installed}
        >
          {entry.installed ? "Remove" : "Install"}
        </Button>
      </div>
    </article>
  );
}

function DetailBody({
  detail,
  onToggle,
  onReview,
}: {
  detail: { entry: Entry; reviews: Review[] };
  onToggle: () => void;
  onReview: (rating: number, comment: string) => Promise<void> | void;
}) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const manifestStr = useMemo(() => {
    try {
      return JSON.stringify(detail.entry.manifest, null, 2);
    } catch {
      return "{}";
    }
  }, [detail.entry.manifest]);

  return (
    <div className="p-4 space-y-5 text-[13px]">
      <p className="text-textMuted leading-relaxed">{detail.entry.description}</p>

      {detail.entry.tags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {detail.entry.tags.map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 py-2 border-y border-borderSoft mono-caps text-[10px] text-textFaint">
        <span className="inline-flex items-center gap-1 text-brass">
          <StarIcon size={10} />
          {detail.entry.rating != null ? detail.entry.rating.toFixed(1) : "—"}
        </span>
        <span>{detail.entry.install_count.toLocaleString()} installs</span>
        {detail.entry.author && <span>by {detail.entry.author}</span>}
      </div>

      <Button variant="primary" onClick={onToggle} className="w-full">
        {detail.entry.installed ? "Remove from account" : "Install for me"}
      </Button>

      <section>
        <h4 className="mono-caps text-[11px] text-textFaint mb-2">Manifest preview</h4>
        <pre className="bg-bg border border-borderSoft p-3 mono-caps text-[10px] overflow-x-auto max-h-[200px]">
{manifestStr}
        </pre>
      </section>

      <section>
        <h4 className="mono-caps text-[11px] text-textFaint mb-2">Reviews</h4>
        <ReviewForm
          rating={rating}
          comment={comment}
          setRating={setRating}
          setComment={setComment}
          submitting={submitting}
          onSubmit={async () => {
            setSubmitting(true);
            try {
              await onReview(rating, comment.trim());
              setComment("");
            } finally {
              setSubmitting(false);
            }
          }}
        />
        <ul className="mt-3 space-y-2.5">
          {detail.reviews.length === 0 && (
            <li className="mono-caps text-[10px] text-textFaint">
              no reviews yet — be the first
            </li>
          )}
          {detail.reviews.map((r) => (
            <li key={r.id} className="bg-panelAlt border border-borderSoft p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text font-medium">
                  {r.name ?? r.username ?? "anonymous"}
                </span>
                <span className="inline-flex items-center text-brass">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <StarIcon
                      key={i}
                      size={10}
                      className={i < r.rating ? "text-brass" : "text-border"}
                    />
                  ))}
                </span>
              </div>
              {r.comment && (
                <p className="mt-1 text-[12px] text-textMuted">{r.comment}</p>
              )}
              <div className="mt-1 mono-caps text-[9px] text-textFaint">
                {new Date(r.created_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ReviewForm({
  rating,
  comment,
  setRating,
  setComment,
  submitting,
  onSubmit,
}: {
  rating: number;
  comment: string;
  setRating: (n: number) => void;
  setComment: (s: string) => void;
  submitting: boolean;
  onSubmit: () => void | Promise<void>;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-2"
    >
      <div className="flex items-center gap-1">
        <span className="mono-caps text-[10px] text-textFaint mr-2">Your rating</span>
        {Array.from({ length: 5 }).map((_, i) => {
          const n = i + 1;
          return (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              className={cn(
                "p-1 -ml-0",
                n <= rating ? "text-brass" : "text-border hover:text-textMuted",
              )}
              aria-label={`rate ${n}`}
              aria-pressed={n <= rating}
            >
              <StarIcon size={14} />
            </button>
          );
        })}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Comment (optional)"
        className="w-full bg-bg border border-border text-text px-2 py-1.5 font-mono text-[12px] resize-none focus:border-brass"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting ? "submitting…" : "Submit review"}
        </Button>
      </div>
    </form>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="bg-panel border border-border p-4 h-[180px] skeleton-shimmer"
        />
      ))}
    </div>
  );
}
