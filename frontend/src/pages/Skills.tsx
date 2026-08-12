// Skills & Packs (admin only, docs §2.x — qm-parity P3).
//
// Two tabs:
//   - Skills: card grid of every skill in the org (filterable by name).
//     Each card has Edit / Delete buttons + a kind badge + a scope pill.
//     Inline "New Skill" form at the top of the tab.
//   - Packs: list of skill packs with their source / source_ref and an
//     "Import" button. Inline "New Pack" form at the top.
//
// Auth: the page itself is wrapped in <RequireAdmin> by App.tsx, so we
// don't need to gate on `user.role === "admin"` here — but we still
// short-circuit on the hook level for safety.

import { useEffect, useMemo, useState } from "react";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import { EditIcon, TrashIcon, PlusIcon } from "../components/ui/Icon";
import { Markdown } from "../components/ui/Markdown";
import { cn } from "../lib/cn";

type Tab = "skills" | "packs";
type SkillKind = "prompt" | "tool" | "workflow";
type SkillScope = "org" | "panel" | "user";
type PackSource = "git:url" | "local:path" | "inline";

interface Skill {
  id: string;
  pack_id: string | null;
  name: string;
  description: string;
  scope: SkillScope;
  owner_user_id: string | null;
  owner_panel_id: string | null;
  kind: SkillKind;
  tags: string[];
  version: string;
  available_to_user: boolean;
  created_at: string;
  updated_at: string;
}

// What the form submits. `body` isn't on the list endpoint (we fetch
// it per-skill) so we keep this as its own type rather than `Pick<Skill>`.
interface SkillFormValues {
  name: string;
  description: string;
  body: string;
  kind: SkillKind;
  scope: SkillScope;
}

interface Pack {
  id: string;
  name: string;
  source: PackSource;
  source_ref: string;
  description: string;
  version: string;
  enabled: boolean;
  skill_count: number;
  created_at: string;
  updated_at: string;
}

export function SkillsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("skills");
  if (user?.role !== "admin") {
    return (
      <div className="p-6">
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2 inline-block">
          403 · admin only
        </div>
      </div>
    );
  }
  return (
    <div className="p-6 max-w-[1080px]">
      <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
        Skills & Packs
      </h2>
      <div className="text-textMuted text-[13px] mb-4">
        Reusable agent behaviors. Skills scope into org / panel / user;
        packs bundle many skills and can be imported from a git repo.
      </div>
      <div className="flex items-center gap-4 border-b border-border mb-6">
        {(["skills", "packs"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "mono-caps text-[11px] py-2 -mb-px border-b-2 transition-colors",
              tab === t
                ? "text-text border-brass"
                : "text-textMuted border-transparent hover:text-text",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "skills" ? <SkillsTab /> : <PacksTab />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Skills tab
// ─────────────────────────────────────────────────────────────────────

function SkillsTab() {
  const { addToast } = useToast();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => {
    setSkills(null);
    apiGet<Skill[]>("/skills")
      .then(setSkills)
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    if (!skills) return [];
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      [s.name, s.description, ...(s.tags ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [skills, query]);

  async function createSkill(input: SkillFormValues) {
    try {
      await apiPost("/skills", input);
      setCreating(false);
      addToast({
        id: `skill-create-${Date.now()}`,
        title: "Skill created",
        tone: "success",
      });
      reload();
    } catch (err) {
      addToast({
        id: `skill-create-err-${Date.now()}`,
        title: "Create failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function saveSkill(
    id: string,
    patch: Partial<SkillFormValues>,
  ) {
    try {
      await apiPatch(`/skills/${id}`, patch);
      setEditing(null);
      addToast({
        id: `skill-update-${Date.now()}`,
        title: "Skill updated",
        tone: "success",
      });
      reload();
    } catch (err) {
      addToast({
        id: `skill-update-err-${Date.now()}`,
        title: "Update failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function removeSkill(s: Skill) {
    if (!confirm(`Delete skill "${s.name}"?`)) return;
    try {
      await apiDelete(`/skills/${s.id}`);
      addToast({
        id: `skill-delete-${Date.now()}`,
        title: "Skill deleted",
        tone: "info",
      });
      reload();
    } catch (err) {
      addToast({
        id: `skill-delete-err-${Date.now()}`,
        title: "Delete failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          name="skill-search"
          placeholder="Filter by name, description, or tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="md"
          onClick={() => setCreating((v) => !v)}
        >
          <PlusIcon size={12} />
          {creating ? "cancel" : "New Skill"}
        </Button>
      </div>

      {creating && (
        <NewSkillForm
          onCancel={() => setCreating(false)}
          onCreate={createSkill}
        />
      )}

      {editing && (
        <EditSkillForm
          skill={editing}
          onCancel={() => setEditing(null)}
          onSave={(patch) => saveSkill(editing.id, patch)}
        />
      )}

      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {error}
        </div>
      )}

      {skills === null ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="border border-border bg-panel h-[140px] animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        skills.length === 0 ? (
          <EmptyState
            variant="ledger"
            title="No skills yet"
            description="Click + New Skill to author one. Skills are markdown docs with optional YAML frontmatter — the agent reads them when the relevant behavior is invoked."
            tone="brass"
            action={
              <Button
                variant="primary"
                onClick={() => setCreating(true)}
              >
                Create your first skill
              </Button>
            }
          />
        ) : (
          <div className="p-6 text-center mono-caps text-[11px] text-textFaint border border-borderSoft">
            no skills match "{query}"
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              onEdit={() => setEditing(s)}
              onDelete={() => removeSkill(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="border border-border bg-panel p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-display text-[14px] font-semibold text-text truncate">
            {skill.name}
          </div>
          <div className="mono-caps text-[10px] text-textFaint mt-0.5 truncate">
            v{skill.version}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Badge
            tone={
              skill.kind === "tool"
                ? "teal"
                : skill.kind === "workflow"
                ? "brass"
                : "neutral"
            }
          >
            {skill.kind}
          </Badge>
          <Badge tone={skill.scope === "org" ? "brass" : "neutral"}>
            {skill.scope}
          </Badge>
        </div>
      </div>
      <p className="text-[12px] text-textMuted leading-[1.45] line-clamp-3">
        {skill.description || <span className="text-textFaint">no description</span>}
      </p>
      {skill.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skill.tags.map((t) => (
            <span
              key={t}
              className="mono-caps text-[9px] text-textMuted border border-borderSoft px-1.5 py-0.5"
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto pt-2 flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
          <EditIcon size={12} />
          Edit
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={onDelete}
          title="Delete"
        >
          <TrashIcon size={12} />
          Delete
        </Button>
      </div>
    </div>
  );
}

function NewSkillForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: SkillFormValues) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(
    "# New Skill\n\nDescribe what this skill does and when the agent should use it.\n",
  );
  const [kind, setKind] = useState<SkillKind>("prompt");
  const [scope, setScope] = useState<SkillScope>("org");
  const [busy, setBusy] = useState(false);

  return (
    <div className="border border-border bg-panel p-4 space-y-3">
      <div className="mono-caps text-[11px] text-textMuted">New Skill</div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          name="new-skill-name"
          label="Name"
          placeholder="e.g. PR Summary"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as SkillKind)}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-none font-mono text-[13px] focus:border-brass"
            >
              <option value="prompt">prompt</option>
              <option value="tool">tool</option>
              <option value="workflow">workflow</option>
            </select>
          </label>
          <label className="block">
            <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
              Scope
            </span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as SkillScope)}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-none font-mono text-[13px] focus:border-brass"
            >
              <option value="org">org</option>
              <option value="panel">panel</option>
              <option value="user">user</option>
            </select>
          </label>
        </div>
      </div>
      <Input
        name="new-skill-description"
        label="Description"
        placeholder="One sentence — when does the agent use this?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label className="block">
        <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
          Body (markdown)
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="w-full bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[12px] resize-y focus:border-brass"
        />
      </label>
      {body && (
        <details className="border border-borderSoft bg-bg">
          <summary className="px-3 py-1.5 cursor-pointer mono-caps text-[10px] text-textMuted">
            preview
          </summary>
          <div className="px-3 py-2 text-[13px]">
            <Markdown content={body} />
          </div>
        </details>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !name.trim() || !body.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onCreate({
                name: name.trim(),
                description: description.trim(),
                body,
                kind,
                scope,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "creating…" : "Create skill"}
        </Button>
      </div>
    </div>
  );
}

function EditSkillForm({
  skill,
  onCancel,
  onSave,
}: {
  skill: Skill;
  onCancel: () => void;
  onSave: (patch: Partial<SkillFormValues>) => Promise<void> | void;
}) {
  // We re-fetch the body via apiGet because the list endpoint doesn't
  // include it. Cheap and avoids a stale form on every edit.
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState<string>("");
  const [kind, setKind] = useState<SkillKind>(skill.kind);
  const [scope, setScope] = useState<SkillScope>(skill.scope);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ body: string }>(`/skills/${skill.id}`)
      .then((s) => {
        if (cancelled) return;
        setBody(s.body);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  return (
    <div className="border border-border bg-panel p-4 space-y-3">
      <div className="mono-caps text-[11px] text-textMuted">
        Edit Skill — {skill.name}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          name="edit-skill-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as SkillKind)}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-none font-mono text-[13px] focus:border-brass"
            >
              <option value="prompt">prompt</option>
              <option value="tool">tool</option>
              <option value="workflow">workflow</option>
            </select>
          </label>
          <label className="block">
            <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
              Scope
            </span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as SkillScope)}
              className="w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-none font-mono text-[13px] focus:border-brass"
            >
              <option value="org">org</option>
              <option value="panel">panel</option>
              <option value="user">user</option>
            </select>
          </label>
        </div>
      </div>
      <Input
        name="edit-skill-description"
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label className="block">
        <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
          Body (markdown)
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          disabled={!loaded}
          className="w-full bg-panelAlt border border-border text-text px-3 py-2 font-mono text-[12px] resize-y focus:border-brass disabled:opacity-50"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || !name.trim() || !body.trim() || !loaded}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({
                name: name.trim(),
                description: description.trim(),
                body,
                kind,
                scope,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Packs tab
// ─────────────────────────────────────────────────────────────────────

function PacksTab() {
  const { addToast } = useToast();
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => {
    setPacks(null);
    apiGet<Pack[]>("/skill-packs")
      .then(setPacks)
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => {
    reload();
  }, []);

  async function createPack(input: {
    name: string;
    source: PackSource;
    source_ref: string;
    description: string;
  }) {
    try {
      await apiPost("/skill-packs", input);
      setCreating(false);
      addToast({
        id: `pack-create-${Date.now()}`,
        title: "Pack created",
        tone: "success",
      });
      reload();
    } catch (err) {
      addToast({
        id: `pack-create-err-${Date.now()}`,
        title: "Create failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function importPack(p: Pack) {
    try {
      const res = await apiPost<{ imported: number }>(
        `/skill-packs/${p.id}/import`,
      );
      addToast({
        id: `pack-import-${Date.now()}`,
        title: `Imported ${res.imported} skill${res.imported === 1 ? "" : "s"}`,
        tone: "success",
      });
      reload();
    } catch (err) {
      addToast({
        id: `pack-import-err-${Date.now()}`,
        title: "Import failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          onClick={() => setCreating((v) => !v)}
        >
          <PlusIcon size={12} />
          {creating ? "cancel" : "New Pack"}
        </Button>
      </div>

      {creating && (
        <NewPackForm
          onCancel={() => setCreating(false)}
          onCreate={createPack}
        />
      )}

      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {error}
        </div>
      )}

      {packs === null ? (
        <div className="border border-border bg-panel h-[140px] animate-pulse" />
      ) : packs.length === 0 ? (
        <EmptyState
          variant="ledger"
          title="No skill packs"
          description="Add a pack to bundle many skills together. Inline packs are authored by hand; git:url packs clone a repo and ingest every *.md file as a skill."
          tone="brass"
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Add a pack
            </Button>
          }
        />
      ) : (
        <div className="border border-border bg-panel">
          <div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted">
            Packs ({packs.length})
          </div>
          {packs.map((p) => (
            <div
              key={p.id}
              className="px-4 py-3 border-b border-borderSoft last:border-b-0 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[13px] text-text truncate">
                  {p.name}
                </div>
                <div className="mono-caps text-[10px] text-textMuted truncate mt-0.5">
                  {p.source} · {p.source_ref} · v{p.version} · {p.skill_count}{" "}
                  skill{p.skill_count === 1 ? "" : "s"}
                </div>
                {p.description && (
                  <div className="text-[12px] text-textMuted mt-1 truncate">
                    {p.description}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => importPack(p)}
                disabled={p.source === "inline"}
                title={
                  p.source === "inline"
                    ? "Inline packs don't need importing"
                    : "Pull latest skills from source"
                }
              >
                Import
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewPackForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    source: PackSource;
    source_ref: string;
    description: string;
  }) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<PackSource>("git:url");
  const [sourceRef, setSourceRef] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="border border-border bg-panel p-4 space-y-3">
      <div className="mono-caps text-[11px] text-textMuted">New Pack</div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          name="new-pack-name"
          label="Name"
          placeholder="e.g. anthropic-skills"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="block">
          <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
            Source
          </span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as PackSource)}
            className="w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-none font-mono text-[13px] focus:border-brass"
          >
            <option value="git:url">git:url</option>
            <option value="local:path">local:path</option>
            <option value="inline">inline</option>
          </select>
        </label>
      </div>
      <Input
        name="new-pack-source-ref"
        label={
          source === "git:url"
            ? "Git URL"
            : source === "local:path"
            ? "Local path"
            : "Reference"
        }
        placeholder={
          source === "git:url"
            ? "https://github.com/owner/skills.git"
            : source === "local:path"
            ? "/Users/you/skills"
            : "inline"
        }
        value={sourceRef}
        onChange={(e) => setSourceRef(e.target.value)}
        disabled={source === "inline"}
        hint={
          source === "local:path"
            ? "Path is read as-is from disk. The api process must have permission to read it."
            : source === "git:url"
            ? "We shallow-clone into a tmp dir and ingest every *.md / *.markdown file."
            : undefined
        }
      />
      <Input
        name="new-pack-description"
        label="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button
          variant="primary"
          disabled={
            busy ||
            !name.trim() ||
            (source !== "inline" && !sourceRef.trim())
          }
          onClick={async () => {
            setBusy(true);
            try {
              await onCreate({
                name: name.trim(),
                source,
                source_ref:
                  source === "inline" ? "inline" : sourceRef.trim(),
                description: description.trim(),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "creating…" : "Create pack"}
        </Button>
      </div>
    </div>
  );
}
