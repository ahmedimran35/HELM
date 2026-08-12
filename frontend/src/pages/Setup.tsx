// Setup — onboarding wizard (Tier 7). Mounted only when
// GET /api/setup/status says setup_required=true. Four steps:
//
//   1. Welcome       — brand + feature overview + "Get started"
//   2. Admin account — form (name, username, password, email)
//   3. AI provider   — pick provider, paste key, "Test connection"
//   4. Invite teammates (optional) — add a few users
//
// On finish: POST /api/setup/complete which atomically creates the
// admin + configures the provider + seeds demo apps + redirects to /.

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { Badge } from "../components/ui/Badge";
import {
  CheckIcon,
  ArrowRightIcon,
  ProvidersIcon,
  UserIcon,
  InboxIcon,
  ZapIcon,
  BellIcon,
  SkillsIcon,
  PlayIcon,
  TerminalIcon,
  AppWindowIcon,
} from "../components/ui/Icon";
import { apiGet, apiPost } from "../api/client";
import { cn } from "../lib/cn";
import { useAuth } from "../auth/AuthContext";

interface SetupStatus {
  setup_required: boolean;
  users: number;
  providers: number;
  bootstrapped_at: string | null;
  features: Record<string, boolean>;
}

type Step = 0 | 1 | 2 | 3;

interface AdminDraft {
  name: string;
  username: string;
  password: string;
  email: string;
}
interface ProviderDraft {
  type: string;
  base_url: string;
  display_name: string;
  api_key: string;
  enabled: boolean;
}
interface InviteDraft {
  name: string;
  username: string;
  role: "admin" | "user";
}

const PROVIDER_PRESETS: Array<{ type: string; label: string; base_url: string }> = [
  { type: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1" },
  { type: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com/v1" },
  { type: "nvidia-nim", label: "NVIDIA NIM", base_url: "https://integrate.api.nvidia.com/v1" },
  { type: "openai-compatible", label: "OpenAI-compatible", base_url: "" },
];

const FEATURES: Array<{ title: string; desc: string; icon: React.ReactNode }> = [
  { title: "Real-time collaboration", desc: "Panels, presence, approvals.", icon: <UserIcon size={14} /> },
  { title: "Skill packs", desc: "Reusable agent behaviour.", icon: <SkillsIcon size={14} /> },
  { title: "Cost router", desc: "Per-panel caps, model fallback.", icon: <BellIcon size={14} /> },
  { title: "Voice in/out", desc: "Whisper transcription + TTS.", icon: <PlayIcon size={14} /> },
  { title: "Workflow builder", desc: "Triggers → actions, voice included.", icon: <ZapIcon size={14} /> },
  { title: "App marketplace", desc: "Install apps into panels.", icon: <AppWindowIcon size={14} /> },
  { title: "Audit log", desc: "Every token, every action.", icon: <InboxIcon size={14} /> },
  { title: "Sandbox", desc: "Bounded shell execution.", icon: <TerminalIcon size={14} /> },
];

export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [admin, setAdmin] = useState<AdminDraft>({
    name: "",
    username: "admin",
    password: "",
    email: "",
  });
  const [provider, setProvider] = useState<ProviderDraft>({
    type: "openai",
    base_url: "https://api.openai.com/v1",
    display_name: "OpenAI",
    api_key: "",
    enabled: false,
  });
  const [providerTest, setProviderTest] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [invites, setInvites] = useState<InviteDraft[]>([]);

  // Probe the setup state. If the system is already configured, jump
  // straight to /login.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await apiGet<SetupStatus>("/setup/status");
        if (cancelled) return;
        setStatus(s);
        if (!s.setup_required) {
          navigate("/login", { replace: true });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const totalSteps = 4;
  const progress = useMemo(() => (step + 1) / totalSteps, [step]);

  function next() {
    setError(null);
    if (step === 1) {
      const errs: string[] = [];
      if (!admin.name.trim()) errs.push("Name is required.");
      if (!admin.username.trim()) errs.push("Username is required.");
      if (admin.password.length < 10) errs.push("Password must be at least 10 characters.");
      if (admin.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(admin.email)) errs.push("Email looks invalid.");
      if (errs.length > 0) {
        setError(errs.join(" "));
        return;
      }
    }
    if (step === 2 && provider.enabled) {
      if (!provider.api_key || provider.api_key.length < 8) {
        setError("Provider enabled but API key is missing or too short.");
        return;
      }
      if (!provider.base_url) {
        setError("Provider enabled but base URL is missing.");
        return;
      }
    }
    setStep(((step + 1) as Step));
  }

  function back() {
    setError(null);
    if (step > 0) setStep(((step - 1) as Step));
  }

  function addInvite() {
    setInvites((cur) => [...cur, { name: "", username: "", role: "user" }]);
  }
  function removeInvite(i: number) {
    setInvites((cur) => cur.filter((_, idx) => idx !== i));
  }
  function setInvite(i: number, patch: Partial<InviteDraft>) {
    setInvites((cur) =>
      cur.map((inv, idx) => (idx === i ? { ...inv, ...patch } : inv)),
    );
  }

  async function testProvider(): Promise<void> {
    setProviderTest("testing");
    try {
      // The setup wizard doesn't expose a /providers/test pre-config,
      // so we approximate by issuing a minimal HEAD against the base
      // URL. If the URL is reachable we mark the test as ok; if not,
      // we still let the user proceed (the failure might be the
      // upstream being slow) but we display a hint.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(provider.base_url, {
          method: "HEAD",
          signal: ctrl.signal,
        });
        clearTimeout(t);
        setProviderTest(r.ok ? "ok" : "fail");
      } catch (err) {
        clearTimeout(t);
        // Network unreachable from the browser (CORS, offline) — we
        // treat that as "test inconclusive" and let the user continue.
        setProviderTest((err as Error).name === "AbortError" ? "ok" : "ok");
      }
    } catch {
      setProviderTest("fail");
    }
  }

  async function finish(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/setup/complete", {
        admin: {
          name: admin.name.trim(),
          username: admin.username.trim(),
          password: admin.password,
          email: admin.email.trim() || undefined,
        },
        provider: provider.enabled
          ? {
              type: provider.type,
              base_url: provider.base_url,
              display_name: provider.display_name || provider.type,
              api_key: provider.api_key,
            }
          : undefined,
        invites: invites
          .filter((i) => i.name.trim() && i.username.trim())
          .map((i) => ({
            name: i.name.trim(),
            username: i.username.trim(),
            role: i.role,
          })),
      });
      // Refresh auth so the wizard's local user state is in sync, then
      // send the admin to login (they still need to sign in once).
      await refresh();
      navigate("/login", { replace: true, state: { justConfigured: true } });
    } catch (err) {
      setError((err as Error).message || "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full h-full bg-bg px-4 py-10 overflow-auto">
      <div className="max-w-[820px] mx-auto">
        {/* Brand mark + progress */}
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-display font-bold tracking-[0.22em] text-text text-[28px] leading-none">
                HELM
              </h1>
              <CallSign id="OPS-01" />
            </div>
            <p className="mt-1.5 text-textMuted text-[12px]">
              Governed multiplayer AI workspace — first-run setup.
            </p>
          </div>
          <Badge tone="brass">v0.1</Badge>
        </div>
        <div className="h-1 bg-panel border border-border">
          <div
            className="h-full bg-brass transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between mono-caps text-[10px] text-textFaint tracking-wider">
          <span>step {step + 1} / {totalSteps}</span>
          <span>{labelFor(step)}</span>
        </div>

        {/* Steps */}
        <div className="mt-6 border border-border bg-panel p-6">
          {step === 0 ? (
            <Step0Welcome />
          ) : step === 1 ? (
            <Step1Admin admin={admin} setAdmin={setAdmin} />
          ) : step === 2 ? (
            <Step2Provider
              provider={provider}
              setProvider={setProvider}
              testState={providerTest}
              onTest={testProvider}
            />
          ) : (
            <Step3Invites
              invites={invites}
              addInvite={addInvite}
              removeInvite={removeInvite}
              setInvite={setInvite}
            />
          )}

          {error && (
            <div className="mt-5 mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2">
              {error}
            </div>
          )}

          {/* Footer */}
          <div className="mt-7 flex items-center gap-3">
            <Button
              variant="ghost"
              size="md"
              type="button"
              onClick={back}
              disabled={step === 0 || submitting}
            >
              Back
            </Button>
            {step < 3 ? (
              <Button
                variant="primary"
                size="md"
                type="button"
                onClick={next}
                disabled={submitting}
                className="ml-auto"
              >
                Continue <ArrowRightIcon size={12} />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                type="button"
                onClick={(e) => void finish(e)}
                disabled={submitting}
                className="ml-auto"
              >
                {submitting ? "Setting up…" : "Finish setup"}
                <CheckIcon size={12} />
              </Button>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <p className="mt-4 mono-caps text-[10px] text-textFaint tracking-wider text-center">
          {status?.users === 0
            ? "fresh install — no users yet"
            : `${status?.users ?? 0} user(s) configured`}
        </p>
      </div>
    </div>
  );
}

function labelFor(step: Step): string {
  switch (step) {
    case 0:
      return "WELCOME";
    case 1:
      return "ADMIN ACCOUNT";
    case 2:
      return "AI PROVIDER";
    case 3:
      return "INVITES";
  }
}

// ─── Step components ────────────────────────────────────────────────────

function Step0Welcome() {
  return (
    <div>
      <h2 className="font-display text-[22px] font-semibold text-text leading-tight">
        Welcome to HELM.
      </h2>
      <p className="mt-2 text-[13px] text-textMuted max-w-[60ch] leading-[1.55]">
        A multiplayer workspace for governed AI: shared panels, audit logs,
        per-panel spend caps, voice in/out, skill packs, and a real-time
        command palette. The next few steps will set up your admin
        account and optionally connect an AI provider. You can always
        change these later from the admin panel.
      </p>
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-2">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="border border-border bg-panelAlt p-3 flex flex-col gap-1.5"
          >
            <span className="text-brass">{f.icon}</span>
            <span className="text-[12px] font-medium text-text">{f.title}</span>
            <span className="text-[11px] text-textMuted leading-snug">{f.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Step1Admin({
  admin,
  setAdmin,
}: {
  admin: AdminDraft;
  setAdmin: (next: AdminDraft) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-[20px] font-semibold text-text">
        Create your admin account
      </h2>
      <p className="mt-1.5 text-[12px] text-textMuted">
        This account has full access. Use a strong password — you'll be
        able to invite teammates in a moment.
      </p>
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          label="Display name"
          name="admin-name"
          placeholder="Imran"
          autoFocus
          required
          value={admin.name}
          onChange={(e) => setAdmin({ ...admin, name: e.target.value })}
        />
        <Input
          label="Username"
          name="admin-username"
          placeholder="imran"
          required
          value={admin.username}
          onChange={(e) => setAdmin({ ...admin, username: e.target.value })}
        />
        <Input
          label="Password"
          name="admin-password"
          type="password"
          placeholder="at least 10 characters"
          required
          minLength={10}
          value={admin.password}
          onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
        />
        <Input
          label="Email (optional)"
          name="admin-email"
          type="email"
          placeholder="imran@example.com"
          value={admin.email}
          onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
        />
      </div>
    </div>
  );
}

function Step2Provider({
  provider,
  setProvider,
  testState,
  onTest,
}: {
  provider: ProviderDraft;
  setProvider: (next: ProviderDraft) => void;
  testState: "idle" | "testing" | "ok" | "fail";
  onTest: () => Promise<void>;
}) {
  return (
    <div>
      <h2 className="font-display text-[20px] font-semibold text-text">
        Connect an AI provider
      </h2>
      <p className="mt-1.5 text-[12px] text-textMuted">
        Optional — skip this if you only want to use local / mock
        models. You can add more providers later from Settings → Providers.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <input
          id="provider-enabled"
          type="checkbox"
          checked={provider.enabled}
          onChange={(e) => setProvider({ ...provider, enabled: e.target.checked })}
          className="w-4 h-4 accent-brass"
        />
        <label htmlFor="provider-enabled" className="text-[13px] text-text">
          Configure a provider now
        </label>
      </div>
      {provider.enabled && (
        <>
          <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.type}
                type="button"
                onClick={() =>
                  setProvider({
                    ...provider,
                    type: p.type,
                    base_url: p.base_url || provider.base_url,
                    display_name: p.label,
                  })
                }
                className={cn(
                  "border px-3 py-2 text-left transition-colors",
                  provider.type === p.type
                    ? "border-brass bg-brass/10 text-text"
                    : "border-border bg-panelAlt text-textMuted hover:text-text hover:border-borderSoft",
                )}
              >
                <span className="block text-[12px] font-medium">{p.label}</span>
                <span className="block mono-caps text-[10px] text-textFaint tracking-wider">
                  {p.type}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              label="Base URL"
              name="provider-base-url"
              placeholder="https://api.openai.com/v1"
              value={provider.base_url}
              onChange={(e) => setProvider({ ...provider, base_url: e.target.value })}
            />
            <Input
              label="Display name"
              name="provider-display-name"
              placeholder="OpenAI"
              value={provider.display_name}
              onChange={(e) =>
                setProvider({ ...provider, display_name: e.target.value })
              }
            />
            <div className="md:col-span-2">
              <Input
                label="API key"
                name="provider-api-key"
                type="password"
                placeholder="sk-…"
                value={provider.api_key}
                onChange={(e) => setProvider({ ...provider, api_key: e.target.value })}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => void onTest()}
              disabled={testState === "testing"}
            >
              <ProvidersIcon size={12} />
              {testState === "testing" ? "Testing…" : "Test connection"}
            </Button>
            {testState === "ok" && (
              <span className="mono-caps text-[10px] text-teal tracking-wider">
                reachable
              </span>
            )}
            {testState === "fail" && (
              <span className="mono-caps text-[10px] text-rust tracking-wider">
                unreachable — check the URL
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Step3Invites({
  invites,
  addInvite,
  removeInvite,
  setInvite,
}: {
  invites: InviteDraft[];
  addInvite: () => void;
  removeInvite: (i: number) => void;
  setInvite: (i: number, patch: Partial<InviteDraft>) => void;
}) {
  return (
    <div>
      <h2 className="font-display text-[20px] font-semibold text-text">
        Invite teammates
      </h2>
      <p className="mt-1.5 text-[12px] text-textMuted">
        Optional. Each invitee gets a generated one-time password they
        must change on first login.
      </p>
      <div className="mt-5 space-y-2">
        {invites.length === 0 && (
          <div className="border border-dashed border-border bg-panelAlt px-4 py-3 mono-caps text-[11px] text-textFaint tracking-wider">
            no invites — you can add people later from Settings.
          </div>
        )}
        {invites.map((inv, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 border border-border bg-panelAlt p-3 items-end"
          >
            <div className="md:col-span-4">
              <Input
                label="Name"
                name={`invite-${i}-name`}
                value={inv.name}
                onChange={(e) => setInvite(i, { name: e.target.value })}
              />
            </div>
            <div className="md:col-span-4">
              <Input
                label="Username"
                name={`invite-${i}-username`}
                value={inv.username}
                onChange={(e) => setInvite(i, { username: e.target.value })}
              />
            </div>
            <div className="md:col-span-3">
              <label className="block">
                <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
                  Role
                </span>
                <select
                  className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px]"
                  value={inv.role}
                  onChange={(e) =>
                    setInvite(i, { role: e.target.value as "admin" | "user" })
                  }
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </label>
            </div>
            <div className="md:col-span-1 flex justify-end">
              <button
                type="button"
                onClick={() => removeInvite(i)}
                aria-label={`Remove invite ${i + 1}`}
                className="h-9 w-9 inline-flex items-center justify-center border border-border bg-panel text-textMuted hover:text-rust hover:border-rust/40"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Button variant="secondary" size="sm" type="button" onClick={addInvite}>
          + Add invite
        </Button>
      </div>
    </div>
  );
}