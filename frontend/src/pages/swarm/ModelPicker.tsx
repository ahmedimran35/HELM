// Swarm Lab — ModelPicker.
//
// GET /api/models via the OpenAPI client (openapi.listModels), which
// is the per-user governed list — same source the playground uses.
// Selected models render as dismissible chips; the picker itself is a
// searchable popover (78+ models in the registry — a flat chip wall
// is unusable). provider_type maps to the harness kind the same way
// the backend route does (anthropic → "anthropic", else "openai").

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { openapi, type Model } from "../../api/openapi";

export interface PickedModel {
  model_id: string;
  label: string;
  harness: string;
}

interface Props {
  selected: PickedModel[];
  onChange: (next: PickedModel[]) => void;
  disabled?: boolean;
}

const MAX = 10;

function harnessFor(providerType: string): string {
  return providerType === "anthropic" ? "anthropic" : "openai";
}

// Short provider label for the row's secondary text (the host of the
// provider base URL — "api.rout.my" → "rout.my").
function providerTag(m: Model): string {
  try {
    return new URL(m.provider_base_url).hostname.replace(/^api\./, "");
  } catch {
    return m.provider_type;
  }
}

export const ModelPicker: FC<Props> = ({ selected, onChange, disabled }) => {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    openapi
      .listModels()
      .then((m) => live && setModels(m))
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as globalThis.Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const ids = new Set(selected.map((s) => s.model_id));

  const filtered = useMemo(() => {
    if (models == null) return [];
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        m.external_id.toLowerCase().includes(q),
    );
  }, [models, query]);

  const toggle = (m: Model) => {
    if (ids.has(m.id)) {
      onChange(selected.filter((s) => s.model_id !== m.id));
    } else if (selected.length < MAX) {
      onChange([
        ...selected,
        { model_id: m.id, label: m.display_name, harness: harnessFor(m.provider_type) },
      ]);
    }
  };

  const byId = new Map((models ?? []).map((m) => [m.id, m]));

  if (error) {
    return <p className="text-sm text-rust">Failed to load models: {error}</p>;
  }

  return (
    <div className="space-y-2">
      {/* Selected chips */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap gap-1.5 min-h-[30px]">
          {selected.map((s) => {
            const m = byId.get(s.model_id);
            return (
              <span
                key={s.model_id}
                className="inline-flex items-center gap-1.5 rounded-md border border-brassSoft bg-brass/10 px-2 py-1 text-sm text-text"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-brass"
                  aria-hidden
                />
                {s.label}
                {m != null && (
                  <span className="mono-caps text-[9px] text-textFaint">
                    {providerTag(m)}
                  </span>
                )}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange(selected.filter((x) => x.model_id !== s.model_id))}
                    className="text-textFaint hover:text-rust leading-none"
                    aria-label={`Remove ${s.label}`}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {selected.length === 0 && (
            <span className="text-sm text-textFaint self-center">
              No models selected yet.
            </span>
          )}
        </div>
        {selected.length > 0 && !disabled && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-textMuted hover:text-text underline shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      {/* Add-models popover */}
      <div className="relative" ref={popRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled || models == null || selected.length >= MAX}
          className="rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-textMuted hover:border-brassSoft hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          + Add models
          {models != null && (
            <span className="ml-1.5 mono-caps text-[9px] text-textFaint">
              {open && query.trim()
                ? `${filtered.length}/${models.length}`
                : models.length}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute z-30 mt-2 w-[420px] max-w-[90vw] rounded-lg border border-border bg-panel shadow-xl">
            <div className="p-2 border-b border-border">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full rounded-md border border-border bg-panelAlt px-2.5 py-1.5 text-sm text-text placeholder:text-textFaint focus:outline-none focus:border-brassSoft"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {filtered.length === 0 && (
                <p className="px-3 py-3 text-sm text-textFaint">No matches.</p>
              )}
              {filtered.map((m) => {
                const on = ids.has(m.id);
                const full = !on && selected.length >= MAX;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(m)}
                    disabled={full}
                    title={`${m.external_id} · ${providerTag(m)}`}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                      on
                        ? "bg-brass/10 text-text"
                        : full
                          ? "text-textFaint opacity-50 cursor-not-allowed"
                          : "text-textMuted hover:bg-panelAlt hover:text-text"
                    }`}
                  >
                    <span
                      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] ${
                        on ? "border-brass bg-brass text-bg" : "border-border"
                      }`}
                      aria-hidden
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="truncate flex-1">{m.display_name}</span>
                    <span className="mono-caps text-[9px] text-textFaint shrink-0">
                      {providerTag(m)}
                    </span>
                    {!m.assigned && (
                      <span className="mono-caps text-[9px] text-rust shrink-0">
                        unassigned
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="border-t border-border px-3 py-1.5 text-[11px] text-textFaint">
              {selected.length}/{MAX} selected — runs need 2–{MAX}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
