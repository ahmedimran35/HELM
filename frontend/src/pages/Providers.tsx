// Providers (admin, docs §2.5, §2.6). Three sub-tabs:
//   providers  — CRUD on provider configs
//   models     — registry, with per-model playground
//   playground — side-by-side comparison of two models

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { NoAccess } from "../components/ui/NoAccess";

interface Provider {
  id: string;
  type: string;
  base_url: string;
  display_name: string | null;
  api_key_masked: string;
  added_at: string;
  model_count: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  provider_type: string;
  external_id: string;
  display_name: string;
  assigned: boolean;
  pending_request: boolean;
}

type Tab = "providers" | "models" | "playground";

export function ProvidersPage() {
  const [tab, setTab] = useState<Tab>("providers");
  const { user } = useAuth();
  if (user?.role !== "admin") return <NoAccess title="Providers" />;
  return (
    <div className="p-6 max-w-[960px]">
      <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
        Providers
      </h2>
      <div className="text-textMuted text-[13px] mb-4">
        Add AI providers, manage the model registry, run side-by-side comparisons.
      </div>
      <div className="flex items-center gap-4 border-b border-border mb-6">
        {(["providers", "models", "playground"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`mono-caps text-[11px] py-2 -mb-px border-b-2 transition-colors ${
              tab === t
                ? "text-text border-brass"
                : "text-textMuted border-transparent hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "providers" && <ProvidersTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "playground" && <PlaygroundTab />}
    </div>
  );
}

function ProvidersTab() {
  const [list, setList] = useState<Provider[]>([]);
  const reload = () => apiGet<Provider[]>("/providers").then(setList);
  useEffect(() => {
    reload();
  }, []);

  const [type, setType] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      // allow_local so the bundled fake provider works in dev.
      await apiPost("/providers?allow_local=1", {
        type,
        base_url: baseUrl,
        api_key: apiKey,
        display_name: name || null,
      });
      setBaseUrl("");
      setApiKey("");
      setName("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function fetch(p: Provider) {
    setError(null);
    setLastFetched(null);
    try {
      const res = await apiPost<{ ok: boolean; added: number; updated: number; total: number }>(
        `/providers/${p.id}/fetch?allow_local=1`,
      );
      setLastFetched(`Fetched ${res.total} models (${res.added} new, ${res.updated} refreshed)`);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(p: Provider) {
    if (!confirm(`Remove provider "${p.display_name ?? p.base_url}"?`)) return;
    await apiDelete(`/providers/${p.id}`);
    reload();
  }

  return (
    <div className="space-y-6">
      <div className="border border-border bg-panel p-4 space-y-3">
        <div className="mono-caps text-[11px] text-textMuted">Add provider</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block mono-caps text-[10px] text-textMuted mb-1">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px]"
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="nvidia-nim">nvidia-nim</option>
              <option value="openai-compatible">openai-compatible</option>
            </select>
          </label>
          <Input
            name="base-url"
            label="Base URL"
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <Input
            name="api-key"
            label="API key"
            type="password"
            placeholder="sk-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Input
            name="display-name"
            label="Display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && (
          <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
            {error}
          </div>
        )}
        {lastFetched && (
          <div className="mono-caps text-[11px] text-teal border border-teal/40 bg-teal/10 px-2 py-1.5">
            {lastFetched}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="primary" onClick={add} disabled={!baseUrl || !apiKey}>
            Add provider
          </Button>
        </div>
      </div>

      <div className="border border-border bg-panel">
        <div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted">
          Configured ({list.length})
        </div>
        {list.length === 0 ? (
          <div className="p-6 text-center mono-caps text-[11px] text-textFaint">
            no providers
          </div>
        ) : (
          list.map((p) => (
            <div
              key={p.id}
              className="px-4 py-3 border-b border-borderSoft last:border-b-0 flex items-center gap-3"
            >
              <CallSign id={`PRV-${p.id.slice(0, 4).toUpperCase()}`} />
              <div className="flex-1">
                <div className="font-mono text-[13px] text-text">
                  {p.display_name || p.type || p.base_url}
                </div>
                <div className="mono-caps text-[10px] text-textMuted">
                  {p.type} · {p.base_url} · {p.model_count} models · key {p.api_key_masked}
                </div>
              </div>
              <Button size="sm" onClick={() => fetch(p)}>Fetch</Button>
              <Button variant="danger" size="sm" onClick={() => remove(p)}>Remove</Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ModelsTab() {
  const [models, setModels] = useState<ModelRow[]>([]);
  useEffect(() => {
    apiGet<ModelRow[]>("/models").then(setModels);
  }, []);
  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted">
        Model registry ({models.length})
      </div>
      {models.length === 0 ? (
        <div className="p-6 text-center mono-caps text-[11px] text-textFaint">
          no models — add a provider and click Fetch
        </div>
      ) : (
        models.map((m) => (
          <div
            key={m.id}
            className="px-4 py-2 border-b border-borderSoft last:border-b-0 flex items-center gap-3"
          >
            <CallSign id={`MDL-${m.external_id.slice(0, 6).toUpperCase()}`} />
            <div className="flex-1">
              <div className="font-mono text-[13px] text-text">{m.display_name}</div>
              <div className="mono-caps text-[10px] text-textMuted">
                {m.provider_type} · {m.external_id}
              </div>
            </div>
            {m.assigned ? (
              <Badge tone="teal">on</Badge>
            ) : m.pending_request ? (
              <Badge tone="brass">pending</Badge>
            ) : (
              <Badge tone="neutral">off</Badge>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function PlaygroundTab() {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [prompt, setPrompt] = useState("Explain what a vector database is in two sentences.");
  const [replyA, setReplyA] = useState("");
  const [replyB, setReplyB] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<ModelRow[]>("/models").then((m) => {
      setModels(m);
      if (m[0]) setA(m[0].id);
      if (m[1]) setB(m[1].id);
    });
  }, []);

  async function run() {
    if (!a || !b || !prompt.trim() || streaming) return;
    setReplyA("");
    setReplyB("");
    setError(null);
    setStreaming(true);
    const res = await fetch("/api/models/playground", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_a: a, model_b: b, prompt }),
    });
    if (!res.ok || !res.body) {
      setStreaming(false);
      setError(`request failed: ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              if (ev.label === "A" && ev.delta) setReplyA((s) => s + ev.delta);
              if (ev.label === "B" && ev.delta) setReplyB((s) => s + ev.delta);
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (err) {
      setError(`stream interrupted: ${(err as Error).message ?? "unknown error"}`);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <ModelSelect label="Model A" models={models} value={a} onChange={setA} />
        <ModelSelect label="Model B" models={models} value={b} onChange={setB} />
        <Button variant="primary" onClick={run} disabled={streaming || !a || !b}>
          {streaming ? "Streaming…" : "Compare"}
        </Button>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        className="w-full bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[13px] resize-none focus:border-brass"
      />
      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <ReplyPanel label="A" content={replyA} />
        <ReplyPanel label="B" content={replyB} />
      </div>
    </div>
  );
}

function ModelSelect({
  label,
  models,
  value,
  onChange,
}: {
  label: string;
  models: ModelRow[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block mono-caps text-[10px] text-textMuted mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px]"
      >
        <option value="">—</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.display_name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReplyPanel({ label, content }: { label: string; content: string }) {
  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft flex items-center justify-between">
        <span className="mono-caps text-[11px] text-textMuted">Reply {label}</span>
        <Badge tone={content ? "teal" : "neutral"}>{content ? "done" : "idle"}</Badge>
      </div>
      <div className="p-4 min-h-[160px] text-[13px] text-text whitespace-pre-wrap leading-relaxed font-mono">
        {content || <span className="mono-caps text-textFaint text-[10px]">—</span>}
      </div>
    </div>
  );
}