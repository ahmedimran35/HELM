// Workspace — five tabs (docs §2.4): Memory, Files, Keychain, Crons,
// Posture. The Sandbox (code execution) is its own top-level page
// now (qm-parity P1). We use a single mono-caps sub-nav per the
// design system rather than nested sidebars.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { api, apiGet, apiPost, apiDelete } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

type Tab = "memory" | "files" | "keychain" | "crons" | "posture";

interface MemoryEntry {
  id: string;
  text: string;
  source_type: string;
  scope: "personal" | "team" | "admin";
  user_name: string | null;
  created_at: string;
}

interface Cron {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
}

interface PostureRow {
  tool_name: string;
  posture: "strict" | "auto";
}

interface KeychainGrant {
  id: string;
  credential_name: string;
  scope: string;
  value_masked: string;
}

interface FileRow {
  id: string;
  name: string;
  size: string;
  updated_at: string;
  sha256?: string;
  mime_type?: string;
}

export function WorkspacePage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("memory");
  const tabs: Tab[] = ["memory", "files", "keychain", "crons", "posture"];

  return (
    <div className="p-6 max-w-[920px]">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Workspace
        </h2>
      </div>
      <div className="text-textMuted text-[13px] mb-4">
        Scoped per {user?.name ?? "you"} — memory, files, keychain, crons, posture. Code execution lives in its own Sandbox page.
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

      {tab === "memory" && <MemoryTab />}
      {tab === "files" && <FilesTab />}
      {tab === "keychain" && <KeychainTab />}
      {tab === "crons" && <CronsTab />}
      {tab === "posture" && <PostureTab />}
    </div>
  );
}

function MemoryTab() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  // Three independent add inputs — one per scope — so the user can
  // write to all three without colliding.
  const [text, setText] = useState({ personal: "", team: "", admin: "" });
  const isAdmin = user?.role === "admin";

  const reload = () => apiGet<MemoryEntry[]>("/workspace/memory").then(setEntries);
  useEffect(() => {
    reload();
  }, []);

  async function add(scope: "personal" | "team" | "admin") {
    const t = text[scope].trim();
    if (!t) return;
    await apiPost("/workspace/memory", { text: t, scope, source_type: "manual" });
    setText({ ...text, [scope]: "" });
    reload();
  }
  async function del(id: string) {
    await apiDelete(`/workspace/memory/${id}`);
    reload();
  }

  // Bucket the entries so the UI can render three grouped sections
  // without the user having to manually filter.
  const personal = entries.filter((e) => e.scope === "personal");
  const team = entries.filter((e) => e.scope === "team");
  const admin = entries.filter((e) => e.scope === "admin");

  return (
    <div className="space-y-6">
      {/* Personal — only the owner sees these */}
      <MemorySection
        title="Your private notes"
        hint="Only you see these. Use for facts about you that the agent should always remember (e.g. timezone, role, project, preferences)."
        entries={personal}
        text={text.personal}
        onTextChange={(t) => setText({ ...text, personal: t })}
        onAdd={() => add("personal")}
        canDelete={(e) => true}
        onDelete={del}
        accent="brass"
        badgeLabel="personal"
      />
      {/* Team — shared between admin and all members */}
      <MemorySection
        title="Team-shared notes"
        hint="Visible to every member of the team. Use for project context, conventions, and links the agent should always know about."
        entries={team}
        text={text.team}
        onTextChange={(t) => setText({ ...text, team: t })}
        onAdd={() => add("team")}
        canDelete={(e) => isAdmin || e.user_name === user?.name}
        onDelete={del}
        accent="teal"
        badgeLabel="team"
      />
      {/* Admin-only — only admins see these. Non-admins don't see this section at all. */}
      {isAdmin && (
        <MemorySection
          title="Admin-only notes"
          hint="Visible only to admins. Use for billing exceptions, blocked providers, or anything sensitive that should never leak to regular users."
          entries={admin}
          text={text.admin}
          onTextChange={(t) => setText({ ...text, admin: t })}
          onAdd={() => add("admin")}
          canDelete={() => true}
          onDelete={del}
          accent="rust"
          badgeLabel="admin"
        />
      )}
    </div>
  );
}

function MemorySection({
  title,
  hint,
  entries,
  text,
  onTextChange,
  onAdd,
  canDelete,
  onDelete,
  accent,
  badgeLabel,
}: {
  title: string;
  hint: string;
  entries: MemoryEntry[];
  text: string;
  onTextChange: (t: string) => void;
  onAdd: () => void;
  canDelete: (e: MemoryEntry) => boolean;
  onDelete: (id: string) => void;
  accent: "brass" | "teal" | "rust";
  badgeLabel: string;
}) {
  return (
    <div className="border border-border bg-panel p-4">
      <div className="flex items-baseline justify-between mb-1">
        <div className="mono-caps text-[11px] text-text">{title}</div>
        <Badge tone={accent}>{badgeLabel}</Badge>
      </div>
      <div className="text-textMuted text-[12px] mb-3">{hint}</div>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={2}
        placeholder="add a note…"
        className="w-full bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[13px] resize-none focus:border-brass"
      />
      <div className="mt-2 flex justify-end">
        <Button variant="primary" onClick={onAdd} disabled={!text.trim()}>
          Save
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="mt-3 text-textMuted text-[12px] mono-caps">no entries yet</div>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((e) => (
            <div
              key={e.id}
              className="border border-borderSoft bg-panelAlt p-3 flex items-start gap-3"
            >
              <div className="flex-1 text-text text-[13px]">{e.text}</div>
              {e.user_name && (
                <div className="mono-caps text-[10px] text-textFaint">{e.user_name}</div>
              )}
              {canDelete(e) && (
                <button
                  onClick={() => onDelete(e.id)}
                  className="mono-caps text-[10px] text-textMuted hover:text-rust"
                >
                  delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilesTab() {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const reload = () => apiGet<FileRow[]>("/workspace/files").then(setRows);
  useEffect(() => {
    reload();
  }, []);
  async function onPick(file: File, displayName: string) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", displayName);
      try {
        await api("/workspace/files", {
          method: "POST",
          body: fd,
        });
      } catch (err) {
        alert(`upload failed: ${(err as Error).message}`);
      }
      reload();
    } finally {
      setUploading(false);
    }
  }
  async function del(id: string) {
    if (!confirm("Delete this file?")) return;
    await apiDelete(`/workspace/files/${id}`);
    reload();
  }
  function onDownload(id: string, name: string) {
    // Real round-trip: hit the download endpoint with the cookie.
    fetch(`/api/workspace/files/${id}/download`, { credentials: "include" })
      .then((r) => r.blob())
      .then((b) => {
        const url = URL.createObjectURL(b);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      });
  }
  return (
    <div className="space-y-3">
      <label className="block border border-border bg-panel p-4 cursor-pointer hover:bg-panelAlt/60 transition-colors">
        <div className="mono-caps text-[11px] text-textMuted mb-2">Upload a file</div>
        <input
          type="file"
          disabled={uploading}
          className="block text-[12px] text-text"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            onPick(f, f.name);
            e.target.value = "";
          }}
        />
        <div className="mt-2 mono-caps text-[10px] text-textFaint">
          bytes stored in Postgres · sha256 verified
        </div>
      </label>
      <div className="border border-border bg-panel">
        {rows.length === 0 ? (
          <div className="p-6 text-center mono-caps text-[11px] text-textFaint">no files yet</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="px-4 py-2 border-b border-borderSoft last:border-b-0 flex items-center gap-3">
              <span className="font-mono text-[13px] text-text flex-1 truncate">{r.name}</span>
              <span className="mono-caps text-[10px] text-textMuted">
                {Number(r.size).toLocaleString()} B
              </span>
              <button
                className="mono-caps text-[10px] text-textMuted hover:text-text"
                onClick={() => onDownload(r.id, r.name)}
              >
                download
              </button>
              <button
                className="mono-caps text-[10px] text-textMuted hover:text-rust"
                onClick={() => del(r.id)}
              >
                delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function KeychainTab() {
  const [rows, setRows] = useState<KeychainGrant[]>([]);
  useEffect(() => {
    apiGet<KeychainGrant[]>("/workspace/keychain").then(setRows);
  }, []);
  return (
    <div>
      <div className="mb-3 mono-caps text-[10px] text-textFaint">
        granted by admin · raw values never returned
      </div>
      {rows.length === 0 ? (
        <div className="mono-caps text-[11px] text-textFaint">no grants</div>
      ) : (
        rows.map((g) => (
          <div
            key={g.id}
            className="border border-border bg-panel p-3 mb-2 flex items-center justify-between"
          >
            <div>
              <div className="font-mono text-[13px] text-text">{g.credential_name}</div>
              <div className="mono-caps text-[10px] text-textMuted">scope: {g.scope || "—"}</div>
            </div>
            <span className="font-mono text-[13px] text-brass">{g.value_masked}</span>
          </div>
        ))
      )}
    </div>
  );
}

function CronsTab() {
  const [rows, setRows] = useState<Cron[]>([]);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = () => apiGet<Cron[]>("/workspace/crons").then(setRows);
  useEffect(() => {
    reload();
  }, []);
  async function add() {
    if (!name || !schedule) return;
    setError(null);
    try {
      await apiPost("/workspace/crons", { name, schedule });
      setName("");
      setSchedule("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <div className="border border-border bg-panel p-4 grid grid-cols-3 gap-2">
        <Input name="cron-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          name="cron-schedule"
          placeholder="0 9 * * 1-5"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
        />
        <Button variant="primary" onClick={add} disabled={!name || !schedule}>
          Schedule
        </Button>
      </div>
      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="border border-border bg-panel">
        {rows.length === 0 ? (
          <div className="p-6 text-center mono-caps text-[11px] text-textFaint">no crons</div>
        ) : (
          rows.map((c) => (
            <div
              key={c.id}
              className="px-4 py-2 border-b border-borderSoft last:border-b-0 flex items-center justify-between"
            >
              <div>
                <div className="font-mono text-[13px] text-text">{c.name}</div>
                <div className="mono-caps text-[10px] text-textMuted">
                  {c.schedule} · next{" "}
                  {c.next_run_at ? new Date(c.next_run_at).toLocaleString() : "—"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={c.enabled ? "teal" : "neutral"}>{c.enabled ? "on" : "off"}</Badge>
                <button
                  className="mono-caps text-[10px] text-textMuted hover:text-brass"
                  onClick={() => apiPost(`/workspace/crons/${c.id}/run`).then(reload)}
                >
                  run
                </button>
                <button
                  className="mono-caps text-[10px] text-textMuted hover:text-text"
                  onClick={() => apiPost(`/workspace/crons/${c.id}/toggle`).then(reload)}
                >
                  toggle
                </button>
                <button
                  className="mono-caps text-[10px] text-textMuted hover:text-rust"
                  onClick={() => apiDelete(`/workspace/crons/${c.id}`).then(reload)}
                >
                  delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PostureTab() {
  const [rows, setRows] = useState<PostureRow[]>([]);
  const reload = () => apiGet<PostureRow[]>("/workspace/posture").then(setRows);
  useEffect(() => {
    reload();
  }, []);
  async function set(tool: string, posture: "strict" | "auto") {
    await apiPost("/workspace/posture", { tool_name: tool, posture });
    reload();
  }
  return (
    <div>
      <div className="mb-3 mono-caps text-[10px] text-textFaint">
        strict = pause for approval every time · auto = classifier screens it
      </div>
      <div className="border border-border bg-panel">
        {rows.map((p) => (
          <div
            key={p.tool_name}
            className="px-4 py-2 border-b border-borderSoft last:border-b-0 flex items-center justify-between"
          >
            <span className="font-mono text-[13px] text-text">{p.tool_name}</span>
            <div className="flex gap-1">
              {(["auto", "strict"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => set(p.tool_name, mode)}
                  className={`mono-caps text-[10px] px-2 h-7 border ${
                    p.posture === mode
                      ? "bg-brass text-bg border-brass"
                      : "bg-bg text-textMuted border-border hover:text-text"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}