import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { NoAccess } from "../components/ui/NoAccess";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import { useAuth } from "../auth/AuthContext";

interface Strategy { id: string; scope: string; scope_id: string | null; kind: string; config: Record<string, unknown>; enabled: boolean; priority: number; }

export function MemoryStrategiesPage() {
  const { user } = useAuth();
  const [list, setList] = useState<Strategy[] | null>(null);
  const [scope, setScope] = useState("personal");
  const [scopeId, setScopeId] = useState("");
  const [kind, setKind] = useState("rows");
  const [priority, setPriority] = useState("100");
  const [config, setConfig] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const reload = () => apiGet<Strategy[]>("/memory/strategies").then(setList).catch((e) => setError(e.message));
  useEffect(() => { reload(); }, []);
  if (user?.role !== "admin") return <NoAccess title="Memory Strategies" />;
  async function create() {
    try { setError(null); await apiPost("/memory/strategies", { scope, scope_id: scopeId || null, kind, priority: Number(priority), config: JSON.parse(config) }); setConfig("{}"); reload(); }
    catch (e) { setError((e as Error).message); }
  }
  async function summarize(id: string) { try { await apiPost(`/memory/strategies/${id}/summarize`); reload(); } catch (e) { setError((e as Error).message); } }
  return <div className="p-6 max-w-[1100px] space-y-6">
    <div><h2 className="font-display text-[20px] font-semibold text-text tracking-wide">Memory strategies</h2><p className="text-textMuted text-[13px]">Configure how HELM stores, recalls, and summarizes memory.</p></div>
    <div className="border border-border bg-panel p-4 space-y-3">
      <div className="mono-caps text-[11px] text-textMuted">+ New strategy</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <label className="mono-caps text-[10px] text-textMuted">Scope<select value={scope} onChange={e => setScope(e.target.value)} className="mt-1 w-full h-9 bg-panelAlt border border-border text-text px-2"><option>personal</option><option>team</option><option>admin</option></select></label>
        <Input name="scope-id" label="Scope ID (optional)" value={scopeId} onChange={e => setScopeId(e.target.value)} />
        <label className="mono-caps text-[10px] text-textMuted">Kind<select value={kind} onChange={e => setKind(e.target.value)} className="mt-1 w-full h-9 bg-panelAlt border border-border text-text px-2"><option>rows</option><option>summary</option><option>vector</option></select></label>
        <Input name="priority" label="Priority" type="number" value={priority} onChange={e => setPriority(e.target.value)} />
      </div>
      <label className="block mono-caps text-[10px] text-textMuted">Config JSON<textarea value={config} onChange={e => setConfig(e.target.value)} rows={3} className="mt-1 w-full bg-panelAlt border border-border text-text p-2 font-mono text-[12px]" /></label>
      {error && <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">{error}</div>}
      <div className="flex justify-end"><Button variant="primary" onClick={create}>Create strategy</Button></div>
    </div>
    <div className="border border-border bg-panel"><div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted">Configured ({list?.length ?? 0})</div>
      {list === null ? (
        <div className="p-4 space-y-3" aria-busy="true">
          <Skeleton variant="row" />
          <Skeleton variant="row" />
          <Skeleton variant="row" />
        </div>
      ) : list.length === 0 ? (
        <div className="p-6 text-center mono-caps text-[11px] text-textFaint">no strategies</div>
      ) : (
        list.map(s => (
          <div key={s.id} className="px-4 py-3 border-b border-borderSoft last:border-0 flex items-center gap-3">
            <div className="flex-1">
              <div className="font-mono text-[13px] text-text">{s.kind}</div>
              <div className="mono-caps text-[10px] text-textMuted">{s.scope} · {s.scope_id ?? "all"} · priority {s.priority}</div>
            </div>
            <button
              type="button"
              aria-label={`Enable ${s.kind}`}
              onClick={() => apiPatch(`/memory/strategies/${s.id}`, { enabled: !s.enabled }).then(reload)}
              className={`mono-caps text-[10px] px-2 py-1 border ${s.enabled ? "border-teal/50 text-teal" : "border-border text-textFaint"}`}
            >
              {s.enabled ? "enabled" : "disabled"}
            </button>
            {s.kind === "summary" && (
              <Button size="sm" onClick={() => summarize(s.id)}>Summarize now</Button>
            )}
            <Button variant="danger" size="sm" onClick={() => apiDelete(`/memory/strategies/${s.id}`).then(reload)}>Delete</Button>
          </div>
        ))
      )}
    </div>
  </div>;
}
