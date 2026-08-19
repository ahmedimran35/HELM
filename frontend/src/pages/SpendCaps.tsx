// /spend-caps — per-panel spend caps (Tier 5).
//
//   - Lists every spend cap the current user can see (admins see all;
//     users see caps for panels they belong to).
//   - Each cap is a card showing the current period spend vs the
//     configured limit, with a progress bar and warn / hard markers.
//   - Cards expose a small inline editor for limit_cents, warn_at_pct,
//     and hard_cap. POST goes to /api/spend-caps; the server upserts
//     and returns { ok: true }.

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton, SkeletonTable } from "../components/ui/feedback/Skeleton";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/feedback/Toast";
import {
  WalletIcon,
  AlertTriangleIcon,
  PlusIcon,
  RefreshIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface SpendCapRow {
  panel_id: string;
  panel_name: string;
  period: "day" | "week" | "month";
  spent_cents: number;
  limit_cents: number;
  warn_at_pct: number;
  hard_cap: boolean;
  ratio: number;
  over_warn: boolean;
  over_limit: boolean;
}

interface PanelOption {
  id: string;
  name: string;
}

export function SpendCapsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<SpendCapRow[] | null>(null);
  const [panels, setPanels] = useState<PanelOption[] | null>(null);

  function reload() {
    setRows(null);
    apiGet<SpendCapRow[]>("/spend-caps")
      .then(setRows)
      .catch(() => setRows([]));
    apiGet<PanelOption[]>("/panels")
      .then((p) => setPanels(p.map((row) => ({ id: row.id, name: row.name }))))
      .catch(() => setPanels([]));
  }

  useEffect(reload, []);

  async function save(row: SpendCapRow, next: { limit_cents: number; warn_at_pct: number; hard_cap: boolean; period: SpendCapRow["period"] }) {
    try {
      await apiPost("/spend-caps", {
        panel_id: row.panel_id,
        period: next.period,
        limit_cents: next.limit_cents,
        warn_at_pct: next.warn_at_pct,
        hard_cap: next.hard_cap,
      });
      toast.addToast({
        id: `spend-cap-${row.panel_id}-${next.period}`,
        title: `Cap updated · ${row.panel_name}`,
        tone: "success",
      });
      reload();
    } catch (err) {
      toast.addToast({
        id: `spend-cap-err-${row.panel_id}`,
        title: "Save failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function createCap(input: { panel_id: string; period: SpendCapRow["period"]; limit_cents: number; warn_at_pct: number; hard_cap: boolean }) {
    try {
      await apiPost("/spend-caps", input);
      toast.addToast({
        id: `spend-cap-new-${input.panel_id}`,
        title: "Cap created",
        tone: "success",
      });
      reload();
    } catch (err) {
      toast.addToast({
        id: "spend-cap-create-err",
        title: "Create failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  const overWarn = rows?.filter((r) => r.over_warn).length ?? 0;

  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Spend caps
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Per-panel ceilings — soft warn at the threshold, hard reject over the limit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill
            state={
              rows === null
                ? "unknown"
                : overWarn > 0
                ? "degraded"
                : "healthy"
            }
            label={
              rows === null
                ? "loading…"
                : overWarn > 0
                ? `${overWarn} panel${overWarn === 1 ? "" : "s"} over warn`
                : "all panels healthy"
            }
          />
          <Button variant="ghost" onClick={reload} title="refresh">
            <RefreshIcon size={12} />
          </Button>
        </div>
      </div>

      {rows === null ? (
        <SkeletonTable rows={3} columns={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="ledger"
          title="No caps configured yet"
          description="Create a cap on a panel you belong to. Spend above the warn threshold triggers an inline banner; spend past a hard cap rejects further chat."
          tone="neutral"
          action={
            panels && panels.length > 0 ? (
              <NewCapForm panels={panels} onCreate={createCap} />
            ) : null
          }
        />
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((row) => (
            <SpendCapCard key={`${row.panel_id}-${row.period}`} row={row} onSave={save} />
          ))}
          {panels && panels.length > 0 && (
            <div className="md:col-span-2">
              <NewCapForm panels={panels} onCreate={createCap} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function SpendCapCard({
  row,
  onSave,
}: {
  row: SpendCapRow;
  onSave: (row: SpendCapRow, next: { limit_cents: number; warn_at_pct: number; hard_cap: boolean; period: SpendCapRow["period"] }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [limitCents, setLimitCents] = useState(row.limit_cents);
  const [warnAtPct, setWarnAtPct] = useState(row.warn_at_pct);
  const [hardCap, setHardCap] = useState(row.hard_cap);

  const ratioPct = Math.min(100, row.ratio * 100);
  const tone = row.over_limit ? "rust" : row.over_warn ? "amber" : "brass";

  return (
    <article className="border border-border bg-panel">
      <header className="px-4 py-3 border-b border-borderSoft flex items-center gap-2">
        <WalletIcon size={14} className="text-brass" />
        <span className="font-display text-[14px] font-semibold text-text truncate flex-1">
          {row.panel_name}
        </span>
        <span className="mono-caps text-[10px] text-textFaint">{row.period}</span>
      </header>

      <div className="p-4 space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="font-mono text-[20px] tabular-nums text-text leading-none">
              {row.spent_cents.toFixed(2)}
              <span className="text-textMuted text-[12px] ml-1">cents</span>
            </div>
            <div className="mono-caps text-[10px] text-textFaint mt-1">
              of {row.limit_cents.toFixed(2)} cents · {row.hard_cap ? "hard cap" : "soft warn only"}
            </div>
          </div>
          {row.over_warn && (
            <span className="inline-flex items-center gap-1 mono-caps text-[10px] text-rust border border-rust/40 px-1.5 h-[16px]">
              <AlertTriangleIcon size={9} />
              {row.over_limit ? "over limit" : "warn"}
            </span>
          )}
        </div>

        <ProgressBar ratioPct={ratioPct} warnAtPct={row.warn_at_pct} tone={tone} />

        {editing ? (
          <div className="space-y-2 pt-2 border-t border-borderSoft">
            <FieldRow label="limit (cents)">
              <Input
                type="number"
                min={1}
                value={limitCents}
                onChange={(e) => setLimitCents(Math.max(1, Number(e.target.value) || 0))}
                className="w-full py-1"
              />
            </FieldRow>
            <FieldRow label="warn at %">
              <Input
                type="number"
                min={1}
                max={100}
                value={warnAtPct}
                onChange={(e) => setWarnAtPct(Math.max(1, Math.min(100, Number(e.target.value) || 80)))}
                className="w-full py-1"
              />
            </FieldRow>
            <FieldRow label="hard cap">
              <label className="inline-flex items-center gap-2 mono-caps text-[11px] text-textMuted">
                <input
                  type="checkbox"
                  checked={hardCap}
                  onChange={(e) => setHardCap(e.target.checked)}
                  className="accent-brass"
                />
                reject over limit
              </label>
            </FieldRow>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onSave(row, {
                    limit_cents: limitCents,
                    warn_at_pct: warnAtPct,
                    hard_cap: hardCap,
                    period: row.period,
                  });
                  setEditing(false);
                }}
              >
                save
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end pt-2 border-t border-borderSoft">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              edit
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="mono-caps text-[10px] text-textMuted w-[110px] shrink-0">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function ProgressBar({
  ratioPct,
  warnAtPct,
  tone,
}: {
  ratioPct: number;
  warnAtPct: number;
  tone: "brass" | "amber" | "rust";
}) {
  const fg =
    tone === "rust" ? "bg-rust" : tone === "amber" ? "bg-amber" : "bg-brass";
  return (
    <div className="relative h-[10px] bg-bg border border-borderSoft">
      <div className={cn("absolute inset-y-0 left-0", fg)} style={{ width: `${ratioPct}%` }} />
      <div
        className="absolute inset-y-[-2px] w-[1px] bg-textMuted"
        style={{ left: `${Math.min(100, warnAtPct)}%` }}
        title={`warn at ${warnAtPct}%`}
      />
    </div>
  );
}

function NewCapForm({
  panels,
  onCreate,
}: {
  panels: PanelOption[];
  onCreate: (input: { panel_id: string; period: SpendCapRow["period"]; limit_cents: number; warn_at_pct: number; hard_cap: boolean }) => void;
}) {
  const [panelId, setPanelId] = useState<string>(panels[0]?.id ?? "");
  const [period, setPeriod] = useState<SpendCapRow["period"]>("month");
  const [limitCents, setLimitCents] = useState<number>(500);
  const [warnAtPct, setWarnAtPct] = useState<number>(80);
  const [hardCap, setHardCap] = useState<boolean>(false);
  return (
    <article className="border border-dashed border-borderSoft bg-panel">
      <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
        <PlusIcon size={12} className="text-brass" />
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          New spend cap
        </span>
      </header>
      <div className="p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <label className="flex flex-col gap-1">
          <span className="mono-caps text-[10px] text-textFaint">panel</span>
          <select
            value={panelId}
            onChange={(e) => setPanelId(e.target.value)}
            className="bg-panelAlt border border-border text-text px-2 py-1 font-mono text-[12px]"
          >
            {panels.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono-caps text-[10px] text-textFaint">period</span>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as SpendCapRow["period"])}
            className="bg-panelAlt border border-border text-text px-2 py-1 font-mono text-[12px]"
          >
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono-caps text-[10px] text-textFaint">limit (cents)</span>
          <input
            type="number"
            min={1}
            value={limitCents}
            onChange={(e) => setLimitCents(Math.max(1, Number(e.target.value) || 0))}
            className="bg-panelAlt border border-border text-text px-2 py-1 font-mono text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono-caps text-[10px] text-textFaint">warn at %</span>
          <input
            type="number"
            min={1}
            max={100}
            value={warnAtPct}
            onChange={(e) => setWarnAtPct(Math.max(1, Math.min(100, Number(e.target.value) || 80)))}
            className="bg-panelAlt border border-border text-text px-2 py-1 font-mono text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="mono-caps text-[10px] text-textFaint">hard cap</span>
          <label className="inline-flex items-center gap-2 mono-caps text-[11px] text-textMuted h-[26px]">
            <input
              type="checkbox"
              checked={hardCap}
              onChange={(e) => setHardCap(e.target.checked)}
              className="accent-brass"
            />
            reject over
          </label>
        </label>
      </div>
      <div className="px-4 pb-4">
        <Button
          variant="primary"
          disabled={!panelId}
          onClick={() =>
            onCreate({
              panel_id: panelId,
              period,
              limit_cents: limitCents,
              warn_at_pct: warnAtPct,
              hard_cap: hardCap,
            })
          }
        >
          create cap
        </Button>
      </div>
    </article>
  );
}