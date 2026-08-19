// Requests (admin) — pending access requests queue (docs §2.5).

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CallSign } from "../components/ui/CallSign";
import { Skeleton } from "../components/ui/feedback/Skeleton";

interface AccessRequest {
  id: string;
  user_id: string;
  user_name: string;
  user_username: string;
  model_id: string;
  model_name: string;
  status: "pending" | "approved" | "denied";
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export function RequestsPage() {
  const [rows, setRows] = useState<AccessRequest[] | null>(null);
  const reload = () => apiGet<AccessRequest[]>("/access-requests").then(setRows);
  useEffect(() => {
    reload();
  }, []);

  async function decide(id: string, decision: "approve" | "deny") {
    await apiPost(`/access-requests/${id}/decide`, { decision });
    reload();
  }

  // While the initial fetch is in flight we render placeholder rows so
  // the page doesn't pop in empty. After it settles we branch on
  // pending/decided with the normal content.
  if (rows === null) {
    return (
      <div className="p-6 max-w-[900px] space-y-6">
        <div>
          <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
            Requests
          </h2>
          <div className="text-textMuted text-[13px]">
            Access requests pending your decision.
          </div>
        </div>
        <Panel title="Loading…">
          <div className="space-y-3" aria-busy="true">
            <Skeleton variant="row" />
            <Skeleton variant="row" />
            <Skeleton variant="row" />
            <Skeleton variant="row" />
          </div>
        </Panel>
      </div>
    );
  }

  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  return (
    <div className="p-6 max-w-[900px] space-y-6">
      <div>
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Requests
        </h2>
        <div className="text-textMuted text-[13px]">
          Access requests pending your decision.
        </div>
      </div>

      <Panel title={`Pending (${pending.length})`}>
        {pending.length === 0 ? (
          <div className="mono-caps text-[11px] text-textFaint">none — all clear</div>
        ) : (
          <div className="divide-y divide-borderSoft">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <CallSign id={`REQ-${r.id.slice(0, 4).toUpperCase()}`} />
                <div className="flex-1">
                  <div className="font-mono text-[13px] text-text">
                    {r.user_name}
                    <span className="text-textMuted"> ({r.user_username})</span>
                  </div>
                  <div className="mono-caps text-[10px] text-textMuted">
                    wants <span className="text-brass">{r.model_name}</span> ·{" "}
                    {new Date(r.requested_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => decide(r.id, "approve")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => decide(r.id, "deny")}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={`Decided (${decided.length})`}>
        {decided.length === 0 ? (
          <div className="mono-caps text-[11px] text-textFaint">no history yet</div>
        ) : (
          <div className="divide-y divide-borderSoft">
            {decided.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5">
                <CallSign id={`REQ-${r.id.slice(0, 4).toUpperCase()}`} />
                <div className="flex-1">
                  <div className="font-mono text-[13px] text-text">{r.user_name}</div>
                  <div className="mono-caps text-[10px] text-textMuted">
                    {r.model_name} ·{" "}
                    {r.decided_at ? new Date(r.decided_at).toLocaleString() : ""}
                  </div>
                </div>
                <Badge tone={r.status === "approved" ? "teal" : "rust"}>
                  {r.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}