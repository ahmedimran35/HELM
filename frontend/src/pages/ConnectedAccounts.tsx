// ConnectedAccounts (P5). Grid of provider tiles showing the external
// identities linked to the current user.
//
//   - Google / GitHub / Microsoft → OAuth via /api/oauth/<provider>/start
//   - Slack                       → workspace install via /api/slack/install
//
// "Connect" kicks the browser to the provider's authorize URL (so the
// backend can stash state in a short-lived cookie before the redirect).
// "Disconnect" sends DELETE and refreshes the list.

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiDelete } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CallSign } from "../components/ui/CallSign";
import { SlackIcon } from "../components/ui/Icon";
import { useToast } from "../components/ui/feedback/Toast";
import { cn } from "../lib/cn";
import { safeHref, safeLocationHref } from "../lib/safe-href";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

type Provider = "google" | "github" | "microsoft";

interface ConnectedAccount {
  id: string;
  provider: Provider | "slack";
  account_id: string;
  account_email: string | null;
  account_name: string | null;
  scopes: string[];
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SlackInstall {
  id: string;
  team_id: string;
  team_name: string;
  installed_by_user_id: string | null;
  created_at: string;
}

// Slack events are loaded best-effort for the admin panel below.
interface SlackEvent {
  id: string;
  install_id: string | null;
  event_type: string;
  channel_id: string | null;
  user_id: string | null;
  handled: boolean;
  received_at: string;
}

// ─────────────────────────────────────────────────────────────────────
// Brand marks — multi-color logos live here as small React components
// rather than in the monoline icon library (they don't fit the lucide
// style but are critical identity signals on the connect tiles).
// ─────────────────────────────────────────────────────────────────────

function GoogleMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8a12 12 0 1 1 0-24c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

function GitHubMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"
      />
    </svg>
  );
}

function MicrosoftMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
      <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Provider descriptors
// ─────────────────────────────────────────────────────────────────────

interface OauthProviderDescriptor {
  id: Provider;
  label: string;
  blurb: string;
  brand: React.ReactNode;
}

const OAUTH_PROVIDERS: OauthProviderDescriptor[] = [
  {
    id: "google",
    label: "Google",
    blurb: "Single sign-on with your Workspace / personal Google account.",
    brand: <GoogleMark />,
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Use your GitHub identity to sign in and pull repo metadata.",
    brand: <GitHubMark />,
  },
  {
    id: "microsoft",
    label: "Microsoft",
    blurb: "Sign in with Microsoft Entra (Azure AD) — works across orgs.",
    brand: <MicrosoftMark />,
  },
];

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export function ConnectedAccountsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useSearchParams();
  const oauthResult = search.get("oauth"); // 'ok' | 'failed' | 'denied'
  const slackResult = search.get("slack"); // 'ok' | 'failed' | 'denied'

  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [slackInstalls, setSlackInstalls] = useState<SlackInstall[]>([]);
  const [slackEvents, setSlackEvents] = useState<SlackEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [slackUrl, setSlackUrl] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await apiGet<ConnectedAccount[]>("/oauth/accounts");
      setAccounts(rows);
    } catch {
      /* swallow — page still renders the empty grid */
    }
    // Slack tiles are admin-only.
    if (user?.role === "admin") {
      try {
        const ev = await apiGet<SlackEvent[]>("/slack/events?limit=10");
        setSlackEvents(ev);
      } catch {
        /* swallow */
      }
      try {
        const installs = await apiGet<SlackInstall[]>("/slack/installs");
        setSlackInstalls(installs);
      } catch {
        /* swallow */
      }
    }
    setLoading(false);
  }, [user?.role]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Surface toasts on return from the provider.
  useEffect(() => {
    if (oauthResult === "ok") {
      toast.addToast({
        id: "oauth-ok",
        title: "Account linked",
        description: "Your external identity is now connected.",
        tone: "success",
      });
    } else if (oauthResult === "failed") {
      toast.addToast({
        id: "oauth-failed",
        title: "Could not link account",
        description: "The provider rejected the request. Check the API logs.",
        tone: "warning",
      });
    } else if (oauthResult === "denied") {
      toast.addToast({
        id: "oauth-denied",
        title: "Cancelled",
        description: "You declined the provider's consent screen.",
        tone: "info",
      });
    }
    if (slackResult === "ok") {
      toast.addToast({
        id: "slack-ok",
        title: "Slack workspace connected",
        description: "HELM will now receive events from that workspace.",
        tone: "success",
      });
    } else if (slackResult === "failed" || slackResult === "denied") {
      toast.addToast({
        id: "slack-fail",
        title: "Slack install failed",
        description: "Check the API logs and your Slack app credentials.",
        tone: "warning",
      });
    }
    if (oauthResult || slackResult) {
      // Strip query params so a refresh doesn't re-fire the toast.
      const next = new URLSearchParams(search);
      next.delete("oauth");
      next.delete("slack");
      setSearch(next, { replace: true });
    }
  }, [oauthResult, slackResult, toast, search, setSearch]);

  function disconnect(id: string, provider: string) {
    if (!confirm(`Disconnect the linked ${provider} account?`)) return;
    apiDelete(`/oauth/accounts/${id}`)
      .then(() => {
        toast.addToast({
          id: `oauth-disconnect-${id}`,
          title: "Disconnected",
          tone: "info",
        });
        reload();
      })
      .catch((err) => {
        toast.addToast({
          id: `oauth-disconnect-fail-${id}`,
          title: "Could not disconnect",
          description: (err as Error).message,
          tone: "warning",
        });
      });
  }

  function connectOauth(provider: Provider) {
    // Bounce through the backend so the state cookie gets set server-side.
    window.location.href = `/api/oauth/${provider}/start?link=1`;
  }

  async function installSlack() {
    try {
      const res = await apiGet<{ url: string } | { error: string }>(
        "/slack/install",
      );
      if ("error" in res) {
        toast.addToast({
          id: "slack-not-config",
          title: "Slack not configured",
          description: res.error,
          tone: "warning",
        });
        return;
      }
      setSlackUrl(res.url);
      window.location.href = safeLocationHref(res.url);
    } catch (err) {
      toast.addToast({
        id: "slack-install-fail",
        title: "Could not start install",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  return (
    <div className="p-6 max-w-[1000px] space-y-6">
      <div>
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Connected accounts
        </h2>
        <div className="text-textMuted text-[13px]">
          External identities linked to your HELM account. Use them to sign in
          without typing a password, and to grant HELM scoped access to
          third-party services.
        </div>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {OAUTH_PROVIDERS.map((p) => {
          const linked = accounts.filter((a) => a.provider === p.id);
          return (
            <ProviderTile
              key={p.id}
              label={p.label}
              blurb={p.blurb}
              brand={p.brand}
              linked={linked}
              onConnect={() => connectOauth(p.id)}
              onDisconnect={(id) => disconnect(id, p.id)}
              loading={loading}
            />
          );
        })}
      </section>

      {user?.role === "admin" && (
        <section className="space-y-3">
          <div>
            <h3 className="font-display text-[15px] font-semibold text-text">
              Slack workspace
            </h3>
            <div className="text-textMuted text-[13px]">
              Install HELM into a Slack workspace to receive inbound messages.
              {slackUrl && (
                <>
                  {" "}
                  <a
                    className="text-brass hover:underline"
                    href={safeHref(slackUrl)}
                    rel="noreferrer"
                  >
                    resume install
                  </a>
                </>
              )}
            </div>
          </div>
          <SlackWorkspaceTile
            installs={slackInstalls}
            onInstall={installSlack}
          />
          <SlackEventsList events={slackEvents} loading={loading} />
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// OAuth provider tile
// ─────────────────────────────────────────────────────────────────────

function ProviderTile({
  label,
  blurb,
  brand,
  linked,
  onConnect,
  onDisconnect,
  loading,
}: {
  label: string;
  blurb: string;
  brand: React.ReactNode;
  linked: ConnectedAccount[];
  onConnect: () => void;
  onDisconnect: (id: string) => void;
  loading: boolean;
}) {
  const first = linked[0];
  return (
    <div className="border border-border bg-panel flex flex-col">
      <div className="px-4 py-2 border-b border-borderSoft flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="shrink-0">{brand}</span>
          <span className="font-display text-[14px] font-semibold text-text">
            {label}
          </span>
        </div>
        {linked.length > 0 ? (
          <Badge tone="teal">connected</Badge>
        ) : (
          <Badge tone="neutral">not connected</Badge>
        )}
      </div>
      <div className="p-4 flex-1 flex flex-col gap-3">
        <div className="text-[12px] text-textMuted leading-[1.5]">{blurb}</div>
        <div className="flex-1">
          {loading ? (
            <div className="text-textFaint mono-caps text-[10px]">loading…</div>
          ) : first ? (
            <ul className="space-y-1.5">
              {linked.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-2 border border-borderSoft bg-panelAlt px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12px] text-text truncate">
                      {a.account_email ?? a.account_name ?? a.account_id}
                    </div>
                    {a.account_email && a.account_name && (
                      <div className="text-textMuted mono-caps text-[9px] truncate">
                        {a.account_name}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDisconnect(a.id)}
                    title="Disconnect"
                  >
                    Disconnect
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-textFaint mono-caps text-[10px]">
              no identity linked yet
            </div>
          )}
        </div>
        <Button
          variant={linked.length > 0 ? "secondary" : "primary"}
          onClick={onConnect}
        >
          {linked.length > 0 ? "Connect another" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Slack workspace tile (admin)
// ─────────────────────────────────────────────────────────────────────

function SlackWorkspaceTile({
  installs,
  onInstall,
}: {
  installs: SlackInstall[];
  onInstall: () => void;
}) {
  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 text-brass">
            <SlackIcon size={18} />
          </span>
          <span className="font-display text-[14px] font-semibold text-text">
            Slack
          </span>
          {installs.length > 0 ? (
            <Badge tone="teal">
              {installs.length} workspace{installs.length === 1 ? "" : "s"}
            </Badge>
          ) : (
            <Badge tone="neutral">no workspace</Badge>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={onInstall}>
          Add to Slack
        </Button>
      </div>
      <div className="p-4 space-y-2">
        {installs.length === 0 ? (
          <div className="text-textMuted text-[12px]">
            No workspace is connected yet. Click <em>Add to Slack</em> to begin
            the install flow — you'll be sent to Slack to approve the scopes
            HELM needs to receive events.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {installs.map((i) => (
              <li
                key={i.id}
                className="flex items-center justify-between gap-3 border border-borderSoft bg-panelAlt px-2 py-1.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CallSign id={`SLK-${i.id.slice(0, 4).toUpperCase()}`} variant="muted" />
                  <span className="font-mono text-[12px] text-text truncate">
                    {i.team_name}
                  </span>
                  {i.team_id && (
                    <span className="mono-caps text-[10px] text-textMuted truncate">
                      {i.team_id}
                    </span>
                  )}
                </div>
                <span className="mono-caps text-[10px] text-textFaint shrink-0">
                  {new Date(i.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Slack events list (admin)
// ─────────────────────────────────────────────────────────────────────

function SlackEventsList({
  events,
  loading,
}: {
  events: SlackEvent[];
  loading: boolean;
}) {
  return (
    <div className="border border-border bg-panel">
      <div className="px-4 py-2 border-b border-borderSoft flex items-center justify-between">
        <span className="font-display text-[13px] font-semibold text-text">
          Inbound events
        </span>
        <span className="mono-caps text-[10px] text-textMuted">
          most recent {events.length}
        </span>
      </div>
      <div className="divide-y divide-borderSoft">
        {loading ? (
          <div className="px-4 py-3 text-textFaint mono-caps text-[10px]">
            loading…
          </div>
        ) : events.length === 0 ? (
          <div className="px-4 py-3 text-textFaint mono-caps text-[10px]">
            no events yet — send a message in the Slack workspace to see it
            land here
          </div>
        ) : (
          events.map((e) => (
            <div key={e.id} className="px-4 py-2 flex items-center gap-3">
              <CallSign id={`SLK-${e.id.slice(0, 4).toUpperCase()}`} variant="muted" />
              <span className="font-mono text-[12px] text-text">{e.event_type}</span>
              <span
                className={cn(
                  "mono-caps text-[10px]",
                  e.handled ? "text-teal" : "text-textMuted",
                )}
              >
                {e.handled ? "handled" : "pending"}
              </span>
              {e.channel_id && (
                <span className="mono-caps text-[10px] text-textMuted truncate">
                  #{e.channel_id}
                </span>
              )}
              <span className="ml-auto mono-caps text-[10px] text-textFaint">
                {new Date(e.received_at).toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}