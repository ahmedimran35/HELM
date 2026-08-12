// Watches + Triggers — event-driven background work (docs §P4).
//
// Every authenticated user can manage their own watches. The page
// surfaces:
//   - A list of watches as cards with a per-card enabled toggle, run
//     button, and inline edit form.
//   - A list of triggers (if-X-then-do-Y rules) layered on top of any
//     watch payload.
//   - A recent runs feed reusing the timeline pattern from Settings.
//
// All state is per-user: server-side routes scope everything by
// `user_id` and the UI never shows other users' data.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import { useToast } from "../components/ui/feedback/Toast";
import {
  PlusIcon,
  PlayIcon,
  EditIcon,
  TrashIcon,
  ClockIcon,
  ZapIcon,
  BellIcon,
  WebhookIcon,
  CheckIcon,
  XIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

type WatchSource = "schedule" | "webhook" | "email" | "file" | "manual";
type WatchAction = "panel_message" | "http_post" | "agent_run";
type PredicateOp = "eq" | "neq" | "gt" | "lt" | "contains" | "exists";

interface Watch {
  id: string;
  name: string;
  source: WatchSource;
  config: Record<string, unknown>;
  action: WatchAction;
  action_config: Record<string, unknown>;
  enabled: boolean;
  last_fired_at: string | null;
  created_at: string;
}

interface Trigger {
  id: string;
  name: string;
  when_clause: Array<{ op: PredicateOp; path: string; value?: unknown }>;
  then_action: WatchAction;
  then_config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

interface WatchRun {
  id: string;
  watch_id: string | null;
  trigger_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: "ok" | "error" | "skipped";
  message: string | null;
}

const SOURCES: { value: WatchSource; label: string; hint: string }[] = [
  { value: "schedule", label: "schedule", hint: "cron expression" },
  { value: "webhook", label: "webhook", hint: "inbound HTTP" },
  { value: "email", label: "email", hint: "inbound mail" },
  { value: "file", label: "file", hint: "sandbox glob" },
  { value: "manual", label: "manual", hint: "button only" },
];

const ACTIONS: { value: WatchAction; label: string; hint: string }[] = [
  { value: "panel_message", label: "panel_message", hint: "post into a panel" },
  { value: "http_post", label: "http_post", hint: "fire HTTP request" },
  { value: "agent_run", label: "agent_run", hint: "call the chat endpoint" },
];

const PREDICATE_OPS: { value: PredicateOp; label: string }[] = [
  { value: "eq", label: "eq" },
  { value: "neq", label: "neq" },
  { value: "gt", label: "gt" },
  { value: "lt", label: "lt" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
];

const SOURCE_TONE: Record<WatchSource, "brass" | "teal" | "neutral"> = {
  schedule: "brass",
  webhook: "teal",
  email: "neutral",
  file: "neutral",
  manual: "neutral",
};

export function WatchesPage() {
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [triggers, setTriggers] = useState<Trigger[] | null>(null);
  const [runs, setRuns] = useState<WatchRun[] | null>(null);
  const [creatingWatch, setCreatingWatch] = useState(false);
  const [creatingTrigger, setCreatingTrigger] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [w, t] = await Promise.all([
      apiGet<Watch[]>("/watches").catch(() => [] as Watch[]),
      apiGet<Trigger[]>("/triggers").catch(() => [] as Trigger[]),
    ]);
    setWatches(w);
    setTriggers(t);
    // Pull the runs for each watch in parallel. Cap at 5 per watch to
    // keep the feed light — the per-watch list view loads the full 20.
    if (w.length > 0) {
      const all = await Promise.all(
        w.map((watch) =>
          apiGet<WatchRun[]>(`/watches/${watch.id}/runs`).catch(() => [] as WatchRun[]),
        ),
      );
      const merged = all
        .flat()
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, 30);
      setRuns(merged);
    } else {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const loading = watches === null || triggers === null;

  return (
    <div className="p-6 max-w-[960px]">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Watches & Triggers
        </h2>
        {watches && watches.length > 0 && (
          <span className="mono-caps text-[10px] text-textFaint">
            {watches.filter((w) => w.enabled).length} of {watches.length} active
          </span>
        )}
      </div>
      <div className="text-textMuted text-[13px] mb-5">
        Event-driven background work — schedule, webhook, or trigger an action.
      </div>

      {/* Watches ----------------------------------------------------- */}
      <SectionHeader
        icon={<BellIcon size={14} />}
        title="Watches"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreatingWatch(true)}
            disabled={creatingWatch}
          >
            <PlusIcon size={12} />
            New watch
          </Button>
        }
      />

      {creatingWatch && (
        <WatchForm
          mode="create"
          onCancel={() => setCreatingWatch(false)}
          onSaved={() => {
            setCreatingWatch(false);
            reload();
          }}
        />
      )}

      {loading ? (
        <div className="space-y-2 mb-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : watches && watches.length === 0 ? (
        <div className="mb-6 border border-border bg-panel">
          <EmptyState
            variant="gear"
            title="No watches yet"
            description="Schedule one to fire on a cron, or accept inbound webhooks to react to events."
            action={
              <Button variant="primary" onClick={() => setCreatingWatch(true)}>
                <PlusIcon size={12} />
                New watch
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {(watches ?? []).map((w) =>
            editingId === w.id ? (
              <WatchForm
                key={w.id}
                mode="edit"
                watch={w}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  reload();
                }}
              />
            ) : (
              <WatchCard
                key={w.id}
                watch={w}
                onToggle={(next: boolean) =>
                  void apiPatch(`/watches/${w.id}`, { enabled: next }).then(reload)
                }
                onRun={() =>
                  apiPost<{ run_id: string }>(`/watches/${w.id}/run`).then(reload)
                }
                onEdit={() => setEditingId(w.id)}
                onDelete={() => {
                  if (!confirm(`Delete watch "${w.name}"?`)) return;
                  apiDelete(`/watches/${w.id}`).then(reload);
                }}
              />
            ),
          )}
        </div>
      )}

      {/* Triggers ---------------------------------------------------- */}
      <SectionHeader
        icon={<ZapIcon size={14} />}
        title="Triggers"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreatingTrigger(true)}
            disabled={creatingTrigger}
          >
            <PlusIcon size={12} />
            New trigger
          </Button>
        }
      />

      {creatingTrigger && (
        <TriggerForm
          mode="create"
          onCancel={() => setCreatingTrigger(false)}
          onSaved={() => {
            setCreatingTrigger(false);
            reload();
          }}
        />
      )}

      {loading ? (
        <Skeleton className="h-24 mb-6" />
      ) : triggers && triggers.length === 0 ? (
        <div className="mb-6 border border-border bg-panel">
          <EmptyState
            variant="ledger"
            title="No triggers"
            description="Triggers fire when a watch payload matches a predicate. Layer them on top of webhooks for rich routing."
            action={
              <Button variant="primary" onClick={() => setCreatingTrigger(true)}>
                <PlusIcon size={12} />
                New trigger
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {(triggers ?? []).map((t) =>
            editingTriggerId === t.id ? (
              <TriggerForm
                key={t.id}
                mode="edit"
                trigger={t}
                onCancel={() => setEditingTriggerId(null)}
                onSaved={() => {
                  setEditingTriggerId(null);
                  reload();
                }}
              />
            ) : (
              <TriggerCard
                key={t.id}
                trigger={t}
                onToggle={(next: boolean) =>
                  void apiPatch(`/triggers/${t.id}`, { enabled: next }).then(reload)
                }
                onEdit={() => setEditingTriggerId(t.id)}
                onDelete={() => {
                  if (!confirm(`Delete trigger "${t.name}"?`)) return;
                  apiDelete(`/triggers/${t.id}`).then(reload);
                }}
              />
            ),
          )}
        </div>
      )}

      {/* Recent runs -------------------------------------------------- */}
      <SectionHeader icon={<ClockIcon size={14} />} title="Recent runs" />
      {runs === null ? (
        <Skeleton className="h-32" />
      ) : runs.length === 0 ? (
        <div className="border border-border bg-panel">
          <EmptyState
            variant="ledger"
            title="No runs yet"
            description="Fire a watch manually or wait for a schedule to see entries here."
          />
        </div>
      ) : (
        <ol className="relative border border-border bg-panel">
          <span className="absolute left-[15px] top-2 bottom-2 w-px bg-border" aria-hidden />
          {runs.map((r) => (
            <RunTimelineRow key={r.id} run={r} />
          ))}
        </ol>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// SectionHeader
// ----------------------------------------------------------------------

function SectionHeader({
  icon,
  title,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-brass">{icon}</span>
      <h3 className="font-display text-[14px] font-semibold text-text tracking-wide uppercase">
        {title}
      </h3>
      <span className="flex-1 border-b border-borderSoft" />
      {action}
    </div>
  );
}

// ----------------------------------------------------------------------
// Watch card + form
// ----------------------------------------------------------------------

function WatchCard({
  watch,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  watch: Watch;
  onToggle: (next: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { addToast } = useToast();
  const summary = useMemo(() => describeWatch(watch), [watch]);
  return (
    <div
      className={cn(
        "border bg-panel px-4 py-3 flex items-start gap-3",
        watch.enabled ? "border-border" : "border-borderSoft opacity-70",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[14px] text-text">{watch.name}</span>
          <Badge tone={SOURCE_TONE[watch.source]}>{watch.source}</Badge>
          <Badge tone="neutral">→ {watch.action}</Badge>
          <span className="font-mono text-[11px] text-textMuted truncate">{summary}</span>
        </div>
        <div className="mt-1 mono-caps text-[10px] text-textFaint tracking-wider flex items-center gap-3 flex-wrap">
          {watch.source === "schedule" && (
            <span className="inline-flex items-center gap-1">
              <ClockIcon size={9} />
              {String(watch.config.cron ?? "")}
            </span>
          )}
          {watch.source === "webhook" && (
            <span className="inline-flex items-center gap-1">
              <WebhookIcon size={9} />
              /api/webhooks/{watch.id.slice(0, 8)}
            </span>
          )}
          {watch.last_fired_at && (
            <span>last fired {relativeTime(watch.last_fired_at)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Toggle on={watch.enabled} onChange={onToggle} />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onRun();
            addToast({
              id: `watch-run-${Date.now()}`,
              title: "Fired",
              description: `${watch.name} queued`,
              tone: "info",
              duration: 2200,
            });
          }}
        >
          <PlayIcon size={10} />
          Run
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit">
          <EditIcon size={12} />
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete">
          <TrashIcon size={12} />
        </Button>
      </div>
    </div>
  );
}

function describeWatch(w: Watch): string {
  const c = w.config ?? {};
  const ac = w.action_config ?? {};
  switch (w.source) {
    case "schedule":
      return String(c.cron ?? "");
    case "webhook":
      return `path: ${c.path ?? "—"}${c.secret ? " · bearer" : ""}`;
    case "email":
      return String(c.address ?? "");
    case "file":
      return String(c.glob ?? "");
    case "manual":
      return "manual only";
    default:
      switch (w.action) {
        case "panel_message":
          return `panel ${String(ac.panel_id ?? "—").slice(0, 8)}`;
        case "http_post":
          return String(ac.url ?? "");
        case "agent_run":
          return String(ac.prompt ?? "").slice(0, 60);
      }
  }
}

function WatchForm({
  mode,
  watch,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  watch?: Watch;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState(watch?.name ?? "");
  const [source, setSource] = useState<WatchSource>(watch?.source ?? "schedule");
  const [action, setAction] = useState<WatchAction>(watch?.action ?? "panel_message");
  const [enabled, setEnabled] = useState<boolean>(watch?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Config fields — keyed off source.
  const [cron, setCron] = useState(String((watch?.config?.cron as string) ?? ""));
  const [webhookPath, setWebhookPath] = useState(String((watch?.config?.path as string) ?? ""));
  const [webhookSecret, setWebhookSecret] = useState(String((watch?.config?.secret as string) ?? ""));
  const [emailAddress, setEmailAddress] = useState(String((watch?.config?.address as string) ?? ""));
  const [fileGlob, setFileGlob] = useState(String((watch?.config?.glob as string) ?? ""));

  // Action config.
  const [panelId, setPanelId] = useState(String((watch?.action_config?.panel_id as string) ?? ""));
  const [content, setContent] = useState(String((watch?.action_config?.content as string) ?? ""));
  const [httpUrl, setHttpUrl] = useState(String((watch?.action_config?.url as string) ?? ""));
  const [httpBody, setHttpBody] = useState(
    watch?.action_config?.body ? JSON.stringify(watch.action_config.body, null, 2) : "",
  );
  const [prompt, setPrompt] = useState(String((watch?.action_config?.prompt as string) ?? ""));

  const configForSource = (): Record<string, unknown> => {
    switch (source) {
      case "schedule":
        return { cron: cron.trim() };
      case "webhook": {
        const out: Record<string, unknown> = { path: webhookPath.trim() };
        if (webhookSecret.trim()) out.secret = webhookSecret.trim();
        return out;
      }
      case "email":
        return { address: emailAddress.trim() };
      case "file":
        return { glob: fileGlob.trim() };
      case "manual":
        return {};
    }
  };

  const configForAction = (): Record<string, unknown> => {
    switch (action) {
      case "panel_message":
        return { panel_id: panelId.trim(), content };
      case "http_post": {
        let body: unknown = httpBody;
        if (httpBody.trim().length > 0) {
          try { body = JSON.parse(httpBody); } catch { /* leave as string */ }
        }
        return { url: httpUrl.trim(), body };
      }
      case "agent_run":
        return { prompt };
    }
  };

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        source,
        config: configForSource(),
        action,
        action_config: configForAction(),
        enabled,
      };
      if (mode === "create") {
        await apiPost("/watches", body);
      } else if (watch) {
        await apiPatch(`/watches/${watch.id}`, body);
      }
      addToast({
        id: `watch-save-${Date.now()}`,
        title: mode === "create" ? "Watch created" : "Watch saved",
        tone: "success",
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-brass/40 bg-brass/5 mb-2 p-4 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Input
          name="watch-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily standup summary"
        />
        <Select
          label="Source"
          value={source}
          onChange={(v) => setSource(v as WatchSource)}
          options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
        />
        <Select
          label="Action"
          value={action}
          onChange={(v) => setAction(v as WatchAction)}
          options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
        />
      </div>

      {/* Per-source config */}
      <div className="border border-border bg-panel p-3">
        <div className="mono-caps text-[10px] text-textMuted mb-2">
          source config · {SOURCES.find((s) => s.value === source)?.hint}
        </div>
        {source === "schedule" && (
          <Input
            name="watch-cron"
            label="Cron expression"
            placeholder="0 9 * * 1-5"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            hint="5-field Unix cron, evaluated in UTC"
          />
        )}
        {source === "webhook" && (
          <div className="grid grid-cols-2 gap-2">
            <Input
              name="watch-webhook-path"
              label="Path slug"
              placeholder="deploy-hook"
              value={webhookPath}
              onChange={(e) => setWebhookPath(e.target.value)}
              hint="appears at /api/webhooks/{id}"
            />
            <Input
              name="watch-webhook-secret"
              label="Bearer secret"
              placeholder="optional"
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
            />
          </div>
        )}
        {source === "email" && (
          <Input
            name="watch-email"
            label="Inbound address"
            placeholder="ops@in.example.com"
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
          />
        )}
        {source === "file" && (
          <Input
            name="watch-file-glob"
            label="Glob"
            placeholder="/inbox/*.csv"
            value={fileGlob}
            onChange={(e) => setFileGlob(e.target.value)}
            hint="relative to the sandbox"
          />
        )}
        {source === "manual" && (
          <div className="mono-caps text-[10px] text-textFaint">
            no config — fires only via "Run now"
          </div>
        )}
      </div>

      {/* Per-action config */}
      <div className="border border-border bg-panel p-3">
        <div className="mono-caps text-[10px] text-textMuted mb-2">
          action config · {ACTIONS.find((a) => a.value === action)?.hint}
        </div>
        {action === "panel_message" && (
          <div className="space-y-2">
            <Input
              name="watch-panel-id"
              label="Panel id"
              placeholder="UUID"
              value={panelId}
              onChange={(e) => setPanelId(e.target.value)}
            />
            <Textarea
              label="Content template"
              value={content}
              onChange={setContent}
              placeholder="Hello from watch — {{watch.name}} fired because {{reason}}"
              hint="{{watch.name}}, {{reason}}, {{payload.foo}} expand"
            />
          </div>
        )}
        {action === "http_post" && (
          <div className="space-y-2">
            <Input
              name="watch-http-url"
              label="URL"
              placeholder="https://example.com/hook"
              value={httpUrl}
              onChange={(e) => setHttpUrl(e.target.value)}
            />
            <Textarea
              label="Body (JSON or template)"
              value={httpBody}
              onChange={setHttpBody}
              placeholder='{"event": "{{reason}}"}'
            />
          </div>
        )}
        {action === "agent_run" && (
          <Textarea
            label="Prompt template"
            value={prompt}
            onChange={setPrompt}
            placeholder="Summarise today's open issues."
            hint="{{payload.body}} expands to the webhook body"
          />
        )}
      </div>

      <div className="flex items-center gap-3">
        <Toggle on={enabled} onChange={setEnabled} />
        <span className="mono-caps text-[10px] text-textMuted">{enabled ? "enabled" : "disabled"}</span>
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <span className="mono-caps text-[10px] text-rust">{error}</span>
          )}
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={saving || !name.trim()}
          >
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Trigger card + form
// ----------------------------------------------------------------------

function TriggerCard({
  trigger,
  onToggle,
  onEdit,
  onDelete,
}: {
  trigger: Trigger;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const summary = useMemo(() => describeTrigger(trigger), [trigger]);
  return (
    <div
      className={cn(
        "border bg-panel px-4 py-3 flex items-start gap-3",
        trigger.enabled ? "border-border" : "border-borderSoft opacity-70",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[14px] text-text">{trigger.name}</span>
          <Badge tone="neutral">if {trigger.when_clause.length} condition{trigger.when_clause.length === 1 ? "" : "s"}</Badge>
          <Badge tone="brass">→ {trigger.then_action}</Badge>
          <span className="font-mono text-[11px] text-textMuted truncate">{summary}</span>
        </div>
        <div className="mt-1 mono-caps text-[10px] text-textFaint tracking-wider">
          {trigger.when_clause.map((p, i) => (
            <span key={i} className="mr-3">
              <span className="text-brass">{p.op}</span>{" "}
              <span className="text-text">{p.path}</span>
              {p.value !== undefined && p.op !== "exists" ? (
                <>
                  {" "}
                  <span className="text-textFaint">{JSON.stringify(p.value)}</span>
                </>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Toggle on={trigger.enabled} onChange={onToggle} />
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit">
          <EditIcon size={12} />
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete">
          <TrashIcon size={12} />
        </Button>
      </div>
    </div>
  );
}

function describeTrigger(t: Trigger): string {
  switch (t.then_action) {
    case "panel_message":
      return `panel ${String(t.then_config.panel_id ?? "—").slice(0, 8)}`;
    case "http_post":
      return String(t.then_config.url ?? "");
    case "agent_run":
      return String(t.then_config.prompt ?? "").slice(0, 60);
  }
}

function TriggerForm({
  mode,
  trigger,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  trigger?: Trigger;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState(trigger?.name ?? "");
  const [enabled, setEnabled] = useState<boolean>(trigger?.enabled ?? true);
  const [action, setAction] = useState<WatchAction>(trigger?.then_action ?? "panel_message");
  const [predicates, setPredicates] = useState<Array<{ op: PredicateOp; path: string; value: string }>>(
    trigger?.when_clause.map((p) => ({ op: p.op, path: p.path, value: p.value === undefined ? "" : JSON.stringify(p.value) })) ?? [
      { op: "eq", path: "body.event", value: "deploy" },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Action config (mirrors WatchForm)
  const [panelId, setPanelId] = useState(String((trigger?.then_config?.panel_id as string) ?? ""));
  const [content, setContent] = useState(String((trigger?.then_config?.content as string) ?? ""));
  const [httpUrl, setHttpUrl] = useState(String((trigger?.then_config?.url as string) ?? ""));
  const [httpBody, setHttpBody] = useState(
    trigger?.then_config?.body ? JSON.stringify(trigger.then_config.body, null, 2) : "",
  );
  const [prompt, setPrompt] = useState(String((trigger?.then_config?.prompt as string) ?? ""));

  function updatePredicate(i: number, patch: Partial<{ op: PredicateOp; path: string; value: string }>) {
    setPredicates((cur) => cur.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const clause = predicates.map((p) => {
        const valueParsed: unknown = p.value === "" ? undefined : (() => {
          try { return JSON.parse(p.value); } catch { return p.value; }
        })();
        const out: { op: PredicateOp; path: string; value?: unknown } = {
          op: p.op,
          path: p.path.trim(),
        };
        if (valueParsed !== undefined) out.value = valueParsed;
        return out;
      });
      let thenConfig: Record<string, unknown>;
      switch (action) {
        case "panel_message":
          thenConfig = { panel_id: panelId.trim(), content };
          break;
        case "http_post": {
          let body: unknown = httpBody;
          if (httpBody.trim().length > 0) {
            try { body = JSON.parse(httpBody); } catch { /* leave */ }
          }
          thenConfig = { url: httpUrl.trim(), body };
          break;
        }
        case "agent_run":
          thenConfig = { prompt };
          break;
      }
      const body = { name: name.trim(), when_clause: clause, then_action: action, then_config: thenConfig, enabled };
      if (mode === "create") {
        await apiPost("/triggers", body);
      } else if (trigger) {
        await apiPatch(`/triggers/${trigger.id}`, body);
      }
      addToast({
        id: `trigger-save-${Date.now()}`,
        title: mode === "create" ? "Trigger created" : "Trigger saved",
        tone: "success",
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-brass/40 bg-brass/5 mb-2 p-4 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Input
          name="trigger-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Notify on deploy success"
        />
        <Select
          label="Then action"
          value={action}
          onChange={(v) => setAction(v as WatchAction)}
          options={ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
        />
      </div>

      <div className="border border-border bg-panel p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="mono-caps text-[10px] text-textMuted">When</span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setPredicates((cur) => [...cur, { op: "eq", path: "", value: "" }])
            }
          >
            <PlusIcon size={10} />
            add
          </Button>
        </div>
        <div className="space-y-1.5">
          {predicates.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select
                value={p.op}
                onChange={(v) => updatePredicate(i, { op: v as PredicateOp })}
                options={PREDICATE_OPS.map((o) => ({ value: o.value, label: o.label }))}
                className="w-24"
              />
              <Input
                name={`trigger-path-${i}`}
                value={p.path}
                onChange={(e) => updatePredicate(i, { path: e.target.value })}
                placeholder="body.event"
                className="flex-1"
              />
              {p.op !== "exists" && (
                <Input
                  name={`trigger-value-${i}`}
                  value={p.value}
                  onChange={(e) => updatePredicate(i, { value: e.target.value })}
                  placeholder='"deploy"'
                  className="w-40"
                />
              )}
              <button
                aria-label="Remove"
                className="text-textFaint hover:text-rust p-1"
                onClick={() => setPredicates((cur) => cur.filter((_, idx) => idx !== i))}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 mono-caps text-[10px] text-textFaint">
          empty `when` matches every payload · paths walk into payload.body / .headers / .query
        </div>
      </div>

      <div className="border border-border bg-panel p-3">
        <div className="mono-caps text-[10px] text-textMuted mb-2">Then action config</div>
        {action === "panel_message" && (
          <div className="space-y-2">
            <Input
              name="trigger-panel-id"
              label="Panel id"
              placeholder="UUID"
              value={panelId}
              onChange={(e) => setPanelId(e.target.value)}
            />
            <Textarea
              label="Content template"
              value={content}
              onChange={setContent}
              placeholder="Trigger fired — {{watch.name}}"
            />
          </div>
        )}
        {action === "http_post" && (
          <div className="space-y-2">
            <Input
              name="trigger-http-url"
              label="URL"
              placeholder="https://example.com/hook"
              value={httpUrl}
              onChange={(e) => setHttpUrl(e.target.value)}
            />
            <Textarea
              label="Body (JSON or template)"
              value={httpBody}
              onChange={setHttpBody}
              placeholder='{"event": "{{reason}}"}'
            />
          </div>
        )}
        {action === "agent_run" && (
          <Textarea
            label="Prompt template"
            value={prompt}
            onChange={setPrompt}
            placeholder="Triage this incident."
          />
        )}
      </div>

      <div className="flex items-center gap-3">
        <Toggle on={enabled} onChange={setEnabled} />
        <span className="mono-caps text-[10px] text-textMuted">{enabled ? "enabled" : "disabled"}</span>
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <span className="mono-caps text-[10px] text-rust">{error}</span>
          )}
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !name.trim()}>
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Run timeline
// ----------------------------------------------------------------------

function RunTimelineRow({ run }: { run: WatchRun }) {
  const tone = run.status === "ok" ? "teal" : run.status === "error" ? "rust" : "neutral";
  const ring = run.status === "ok" ? "border-teal" : run.status === "error" ? "border-rust" : "border-border";
  const label = run.trigger_id ? "trigger" : "watch";
  return (
    <li className="relative pl-9 pr-2 py-2.5">
      <span
        className={cn(
          "absolute left-2 top-4 w-3 h-3 rounded-full border-2 bg-bg",
          ring,
        )}
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {run.status === "ok" ? (
              <CheckIcon size={12} className="text-teal" />
            ) : (
              <XIcon size={12} className="text-rust" />
            )}
            <span className="font-mono text-[13px] text-text">{label}</span>
            <Badge tone={tone}>{run.status}</Badge>
            {run.message && (
              <span className="font-mono text-[11px] text-textMuted truncate">
                {run.message}
              </span>
            )}
          </div>
          <div className="mt-1 mono-caps text-[10px] text-textFaint tracking-wider">
            <ClockIcon size={9} className="inline mr-1 align-[-1px]" />
            {relativeTime(run.started_at)}
            {run.finished_at && (
              <span className="ml-3">
                finished {relativeTime(run.finished_at)}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ----------------------------------------------------------------------
// Atoms
// ----------------------------------------------------------------------

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      title={on ? "enabled" : "disabled"}
      className={cn(
        "relative w-9 h-5 border transition-colors",
        on ? "bg-brass/30 border-brass" : "bg-bg border-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 w-3.5 h-3.5 transition-all",
          on ? "left-[18px] bg-brass" : "left-0.5 bg-textMuted",
        )}
      />
    </button>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  className = "",
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="block mono-caps text-[11px] text-textMuted mb-1.5">{label}</span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px] focus:border-brass"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      {label && (
        <span className="block mono-caps text-[11px] text-textMuted mb-1.5">{label}</span>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[13px] focus:border-brass resize-y"
      />
      {hint && (
        <span className="block mono-caps text-[10px] text-textFaint mt-1">{hint}</span>
      )}
    </label>
  );
}

function relativeTime(ts: string): string {
  try {
    const d = new Date(ts);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}
