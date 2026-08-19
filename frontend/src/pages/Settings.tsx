// Settings — per docs §2.10.
//   - Account tab (everyone): quota + budget bars, change-password form
//   - Users tab (admin): CRUD, deactivate, reset password
//   - Logs tab (admin): step-up gated activity + sessions
// We use the same mono-caps sub-nav pattern as Workspace.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeProvider";
import { apiGet, apiPost, apiDelete, apiPatch, apiPut } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { Avatar } from "../components/ui/Avatar";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import {
  XIcon,
  ClockIcon,
  ActivityIcon,
  ZapIcon,
  KeyIcon,
  SearchIcon,
  RefreshIcon,
  UserIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

type Tab = "account" | "users" | "logs" | "websearch";

export function SettingsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("account");
  const tabs: Tab[] =
    user?.role === "admin"
      ? ["account", "users", "websearch", "logs"]
      : ["account"];
  return (
    <div className="p-6 max-w-[900px]">
      <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
        Settings
      </h2>
      <div className="text-textMuted text-[13px] mb-4">
        Account, {user?.role === "admin" ? "users, and audit logs." : "password, and quota."}
      </div>
      <div className="flex items-center gap-4 border-b border-border mb-6">
        {tabs.map((t) => (
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
      {tab === "account" && <AccountTab />}
      {tab === "users" && user?.role === "admin" && <UsersTab />}
      {tab === "logs" && user?.role === "admin" && <LogsTab />}
      {tab === "websearch" && user?.role === "admin" && <WebSearchAdminTab />}
    </div>
  );
}

function AccountTab() {
  const { user, refresh } = useAuth();
  const { theme, setTheme } = useTheme();
  const [quota, setQuota] = useState<{ message_limit: number | null; period: string }>({
    message_limit: null,
    period: "month",
  });
  const [budget, setBudget] = useState<{ dollar_limit: string | null; period: string }>({
    dollar_limit: null,
    period: "month",
  });
  useEffect(() => {
    apiGet<{ message_limit: number | null; period: string }>("/governance/me/quotas").then(setQuota);
    apiGet<{ dollar_limit: string | null; period: string }>("/governance/me/budgets").then(setBudget);
  }, []);

  return (
    <div className="space-y-6">
      <Panel title="Identity">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" value={user?.name ?? ""} />
          <Field label="Username" value={user?.username ?? ""} />
          <Field label="Role" value={user?.role ?? ""} />
          <Field
            label="Theme"
            value={theme === "light" ? "light" : "dark"}
          />
        </div>
      </Panel>

      <Panel title="Appearance">
        <div className="flex items-center gap-2">
          <span className="mono-caps text-[10px] text-textMuted">theme</span>
          <div className="flex border border-border">
            <button
              onClick={() => setTheme("light")}
              className={`px-3 h-8 mono-caps text-[10px] flex items-center gap-1.5 ${
                theme === "light"
                  ? "bg-brass text-bg"
                  : "bg-bg text-textMuted hover:text-text"
              }`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
              light
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`px-3 h-8 mono-caps text-[10px] flex items-center gap-1.5 border-l border-border ${
                theme === "dark"
                  ? "bg-brass text-bg"
                  : "bg-bg text-textMuted hover:text-text"
              }`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
              dark
            </button>
          </div>
        </div>
        <div className="mt-2 mono-caps text-[10px] text-textFaint">
          preference is stored locally in your browser
        </div>
      </Panel>

      <Panel title="Quota">
        <div className="flex items-center gap-3">
          <Badge tone={quota.message_limit ? "brass" : "teal"}>
            {quota.message_limit ? `${quota.message_limit} / ${quota.period}` : "unlimited"}
          </Badge>
        </div>
      </Panel>

      <Panel title="Budget">
        <Badge tone={budget.dollar_limit ? "brass" : "teal"}>
          {budget.dollar_limit ? `$${budget.dollar_limit} / ${budget.period}` : "unlimited"}
        </Badge>
      </Panel>

      <PreferencesPanel />

      <ChangePasswordForm onChanged={refresh} />
    </div>
  );
}

function ChangePasswordForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<null | { kind: "ok" | "err"; text: string }>(null);

  async function submit() {
    setMsg(null);
    if (next !== confirm) {
      setMsg({ kind: "err", text: "new passwords don't match" });
      return;
    }
    if (next.length < 10) {
      setMsg({ kind: "err", text: "new password must be ≥ 10 chars" });
      return;
    }
    try {
      await apiPost("/change-password", { current, next });
      setMsg({ kind: "ok", text: "password changed" });
      setCurrent("");
      setNext("");
      setConfirm("");
      await onChanged();
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    }
  }

  return (
    <Panel title="Change password">
      <div className="grid grid-cols-3 gap-2">
        <Input
          name="cp-current"
          label="Current"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Input
          name="cp-next"
          label="New"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint="≥ 10 chars"
        />
        <Input
          name="cp-confirm"
          label="Confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={!current || !next || !confirm}>
          Save
        </Button>
        {msg && (
          <span className={`mono-caps text-[10px] ${msg.kind === "ok" ? "text-teal" : "text-rust"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </Panel>
  );
}

interface UserRow {
  id: string;
  name: string;
  username: string;
  role: "admin" | "user";
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
}

function UsersTab() {
  const { user } = useAuth();
  const [list, setList] = useState<UserRow[]>([]);
  const reload = () => apiGet<UserRow[]>("/users").then(setList);
  useEffect(() => {
    reload();
  }, []);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editRole, setEditRole] = useState<"user" | "admin">("user");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<string, { message_limit: number | null; period: string }>>({});
  const [budgets, setBudgets] = useState<Record<string, { dollar_limit: string | null; period: string }>>({});
  const [quotaEditingId, setQuotaEditingId] = useState<string | null>(null);
  const [quotaLimit, setQuotaLimit] = useState("");
  const [quotaPeriod, setQuotaPeriod] = useState<"day" | "week" | "month">("month");
  const [budgetEditingId, setBudgetEditingId] = useState<string | null>(null);
  const [budgetLimit, setBudgetLimit] = useState("");
  const [budgetPeriod, setBudgetPeriod] = useState<"day" | "week" | "month">("month");

  async function loadGovernance() {
    const qEntries = await Promise.all(
      list.map(async (u) => {
        try {
          const r = await apiGet<{ message_limit: number | null; period: string }>(
            `/governance/quotas/${u.id}`,
          );
          return [u.id, r] as const;
        } catch {
          return [u.id, { message_limit: null, period: "month" }] as const;
        }
      }),
    );
    setQuotas(Object.fromEntries(qEntries));
    const bEntries = await Promise.all(
      list.map(async (u) => {
        try {
          const r = await apiGet<{ dollar_limit: string | null; period: string }>(
            `/governance/budgets/${u.id}`,
          );
          return [u.id, r] as const;
        } catch {
          return [u.id, { dollar_limit: null, period: "month" }] as const;
        }
      }),
    );
    setBudgets(Object.fromEntries(bEntries));
  }
  useEffect(() => {
    if (list.length > 0) loadGovernance();
  }, [list.length]);

  async function create() {
    setError(null);
    setGenerated(null);
    setSuccess(null);
    try {
      const res = await apiPost<{
        generated_password: string;
        id: string;
        username: string;
      }>("/users", {
        name,
        username,
        // Backend always generates a one-time password — sharing it
        // out-of-band is the supported provisioning flow.
        role,
      });
      setSuccess(`Created ${res.username}.`);
      setGenerated(res.generated_password);
      setName("");
      setUsername("");
      setRole("user");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleActive(u: UserRow) {
    setSuccess(null);
    await apiPost(`/users/${u.id}/${u.is_active ? "deactivate" : "reactivate"}`);
    setSuccess(`${u.username} ${u.is_active ? "deactivated" : "reactivated"}`);
    reload();
  }

  async function reset(u: UserRow) {
    setSuccess(null);
    const res = await apiPost<{ generated_password: string }>(
      `/users/${u.id}/reset-password`,
    );
    setGenerated(res.generated_password);
    setSuccess(`Reset ${u.username}. New password (shown once): ${res.generated_password}`);
    reload();
  }

  async function startEdit(u: UserRow) {
    setEditingId(u.id);
    setEditName(u.name);
    setEditUsername(u.username);
    setEditRole(u.role);
    setSuccess(null);
  }

  async function saveEdit() {
    if (!editingId) return;
    setError(null);
    try {
      await apiPatch(`/users/${editingId}`, {
        name: editName,
        username: editUsername,
        role: editRole,
      });
      setSuccess("Saved.");
      setEditingId(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveQuota(u: UserRow) {
    setError(null);
    try {
      await apiPost(`/governance/quotas/${u.id}`, {
        message_limit: quotaLimit.trim() === "" ? null : Number(quotaLimit),
        period: quotaPeriod,
      });
      setSuccess(`Quota updated for ${u.username}.`);
      setQuotaEditingId(null);
      setQuotaLimit("");
      loadGovernance();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveBudget(u: UserRow) {
    setError(null);
    try {
      await apiPost(`/governance/budgets/${u.id}`, {
        dollar_limit: budgetLimit.trim() === "" ? null : Number(budgetLimit),
        period: budgetPeriod,
      });
      setSuccess(`Budget updated for ${u.username}.`);
      setBudgetEditingId(null);
      setBudgetLimit("");
      loadGovernance();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function del(u: UserRow) {
    if (confirmDeleteId !== u.id) {
      setConfirmDeleteId(u.id);
      setError(null);
      setSuccess(null);
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      await apiDelete(`/users/${u.id}`);
      setSuccess(`Deleted ${u.username}.`);
      setConfirmDeleteId(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
      setConfirmDeleteId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Create user">
        <div className="grid grid-cols-3 gap-2">
          <Input name="new-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            name="new-username"
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label className="block">
            <span className="block mono-caps text-[10px] text-textMuted mb-1">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px]"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" onClick={create} disabled={!name || !username}>
            Create
          </Button>
          <span className="mono-caps text-[10px] text-textFaint">
            one-time password generated automatically · share out-of-band
          </span>
          {error && (
            <Badge tone="rust">{error}</Badge>
          )}
          {success && !generated && (
            <Badge tone="teal">{success}</Badge>
          )}
        </div>
        {generated && (
          <div className="mt-3 border border-brass/40 bg-brass/5 px-3 py-2 flex items-center justify-between gap-3">
            <div>
              <div className="mono-caps text-[10px] text-brass">
                One-time password — share with the user, then close.
              </div>
              <div className="font-mono text-[15px] text-text mt-1 select-all">
                {generated}
              </div>
            </div>
            <button
              className="mono-caps text-[10px] text-textMuted hover:text-text border border-border px-2 h-7"
              onClick={() => {
                navigator.clipboard?.writeText(generated);
                setSuccess("Copied to clipboard.");
              }}
            >
              copy
            </button>
          </div>
        )}
      </Panel>

      <Panel title={`Accounts (${list.length})`}>
        <div className="divide-y divide-borderSoft">
          {list.map((u) => {
            const isEditing = editingId === u.id;
            const isSelf = u.username === user?.username;
            const q = quotas[u.id] ?? { message_limit: null, period: "month" };
            const b = budgets[u.id] ?? { dollar_limit: null, period: "month" };
            return (
              <div key={u.id} className="py-2.5 px-2 space-y-1">
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-2">
                      <Input name={`edit-name-${u.id}`} label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
                      <Input name={`edit-username-${u.id}`} label="Username" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} />
                      <label className="block">
                        <span className="block mono-caps text-[10px] text-textMuted mb-1">Role</span>
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value as "user" | "admin")}
                          disabled={isSelf && u.role === "admin"}
                          className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px] disabled:opacity-50"
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                        </select>
                      </label>
                      <div className="flex items-end gap-2">
                        <Button size="sm" onClick={saveEdit} disabled={!editName || !editUsername}>
                          Save
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <CallSign id={`USR-${u.id.slice(0, 4).toUpperCase()}`} />
                      <div className="flex-1">
                        <div className="font-mono text-[13px] text-text">
                          {u.name} <span className="text-textMuted">({u.username})</span>
                          {isSelf && <Badge tone="brass">you</Badge>}
                        </div>
                        <div className="mono-caps text-[10px] text-textMuted">
                          {u.role} · {u.is_active ? "active" : "disabled"} ·{" "}
                          {u.must_change_password ? "must change pw" : "pw set"}
                        </div>
                      </div>
                      <Button size="sm" onClick={() => startEdit(u)}>Edit</Button>
                      <Button size="sm" onClick={() => reset(u)}>Reset pw</Button>
                      <Button
                        variant={u.is_active ? "danger" : "secondary"}
                        size="sm"
                        onClick={() => toggleActive(u)}
                      >
                        {u.is_active ? "Deactivate" : "Reactivate"}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => del(u)}
                        disabled={isSelf}
                      >
                        {confirmDeleteId === u.id ? "Confirm?" : "Delete"}
                      </Button>
                      {confirmDeleteId === u.id && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                    {/* AI quota + budget row */}
                    <div className="grid grid-cols-2 gap-2 pl-7">
                      {quotaEditingId === u.id ? (
                        <div className="col-span-2 border border-border bg-panelAlt p-2 flex items-center gap-2">
                          <span className="mono-caps text-[10px] text-textMuted">quota:</span>
                          <input
                            type="number"
                            min={0}
                            placeholder="unlimited"
                            value={quotaLimit}
                            onChange={(e) => setQuotaLimit(e.target.value)}
                            className="w-24 h-7 bg-bg border border-border text-text px-2 font-mono text-[12px]"
                          />
                          <span className="mono-caps text-[10px] text-textMuted">msgs /</span>
                          <select
                            value={quotaPeriod}
                            onChange={(e) => setQuotaPeriod(e.target.value as "day" | "week" | "month")}
                            className="h-7 bg-bg border border-border text-text px-2 font-mono text-[12px]"
                          >
                            <option value="day">day</option>
                            <option value="week">week</option>
                            <option value="month">month</option>
                          </select>
                          <Button size="sm" onClick={() => saveQuota(u)}>Save</Button>
                          <Button variant="secondary" size="sm" onClick={() => setQuotaEditingId(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="mono-caps text-[10px] text-textMuted w-16">quota:</span>
                          <span className="font-mono text-[12px] text-text">
                            {q.message_limit === null ? "unlimited" : `${q.message_limit} msgs / ${q.period}`}
                          </span>
                          <button
                            className="mono-caps text-[10px] text-textMuted hover:text-brass"
                            onClick={() => {
                              setQuotaEditingId(u.id);
                              setQuotaLimit(q.message_limit === null ? "" : String(q.message_limit));
                              setQuotaPeriod(q.period as "day" | "week" | "month");
                            }}
                          >
                            edit
                          </button>
                        </div>
                      )}
                      {budgetEditingId === u.id ? (
                        <div className="col-span-2 border border-border bg-panelAlt p-2 flex items-center gap-2">
                          <span className="mono-caps text-[10px] text-textMuted">budget:</span>
                          <span className="mono-caps text-[10px] text-textMuted">$</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="unlimited"
                            value={budgetLimit}
                            onChange={(e) => setBudgetLimit(e.target.value)}
                            className="w-28 h-7 bg-bg border border-border text-text px-2 font-mono text-[12px]"
                          />
                          <span className="mono-caps text-[10px] text-textMuted">/</span>
                          <select
                            value={budgetPeriod}
                            onChange={(e) => setBudgetPeriod(e.target.value as "day" | "week" | "month")}
                            className="h-7 bg-bg border border-border text-text px-2 font-mono text-[12px]"
                          >
                            <option value="day">day</option>
                            <option value="week">week</option>
                            <option value="month">month</option>
                          </select>
                          <Button size="sm" onClick={() => saveBudget(u)}>Save</Button>
                          <Button variant="secondary" size="sm" onClick={() => setBudgetEditingId(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="mono-caps text-[10px] text-textMuted w-16">budget:</span>
                          <span className="font-mono text-[12px] text-text">
                            {b.dollar_limit === null ? "unlimited" : `$${b.dollar_limit} / ${b.period}`}
                          </span>
                          <button
                            className="mono-caps text-[10px] text-textMuted hover:text-brass"
                            onClick={() => {
                              setBudgetEditingId(u.id);
                              setBudgetLimit(b.dollar_limit ?? "");
                              setBudgetPeriod(b.period as "day" | "week" | "month");
                            }}
                          >
                            edit
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}

function LogsTab() {
  const [stepUp, setStepUp] = useState(false);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"activity" | "sessions">("activity");
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [sessions, setSessions] = useState<SessionResponse | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [offset, setOffset] = useState(0);

  async function doStepUp() {
    setError(null);
    try {
      await apiPost("/logs/step-up", { password: pw });
      setStepUp(true);
      setPw("");
      setOffset(0);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function load() {
    const limit = tab === "activity" ? PAGE_SIZE_ACTIVITY : PAGE_SIZE_SESSIONS;
    if (tab === "activity") {
      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (actionFilter) qs.set("action", actionFilter);
      const data = await apiGet<ActivityResponse>(`/logs/activity?${qs}`);
      setActivity(data);
    } else {
      const qs = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      const data = await apiGet<SessionResponse>(`/logs/sessions?${qs}`);
      setSessions(data);
    }
  }

  useEffect(() => {
    if (stepUp) load();
  }, [stepUp, tab, actionFilter, offset]);

  if (!stepUp) {
    return (
      <Panel title="Step-up authentication required">
        <div className="text-textMuted text-[13px] mb-3">
          Re-enter your password to view audit logs. Required by docs §2.7.
        </div>
        <div className="flex gap-2 items-end max-w-md">
          <Input
            name="step-up-pw"
            label="Admin password"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
          <Button variant="primary" onClick={doStepUp} disabled={!pw}>
            Unlock
          </Button>
        </div>
        {error && (
          <div className="mt-2 mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
            {error}
          </div>
        )}
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 border-b border-border">
        {(["activity", "sessions"] as const).map((t) => (
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
      {tab === "activity" && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono-caps text-[10px] text-textMuted">filter:</span>
          {actionFilter && (
            <button
              type="button"
              onClick={() => {
                setActionFilter("");
                setOffset(0);
              }}
              className="inline-flex items-center gap-1.5 mono-caps text-[10px] text-brass border border-brass/40 bg-brass/10 px-2 h-7"
              title="Remove filter"
            >
              <span className="font-mono normal-case">{actionFilter}</span>
              <XIcon size={10} />
            </button>
          )}
          <input
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setOffset(0);
            }}
            placeholder="filter action (e.g. login_success, chat_…)"
            className="h-7 bg-panelAlt border border-border text-text px-2 font-mono text-[12px] flex-1 max-w-md"
          />
        </div>
      )}
      <Panel title={tab === "activity" ? "Activity" : "Sessions"}>
        {tab === "activity" ? (
          <ActivityTable rows={activity?.rows ?? []} />
        ) : (
          <SessionsTable rows={sessions?.rows ?? []} />
        )}
      </Panel>
      {tab === "activity" && activity && (
        <Pagination
          offset={activity.offset}
          limit={activity.limit}
          total={activity.total}
          onChange={setOffset}
        />
      )}
      {tab === "sessions" && sessions && (
        <Pagination
          offset={sessions.offset}
          limit={sessions.limit}
          total={sessions.total}
          onChange={setOffset}
        />
      )}
    </div>
  );
}

interface ActivityRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  target: string;
  action: string;
  tokens: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface ActivityResponse {
  rows: ActivityRow[];
  total: number;
  limit: number;
  offset: number;
}

interface SessionResponse {
  rows: SessionRow[];
  total: number;
  limit: number;
  offset: number;
}

function ActionTone({ action }: { action: string }) {
  if (action.startsWith("access_granted") || action.endsWith("_success")) return "teal";
  if (action.startsWith("access_denied") || action.includes("failed")) return "rust";
  if (action.startsWith("password_reset") || action.startsWith("password_changed")) return "brass";
  if (action.startsWith("user_deleted") || action.startsWith("user_deactivated")) return "rust";
  if (action.startsWith("sandbox_") || action.startsWith("knowledge_")) return "neutral";
  return "neutral";
}

function ActionBadge({ action }: { action: string }) {
  const tone = ActionTone({ action });
  return <Badge tone={tone as "teal" | "rust" | "brass" | "neutral"}>{action}</Badge>;
}

function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        variant="ledger"
        title="No activity on this page"
        description="Adjust the filter or change the page to see more events."
        tone="neutral"
      />
    );
  }
  return (
    <ol className="relative">
      {/* Vertical timeline rail */}
      <span className="absolute left-[15px] top-2 bottom-2 w-px bg-border" aria-hidden />
      {rows.map((r) => (
        <TimelineRow key={r.id} row={r} />
      ))}
    </ol>
  );
}

function TimelineRow({ row }: { row: ActivityRow }) {
  return (
    <li className="relative pl-9 pr-2 py-2.5 group">
      {/* Dot on the rail */}
      <span
        className={cn(
          "absolute left-2 top-4 w-3 h-3 rounded-full border-2 bg-bg",
          toneRing(row.action),
        )}
        aria-hidden
      />
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {row.user_name ? (
              <span className="inline-flex items-center gap-1.5">
                <Avatar name={row.user_name} size={18} />
                <span className="text-[13px] text-text font-medium">
                  {row.user_name}
                </span>
              </span>
            ) : (
              <span className="text-[13px] text-textFaint">system</span>
            )}
            <ActionBadge action={row.action} />
            <span className="font-mono text-[11px] text-textMuted truncate">
              {humanise(row.action)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap mono-caps text-[10px] text-textFaint tracking-wider">
            <span className="inline-flex items-center gap-1">
              <ClockIcon size={9} />
              {relativeTime(row.created_at)}
            </span>
            {row.tokens > 0 && (
              <span className="inline-flex items-center gap-1">
                <ZapIcon size={9} />
                {row.tokens.toLocaleString()} tok
              </span>
            )}
            {row.target && row.target !== "auth" && (
              <span className="font-mono normal-case tracking-normal text-textMuted truncate">
                {shortTarget(row.target)}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function toneRing(action: string): string {
  if (action.endsWith("_success") || action === "user_created") return "border-teal";
  if (action.endsWith("_failed") || action.includes("denied") || action.startsWith("user_")) return "border-rust";
  if (action.startsWith("password_") || action.startsWith("access_granted") || action.startsWith("access_requested")) return "border-brass";
  return "border-border";
}

function humanise(action: string): string {
  return action.replace(/_/g, " ");
}

function shortTarget(target: string): string {
  if (target.length <= 24) return target;
  return target.slice(0, 12) + "…" + target.slice(-8);
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

const PAGE_SIZE_ACTIVITY = 25;
const PAGE_SIZE_SESSIONS = 15;

function Pagination({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (next: number) => void;
}) {
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  const prev = Math.max(0, offset - limit);
  const next = Math.min((totalPages - 1) * limit, offset + limit);
  return (
    <div className="flex items-center gap-3 mt-3 px-1">
      <span className="mono-caps text-[10px] text-textMuted">
        {start}–{end} of {total}
      </span>
      <span className="mono-caps text-[10px] text-textFaint">
        page {page} of {totalPages}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(prev)}
        >
          ← Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={offset + limit >= total}
          onClick={() => onChange(next)}
        >
          Next →
        </Button>
      </div>
    </div>
  );
}

interface SessionRow {
  id: string;
  user_id: string;
  user_name: string;
  user_username: string;
  login_at: string;
  logout_at: string | null;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  sections_visited: string[];
}

function SessionsTable({ rows }: { rows: SessionRow[] }) {
  if (rows.length === 0) {
    return <div className="p-6 mono-caps text-[11px] text-textFaint text-center">no sessions</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border text-left">
            <Th>login</Th>
            <Th>last seen</Th>
            <Th>user</Th>
            <Th>status</Th>
            <Th>ip</Th>
            <Th>user agent</Th>
            <Th>sections visited</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-borderSoft hover:bg-panelAlt/40">
              <Td>
                <span className="font-mono text-text">{new Date(r.login_at).toLocaleString()}</span>
              </Td>
              <Td>
                <span className="font-mono text-textMuted">
                  {new Date(r.last_seen_at).toLocaleString()}
                </span>
              </Td>
              <Td>
                <span className="font-mono text-text">{r.user_name}</span>
                <span className="text-textFaint ml-1">@{r.user_username}</span>
              </Td>
              <Td>
                {r.logout_at ? (
                  <Badge tone="neutral">ended</Badge>
                ) : (
                  <Badge tone="teal">active</Badge>
                )}
              </Td>
              <Td>
                <span className="font-mono text-textMuted">{r.ip ?? "—"}</span>
              </Td>
              <Td>
                <span className="font-mono text-textMuted text-[11px]">
                  {r.user_agent ? r.user_agent.slice(0, 60) + (r.user_agent.length > 60 ? "…" : "") : "—"}
                </span>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {r.sections_visited.length === 0 ? (
                    <span className="text-textFaint">—</span>
                  ) : (
                    r.sections_visited.map((s) => (
                      <span
                        key={s}
                        className="mono-caps text-[10px] px-1.5 py-0.5 border border-borderSoft text-textMuted"
                      >
                        {s}
                      </span>
                    ))
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`mono-caps text-[10px] text-textMuted font-normal py-2 px-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td className={`py-2 px-2 align-top ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </td>
  );
}

function Metadata({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return <span className="text-textFaint">—</span>;
  return (
    <details className="text-[11px]">
      <summary className="mono-caps text-textMuted cursor-pointer hover:text-text">
        {entries.length} field{entries.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-1 bg-panelAlt border border-borderSoft p-2 font-mono text-textMuted">
        {entries.map(([k, v]) => (
          <div key={k}>
            <span className="text-brass">{k}</span>
            <span className="text-textMuted"> = </span>
            <span className="text-text">
              {typeof v === "string" ? `"${v}"` : JSON.stringify(v)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

// ─── Tier 6 — Preferences panel ────────────────────────────────────────────
//
// Shows the user's learned preferences (preferred models + disliked
// phrases) and lets them manually override the list. Edits write to
// /api/feedback/profile (PUT) so the preference learner won't overwrite
// them on the next nightly recompute.
interface PreferenceProfile {
  preferences: {
    preferred_models?: string[];
    model_scores?: Record<string, number>;
    dislikes?: string[];
    sample_size?: number;
    last_computed_at?: string;
    manual_overrides?: boolean;
  };
  updated_at: string | null;
}

function PreferencesPanel() {
  const [profile, setProfile] = useState<PreferenceProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [preferredText, setPreferredText] = useState("");
  const [dislikesText, setDislikesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<null | { kind: "ok" | "err"; text: string }>(null);

  async function load() {
    try {
      const p = await apiGet<PreferenceProfile>("/feedback/profile");
      setProfile(p);
      setPreferredText((p.preferences.preferred_models ?? []).join("\n"));
      setDislikesText((p.preferences.dislikes ?? []).join(", "));
    } catch {
      /* silent */
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const preferred_models = preferredText
        .split(/\n+/g)
        .map((s) => s.trim())
        .filter(Boolean);
      const dislikes = dislikesText
        .split(/,+/g)
        .map((s) => s.trim())
        .filter(Boolean);
      await apiPut("/feedback/profile", { preferred_models, dislikes });
      setMsg({ kind: "ok", text: "preferences saved" });
      setEditing(false);
      await load();
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const prefs = profile?.preferences;
  const preferredModels = prefs?.preferred_models ?? [];
  const dislikes = prefs?.dislikes ?? [];
  const sampleSize = prefs?.sample_size ?? 0;
  const hasSignal = sampleSize > 0;

  return (
    <Panel title="Your preferences">
      <div className="space-y-3">
        <p className="text-[12px] text-textMuted">
          The preference learner derives these from your last 30 days of
          thumbs feedback. You can override them at any time — your edits
          stick until you remove them.
        </p>
        {!hasSignal && !editing && (
          <div className="text-[12px] text-textFaint">
            Not enough feedback yet — rate a few assistant replies (thumb up
            / down) and the learner will start building this list.
          </div>
        )}
        {hasSignal && !editing && (
          <div className="space-y-3">
            <div>
              <div className="mono-caps text-[10px] text-textMuted mb-1 flex items-center gap-1">
                <ThumbsUpIcon size={10} className="text-teal" />
                preferred models
              </div>
              {preferredModels.length === 0 ? (
                <div className="text-[12px] text-textFaint">
                  none yet — keep rating
                </div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {preferredModels.map((m) => (
                    <li
                      key={m}
                      className="inline-flex items-center gap-1 mono-caps text-[10px] text-teal border border-teal/40 bg-teal/10 px-1.5 h-[18px]"
                    >
                      <ThumbsUpIcon size={9} />
                      {m}
                      {prefs?.model_scores?.[m] !== undefined && (
                        <span className="text-textFaint tabular-nums">
                          · {(prefs.model_scores[m]! * 100).toFixed(0)}%
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mono-caps text-[10px] text-textMuted mb-1 flex items-center gap-1">
                <ThumbsDownIcon size={10} className="text-rust" />
                learned dislikes
              </div>
              {dislikes.length === 0 ? (
                <div className="text-[12px] text-textFaint">none</div>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {dislikes.map((d) => (
                    <li
                      key={d}
                      className="inline-flex items-center mono-caps text-[10px] text-rust border border-rust/40 bg-rust/10 px-1.5 h-[18px]"
                    >
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mono-caps text-[10px] text-textFaint">
              {sampleSize} vote{sampleSize === 1 ? "" : "s"} considered · last
              recompute{" "}
              {prefs?.last_computed_at
                ? new Date(prefs.last_computed_at).toLocaleString()
                : "—"}
              {prefs?.manual_overrides && (
                <span className="ml-2 text-brass">· manual override on</span>
              )}
            </div>
          </div>
        )}
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mono-caps text-[10px] tracking-wider px-2 h-7 border border-borderSoft text-textMuted hover:text-brass hover:border-brass"
          >
            edit
          </button>
        ) : (
          <div className="space-y-2 pt-1">
            <div>
              <div className="mono-caps text-[10px] text-textMuted mb-1">
                preferred models (one external_id per line)
              </div>
              <textarea
                rows={3}
                value={preferredText}
                onChange={(e) => setPreferredText(e.target.value)}
                placeholder="gpt-4o&#10;claude-sonnet-4"
                className="w-full bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] outline-none focus:border-brass resize-none"
              />
            </div>
            <div>
              <div className="mono-caps text-[10px] text-textMuted mb-1">
                dislikes (comma-separated phrases)
              </div>
              <Input
                value={dislikesText}
                onChange={(e) => setDislikesText(e.target.value)}
                placeholder="emoji, code blocks, long preamble"
                className="w-full py-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={saving}
              >
                {saving ? "saving…" : "save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setPreferredText((profile?.preferences.preferred_models ?? []).join("\n"));
                  setDislikesText((profile?.preferences.dislikes ?? []).join(", "));
                }}
              >
                cancel
              </Button>
            </div>
          </div>
        )}
        {msg && (
          <div
            className={cn(
              "mono-caps text-[10px] tracking-wider px-2 py-1 border",
              msg.kind === "ok"
                ? "border-teal/40 text-teal bg-teal/10"
                : "border-rust/40 text-rust bg-rust/10",
            )}
          >
            {msg.text}
          </div>
        )}
      </div>
    </Panel>
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono-caps text-[10px] text-textMuted">{label}</div>
      <div className="font-mono text-[13px] text-text">{value}</div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Web search admin config (Settings → websearch)
// ----------------------------------------------------------------------

interface WebSearchKey {
  service: string;
  connected: boolean;
  api_key_masked: string;
  added_at: string;
  last_used_at: string | null;
}

function WebSearchAdminTab() {
  const [keys, setKeys] = useState<WebSearchKey[]>([]);
  const [selected, setSelected] = useState<
    "tavily" | "brave" | "serpapi" | "duckduckgo" | "lightpanda"
  >("lightpanda");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<{ providers: Array<{ service: string; connected: boolean }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reload = () => {
    apiGet<{ keys: WebSearchKey[] }>("/web-search/config").then((d) => setKeys(d.keys));
    apiGet<typeof status>("/web-search/status").then(setStatus).catch(() => {});
  };
  useEffect(() => {
    reload();
  }, []);

  async function save() {
    setError(null);
    setSuccess(null);
    try {
      const body: { api_key?: string; base_url?: string } = {};
      if (selected === "lightpanda") body.base_url = baseUrl.trim();
      else if (selected !== "duckduckgo") body.api_key = apiKey.trim();
      const res = await apiPut<{ ok: boolean }>(
        `/web-search/config/${selected}`,
        body,
      );
      setApiKey("");
      setBaseUrl("");
      setSuccess(`Saved ${selected} provider.`);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(service: string) {
    if (!confirm(`Remove the ${service} search key?`)) return;
    await apiDelete(`/web-search/config/${service}`);
    reload();
  }

  const activeProvider = keys.find((k) => k.connected);

  return (
    <div className="space-y-4">
      <Panel title="Active provider">
        <div className="flex items-center gap-3">
          {activeProvider ? (
            <>
              <Badge tone={activeProvider.service === "lightpanda" ? "brass" : "teal"}>
                {activeProvider.service}
                {activeProvider.service === "lightpanda" ? " · auto" : ""}
              </Badge>
              <span className="mono-caps text-[10px] text-textMuted">
                added {new Date(activeProvider.added_at).toLocaleString()} · last used{" "}
                {activeProvider.last_used_at ? new Date(activeProvider.last_used_at).toLocaleString() : "never"}
              </span>
            </>
          ) : status?.providers.length === 0 ? (
            <Badge tone="rust">none configured</Badge>
          ) : (
            <span className="mono-caps text-[10px] text-textMuted">loading…</span>
          )}
        </div>
        <div className="mt-2 mono-caps text-[10px] text-textFaint">
          The system uses the first connected provider in insertion order.
        </div>
      </Panel>

      <Panel title="Set a search provider">
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="block mono-caps text-[10px] text-textMuted mb-1">Provider</span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value as "tavily" | "brave" | "serpapi" | "duckduckgo" | "lightpanda")}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 font-mono text-[13px]"
            >
              <option value="lightpanda">lightpanda · local browser (free)</option>
              <option value="duckduckgo">wikipedia · keyless fallback (free)</option>
              <option value="brave">brave · 2k free/mo then $3 CPM</option>
              <option value="tavily">tavily · paid</option>
              <option value="serpapi">serpapi · paid</option>
            </select>
          </label>
          {selected === "lightpanda" ? (
            <div className="col-span-2">
              <Input
                name="lightpanda-base-url"
                label="Lightpanda base URL"
                placeholder="http://localhost:9222"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                hint="docker run -d -p 9222:9222 lightpanda/browser:nightly"
              />
            </div>
          ) : selected === "duckduckgo" ? (
            <div className="col-span-2 mono-caps text-[10px] text-textMuted self-end pb-2">
              no key required · falls back to Wikipedia when nothing else is configured
            </div>
          ) : (
            <div className="col-span-2">
              <Input
                name={`${selected}-api-key`}
                label={`${selected} API key`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                hint="encrypted at rest with AES-256-GCM · never returned in plaintext"
              />
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="primary"
            onClick={save}
            disabled={
              selected === "duckduckgo" ? false : (
                selected === "lightpanda" ? !baseUrl.trim() : !apiKey.trim()
              )
            }
          >
            Save provider
          </Button>
          {success && <Badge tone="teal">{success}</Badge>}
          {error && <Badge tone="rust">{error}</Badge>}
        </div>
        <div className="mt-3 mono-caps text-[10px] text-textFaint">
          Recommended: <span className="text-brass">lightpanda</span> (self-host) for orgs,{" "}
          <span className="text-brass">wikipedia</span> (free fallback) for quickstart.
          Paid APIs (tavily/brave/serpapi) only if you need a much higher rate limit.
        </div>
      </Panel>

      <Panel title="Configured keys">
        {keys.length === 0 ? (
          <div className="mono-caps text-[11px] text-textFaint">no keys yet</div>
        ) : (
          keys.map((k) => (
            <div
              key={k.service}
              className="flex items-center justify-between py-2 border-b border-borderSoft last:border-b-0"
            >
              <div>
                <div className="font-mono text-[13px] text-text">{k.service}</div>
                <div className="mono-caps text-[10px] text-textMuted">
                  {k.connected ? "configured" : "removed"} · {new Date(k.added_at).toLocaleDateString()}
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={() => remove(k.service)}>
                Remove
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}