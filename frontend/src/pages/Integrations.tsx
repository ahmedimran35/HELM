// Integrations (admin, docs §2.9). Discord / Telegram / Slack webhooks.

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { Skeleton } from "../components/ui/feedback/Skeleton";

interface Integration {
  id: string;
  service: "discord" | "telegram" | "slack";
  webhook_url: string;
  webhook_url_masked: string;
  events: string[];
  connected: boolean;
}

const ALL_EVENTS = [
  "access_requested",
  "access_decided",
  "budget_alert",
  "panel_activity",
];

export function IntegrationsPage() {
  const [list, setList] = useState<Integration[] | null>(null);
  const reload = () => apiGet<Integration[]>("/integrations").then(setList);
  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="p-6 max-w-[860px] space-y-6">
      <div>
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Integrations
        </h2>
        <div className="text-textMuted text-[13px]">
          Outbound webhooks — Discord, Telegram, Slack. One row per service.
        </div>
      </div>

      {list === null ? (
        <div className="border border-border bg-panel p-4 space-y-3">
          <Skeleton variant="text" width="40%" />
          <Skeleton variant="block" height={36} />
          <Skeleton variant="block" height={36} />
        </div>
      ) : (
        ["discord", "telegram", "slack"].map((svc) => (
          <ServiceBlock
            key={svc}
            service={svc as Integration["service"]}
            existing={list.find((i) => i.service === svc)}
            onChanged={reload}
          />
        ))
      )}
    </div>
  );
}

function ServiceBlock({
  service,
  existing,
  onChanged,
}: {
  service: Integration["service"];
  existing: Integration | undefined;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState(existing?.webhook_url ?? "");
  const [events, setEvents] = useState<string[]>(existing?.events ?? []);
  const [testResult, setTestResult] = useState<null | { result: string; error?: string }>(null);

  useEffect(() => {
    setUrl(existing?.webhook_url ?? "");
    setEvents(existing?.events ?? []);
  }, [existing?.id]);

  function toggleEvent(e: string) {
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  }

  async function save() {
    if (!url.trim()) return;
    await apiPost("/integrations", {
      service,
      webhook_url: url,
      events,
      connected: true,
    });
    onChanged();
  }

  async function remove() {
    if (!existing) return;
    if (!confirm(`Remove ${service} integration?`)) return;
    await apiDelete(`/integrations/${existing.id}`);
    onChanged();
  }

  async function test() {
    if (!existing) return;
    setTestResult(null);
    const r = await apiPost<{ result: string; error?: string }>(
      `/integrations/${existing.id}/test`,
    );
    setTestResult(r);
    onChanged();
  }

  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CallSign id={`INT-${service.toUpperCase().slice(0, 3)}`} />
          <span className="font-display text-[14px] font-semibold text-text">{service}</span>
          {existing ? <Badge tone="teal">connected</Badge> : <Badge tone="neutral">not set</Badge>}
        </div>
        {existing && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={test}>Test send</Button>
            <Button variant="danger" size="sm" onClick={remove}>Remove</Button>
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <Input
          name={`${service}-url`}
          label="Webhook URL"
          placeholder={`https://${service === "slack" ? "hooks.slack.com" : service === "discord" ? "discord.com/api/webhooks" : "api.telegram.org"}/…`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div>
          <div className="mono-caps text-[10px] text-textMuted mb-2">Events</div>
          <div className="grid grid-cols-2 gap-2">
            {ALL_EVENTS.map((e) => {
              const on = events.includes(e);
              return (
                <button
                  key={e}
                  onClick={() => toggleEvent(e)}
                  className={`mono-caps text-[10px] px-2 h-7 border ${
                    on
                      ? "bg-brass text-bg border-brass"
                      : "bg-bg text-textMuted border-border hover:text-text"
                  }`}
                >
                  {e}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save} disabled={!url.trim()}>
            Save
          </Button>
          {testResult && (
            <Badge tone={testResult.result === "delivered" ? "teal" : "rust"}>
              test: {testResult.result}
              {testResult.error ? ` · ${testResult.error}` : ""}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}