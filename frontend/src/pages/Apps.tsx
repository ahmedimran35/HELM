// Apps (P7, docs §qm-parity).
//
// A single, role-aware gallery that serves both audiences on one route:
//
//   - Every logged-in user sees every enabled app as a tile, can search,
//     install (for self), uninstall, and "open" the running app via
//     `/apps-embed?slug=X&install=Y`. Installed apps show a teal
//     "installed" badge.
//
//   - Admins additionally see a "+ New app" button + inline create form,
//     and per-card Edit / Delete actions. Clicking a card opens a side
//     panel that lists installs across all panels + users, with a form
//     to install for any panel or user.
//
// Backend endpoints used:
//   GET    /api/apps                 — list (returns admin-shape for
//                                      admins, user-shape for users)
//   POST   /api/apps                 — admin: create
//   PATCH  /api/apps/:id             — admin: update
//   DELETE /api/apps/:id             — admin: delete
//   GET    /api/apps/:slug/installs  — list installs (admins see all;
//                                      users see their own)
//   POST   /api/apps/:slug/install   — install (admin: any target,
//                                      user: only self)
//   DELETE /api/app-installs/:id     — uninstall (admin or owner)

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { CallSign } from "../components/ui/CallSign";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import { AppPreviewIllustration } from "../components/ui/illustration";
import {
  PlusIcon,
  XIcon,
  TrashIcon,
  EditIcon,
  PlayIcon,
  DownloadIcon,
  SearchIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

// ─── shared types ────────────────────────────────────────────────────

interface AppBase {
  id: string;
  slug: string;
  name: string;
  description: string;
  bundle_url: string | null;
  routes: unknown;
  data_sources: unknown;
  permissions: unknown;
  version: string;
  enabled: boolean;
  install_count: number;
}

// Admin shape includes audit fields.
interface AdminApp extends AppBase {
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// User shape includes the install row that gives the user access
// (null when the user hasn't installed the app).
interface UserApp extends AppBase {
  user_install_id: string | null;
  user_install_scope: "user" | "panel" | null;
  user_install_label: string | null;
}

type AppRow = AdminApp | UserApp;

function isAdminApp(a: AppRow): a is AdminApp {
  return (a as AdminApp).created_at !== undefined;
}

interface AppInstall {
  id: string;
  app_id: string;
  panel_id: string | null;
  user_id: string | null;
  panel_name: string | null;
  user_name: string | null;
  user_username: string | null;
  granted_scopes: string[];
  installed_by: string | null;
  installed_by_name: string | null;
  installed_at: string;
}

interface PanelSummary {
  id: string;
  name: string;
}

interface UserSummary {
  id: string;
  name: string;
  username: string;
  role: "admin" | "user";
  is_active: boolean;
}

// ─── page shell ──────────────────────────────────────────────────────

export function AppsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const reload = () => {
    setApps(null);
    apiGet<AppRow[]>("/apps")
      .then(setApps)
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    if (!apps) return [];
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) =>
      [a.name, a.slug, a.description].join(" ").toLowerCase().includes(q),
    );
  }, [apps, query]);

  return (
    <div className="p-6 max-w-[1180px] space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
            Apps
          </h2>
          <div className="text-textMuted text-[13px] max-w-[60ch]">
            Internal mini-apps. {isAdmin
              ? "Create apps here, install them for panels or users, and copy the bundle URL when you’re ready to ship the frontend."
              : "Browse the catalogue, install the ones you want, and open them from the gallery."}
          </div>
        </div>
        {isAdmin && <AdminCreateButton onCreated={reload} />}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textFaint pointer-events-none">
            <SearchIcon size={14} />
          </span>
          <input
            name="apps-search"
            placeholder="Search apps by name, slug, or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-9 bg-panelAlt border border-border text-text pl-8 pr-3 rounded-none font-mono text-[13px] placeholder:text-textFaint focus:border-brass"
          />
        </div>
        {apps && (
          <span className="mono-caps text-[10px] text-textFaint shrink-0">
            {filtered.length} of {apps.length}
          </span>
        )}
      </div>

      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {error}
        </div>
      )}

      {apps === null ? (
        <SkeletonGrid />
      ) : apps.length === 0 ? (
        <EmptyState
          variant="gear"
          title="No apps yet"
          description={
            isAdmin
              ? "Create your first app — it gets a public URL at /apps/:slug and you can install it for panels or users. Three demo apps (standup, notes, inbox) get seeded automatically on first boot."
              : "There are no apps available yet. Ask an admin to install one."
          }
          tone="brass"
          action={
            isAdmin ? (
              <AdminCreateButton inline onCreated={reload} />
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <div className="p-6 text-center mono-caps text-[11px] text-textFaint border border-borderSoft">
          no apps match “{query}”
        </div>
      ) : (
        <AppGallery
          apps={filtered}
          isAdmin={isAdmin}
          currentUserId={user?.id ?? ""}
          onChanged={reload}
        />
      )}
    </div>
  );
}

// ─── admin "new app" button (header + inline empty-state action) ────

function AdminCreateButton({
  inline = false,
  onCreated,
}: {
  inline?: boolean;
  /** Called after an app is successfully created so the parent can
   *  re-fetch the app list. Using a callback (vs `window.location.reload`)
   *  avoids the brief blank flash the reload causes on slower pages. */
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(inline);
  const formRef = useRef<HTMLDivElement | null>(null);

  // When the inline variant mounts, immediately open the form. Otherwise
  // it's a toggle button.
  useEffect(() => {
    if (inline) setOpen(true);
  }, [inline]);

  // Scroll the freshly-opened form into view so the admin sees it
  // appear (otherwise it's hidden above the fold when there are
  // already many app cards on the page).
  useEffect(() => {
    if (open && formRef.current) {
      // Defer one frame so the form is mounted first.
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }, [open]);

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <PlusIcon size={12} /> New app
      </Button>
    );
  }

  return (
    <div ref={formRef}>
      <NewAppForm
        onCancel={inline ? undefined : () => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          // Re-fetch the list so the new app shows up without a page
          // reload. Fall back to a hard reload only if no callback was
          // provided (e.g. inline empty-state usage).
          if (onCreated) onCreated();
          else window.location.reload();
        }}
      />
    </div>
  );
}

// ─── gallery grid ────────────────────────────────────────────────────

function AppGallery({
  apps,
  isAdmin,
  currentUserId,
  onChanged,
}: {
  apps: AppRow[];
  isAdmin: boolean;
  currentUserId: string;
  onChanged: () => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {apps.map((a) => (
        <AppTile
          key={a.id}
          app={a}
          isAdmin={isAdmin}
          currentUserId={currentUserId}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function AppTile({
  app,
  isAdmin,
  currentUserId,
  onChanged,
}: {
  app: AppRow;
  isAdmin: boolean;
  currentUserId: string;
  onChanged: () => void;
}) {
  const installed = !isAdmin && (app as UserApp).user_install_id !== null;
  const installId = !isAdmin
    ? (app as UserApp).user_install_id ?? null
    : null;
  const installScope = !isAdmin
    ? (app as UserApp).user_install_scope ?? null
    : null;
  const installLabel = !isAdmin
    ? (app as UserApp).user_install_label ?? null
    : null;

  return (
    <div className="border border-border bg-panel flex flex-col hover:border-borderSoft transition-colors">
      <div className="p-4 flex gap-3">
        <AppPreviewIllustration
          variant={variantForSlug(app.slug)}
          className="text-brass shrink-0 opacity-90"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <CallSign id={`APP-${app.slug.slice(0, 4).toUpperCase()}`} />
            <span className="font-display text-[14px] font-semibold text-text truncate">
              {app.name}
            </span>
          </div>
          <div className="mono-caps text-[10px] text-textFaint mt-1 truncate">
            v{app.version} · /{app.slug}
            {!app.enabled && " · disabled"}
          </div>
          <p className="text-textMuted text-[12px] leading-[1.45] line-clamp-3 mt-1.5">
            {app.description || (
              <span className="text-textFaint">no description</span>
            )}
          </p>
        </div>
      </div>
      <div className="px-4 py-2 border-t border-borderSoft flex items-center gap-2 justify-between">
        <div className="flex items-center gap-2 mono-caps text-[10px] text-textMuted">
          {installed && installId && (
            <Badge tone="teal">installed</Badge>
          )}
          {!isAdmin && !installed && app.enabled && (
            <Badge tone="neutral">available</Badge>
          )}
          <span>
            {app.install_count} install{app.install_count === 1 ? "" : "s"}
          </span>
        </div>
        <TileActions
          app={app}
          isAdmin={isAdmin}
          installed={installed}
          installId={installId}
          installScope={installScope}
          installLabel={installLabel}
          onChanged={onChanged}
          currentUserId={currentUserId}
        />
      </div>
      {isAdmin && (
        <AdminRow app={app as AdminApp} onChanged={onChanged} />
      )}
    </div>
  );
}

function TileActions({
  app,
  isAdmin,
  installed,
  installId,
  installScope,
  installLabel,
  onChanged,
  currentUserId,
}: {
  app: AppRow;
  isAdmin: boolean;
  installed: boolean;
  installId: string | null;
  installScope: "user" | "panel" | null;
  installLabel: string | null;
  onChanged: () => void;
  currentUserId: string;
}) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function install() {
    setBusy(true);
    try {
      const r = await apiPost<{ id: string; already_installed?: boolean }>(
        `/apps/${app.slug}/install`,
        // Non-admin installs are always for self. Admins picking this
        // quick-install button also install for themselves.
        { user_id: currentUserId },
      );
      addToast({
        id: `app-install-${r.id}-${Date.now()}`,
        title: r.already_installed ? "Already installed" : "Installed",
        description: app.name,
        tone: r.already_installed ? "info" : "success",
        duration: 2500,
      });
      onChanged();
      return r.id;
    } catch (err) {
      addToast({
        id: `app-install-err-${Date.now()}`,
        title: "Install failed",
        description: (err as Error).message,
        tone: "warning",
      });
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Admin "Open" — install for self first so the app receives an
  // install id, then open with it. Without an install id the app falls
  // back to "no install context" and refuses to run.
  async function openWithInstall() {
    if (busy) return;
    const id = await install();
    if (id) openApp(app.slug, id, app.bundle_url);
  }

  async function uninstall() {
    if (!installId) return;
    let label: string;
    if (installScope === "panel" && installLabel) {
      label = `panel · ${installLabel}`;
    } else if (installScope === "user" && installLabel) {
      label = `@${installLabel}`;
    } else {
      label = app.name;
    }
    if (!confirm(`Uninstall ${app.name} from ${label}? Per-install data will be removed.`)) {
      return;
    }
    setBusy(true);
    try {
      await apiDelete(`/app-installs/${installId}`);
      addToast({
        id: `app-uninstall-${installId}`,
        title: "Uninstalled",
        description: app.name,
        tone: "warning",
        duration: 2500,
      });
      onChanged();
    } catch (err) {
      addToast({
        id: `app-uninstall-err-${Date.now()}`,
        title: "Uninstall failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  // User role: install / open / uninstall.
  if (!isAdmin) {
    if (!app.enabled) {
      return (
        <span className="mono-caps text-[10px] text-textFaint">disabled</span>
      );
    }
    if (installed && installId) {
      return (
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            onClick={() => openApp(app.slug, installId, app.bundle_url)}
            title="Open the running app"
          >
            <PlayIcon size={11} /> Open
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={uninstall}
            disabled={busy}
            title="Uninstall"
          >
            uninstall
          </Button>
        </div>
      );
    }
    return (
      <Button
        variant="primary"
        size="sm"
        onClick={install}
        disabled={busy}
        title="Install this app for yourself"
      >
        <DownloadIcon size={11} />
        {busy ? "…" : "Install"}
      </Button>
    );
  }

  // Admin: an "open" link that installs for self first, then opens with
  // the install id. The bulk install UI (for other users/panels) lives
  // in the side panel installs manager.
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={openWithInstall}
      disabled={busy}
      title="Install for yourself and open the app"
    >
      <PlayIcon size={11} />
      {busy ? "…" : "Open"}
    </Button>
  );
}

function AdminRow({
  app,
  onChanged,
}: {
  app: AdminApp;
  onChanged: () => void;
}) {
  const { addToast } = useToast();
  const [showInstalls, setShowInstalls] = useState(false);
  const [editing, setEditing] = useState(false);

  async function toggleEnabled() {
    try {
      await apiPatch(`/apps/${app.id}`, { enabled: !app.enabled });
      addToast({
        id: `app-toggle-${app.id}-${Date.now()}`,
        title: app.enabled ? "App disabled" : "App enabled",
        tone: "info",
        duration: 2000,
      });
      onChanged();
    } catch (err) {
      addToast({
        id: `app-toggle-err-${Date.now()}`,
        title: "Update failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function remove() {
    if (
      !confirm(
        `Delete app "${app.name}"? Installs and per-install data will also be removed.`,
      )
    ) {
      return;
    }
    try {
      await apiDelete(`/apps/${app.id}`);
      addToast({
        id: `app-delete-${app.id}`,
        title: "App deleted",
        tone: "warning",
        duration: 2500,
      });
      onChanged();
    } catch (err) {
      addToast({
        id: `app-delete-err-${Date.now()}`,
        title: "Delete failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  return (
    <>
      <div className="border-t border-borderSoft px-4 py-2 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setShowInstalls(true)}
          className="mono-caps text-[10px] text-textMuted hover:text-brass"
        >
          installs ({app.install_count})
        </button>
        <span className="text-textFaint">·</span>
        <button
          onClick={toggleEnabled}
          className="mono-caps text-[10px] text-textMuted hover:text-brass"
        >
          {app.enabled ? "disable" : "enable"}
        </button>
        <span className="text-textFaint">·</span>
        <button
          onClick={() => setEditing(true)}
          className="mono-caps text-[10px] text-textMuted hover:text-brass inline-flex items-center gap-1"
        >
          <EditIcon size={11} /> edit
        </button>
        <span className="text-textFaint">·</span>
        <button
          onClick={remove}
          className="mono-caps text-[10px] text-textMuted hover:text-rust inline-flex items-center gap-1"
        >
          <TrashIcon size={11} /> delete
        </button>
        <span className="ml-auto mono-caps text-[10px] text-textFaint">
          {new Date(app.created_at).toLocaleDateString()}
        </span>
      </div>
      {showInstalls && (
        <AppInstallsPanel
          app={app}
          onClose={() => setShowInstalls(false)}
          onChanged={onChanged}
        />
      )}
      {editing && (
        <EditAppForm
          app={app}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ─── new app form ────────────────────────────────────────────────────

// Derive a kebab-case slug from a free-form name. "Daily Standup" →
// "daily-standup", "  Hello!! World  " → "hello-world". Used to keep
// the slug field in sync with whatever the admin types in the name box
// so they never have to hand-edit both.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function NewAppForm({
  onCancel,
  onCreated,
}: {
  onCancel?: () => void;
  onCreated: (created: { id: string; slug: string }) => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [bundleUrl, setBundleUrl] = useState("");
  /** Full bundle HTML returned by /generate. Forwarded on POST /api/apps
   *  so the backend writes the AI's actual code (not a placeholder). */
  const [aiHtml, setAiHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep the slug derived from the name until the user explicitly edits
  // the slug field. After that, respect their manual override.
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  async function generate() {
    if (!prompt.trim()) {
      setErr("describe what the app should do first");
      return;
    }
    setGenerating(true);
    setErr(null);
    try {
      const r = await apiPost<{
        name: string;
        slug: string;
        description: string;
        bundle_url: string;
        /** AI-generated full bundle HTML, or null if the model didn't
         *  produce one (we fall back to the placeholder). */
        html: string | null;
      }>("/apps/generate", { prompt: prompt.trim() });
      // Fill the form from the AI's output. Mark slug as touched so we
      // don't immediately overwrite the AI's choice while the admin
      // is still editing the name.
      setName(r.name);
      setSlug(r.slug);
      setSlugTouched(true);
      setDescription(r.description);
      setBundleUrl(r.bundle_url);
      setAiHtml(r.html);
      addToast({
        id: `apps-generate-${Date.now()}`,
        title: r.html ? "Bundle generated" : "Draft generated",
        description: r.html
          ? `${r.name} — full bundle ready, click Create to wire it up`
          : r.name,
        tone: r.html ? "success" : "info",
        duration: 2500,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function submit() {
    const finalSlug = slug.trim() || slugify(name);
    const finalName = name.trim();
    if (!finalSlug || !finalName) {
      setErr("name and slug are required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<{ id: string; slug: string }>("/apps", {
        slug: finalSlug,
        name: finalName,
        description: description.trim(),
        bundle_url: bundleUrl.trim() || null,
        // Forward the AI's full bundle so the backend writes the real
        // code instead of the placeholder. Null falls back to placeholder.
        html: aiHtml,
      });
      addToast({
        id: `apps-create-${r.id}`,
        title: "App created",
        description: aiHtml
          ? `${r.slug} — AI bundle wired up`
          : r.slug,
        tone: "success",
      });
      onCreated(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "border border-brass bg-panel p-4 space-y-3 w-full",
        onCancel ? "" : "mt-2",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="mono-caps text-[11px] text-brass">
          New app · describe it & we&apos;ll wire the rest
        </div>
        {onCancel && (
          <button onClick={onCancel} className="text-textMuted hover:text-text">
            <XIcon size={14} />
          </button>
        )}
      </div>

      {/* AI prompt box — the primary entry point. Fill this in and the
          backend will return a name/slug/description/bundle_url draft. */}
      <div>
        <div className="mono-caps text-[10px] text-textFaint mb-1">
          What should this app do?
        </div>
        <textarea
          name="new-app-prompt"
          rows={3}
          placeholder="e.g. A daily standup that reads my recent panel messages, drafts four sections (wins, yesterday, today, blockers) and lets me post the result back to a panel."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full bg-panelAlt border border-border text-text px-2.5 py-1.5 font-mono text-[12px] placeholder:text-textFaint focus:border-brass resize-y"
        />
        <div className="flex justify-end mt-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={generate}
            disabled={generating || busy}
          >
            {generating ? "drafting…" : "Generate draft"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          name="new-app-name"
          label="Name"
          placeholder="Daily Standup"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          name="new-app-slug"
          label="Slug (URL path)"
          placeholder="daily-standup"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
          hint={slugTouched ? "custom" : "auto from name"}
        />
      </div>
      <Input
        name="new-app-desc"
        label="Description"
        placeholder="Optional one-line summary"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input
        name="new-app-bundle"
        label="Bundle URL"
        placeholder="/apps/your-bundle/  or  https://cdn/your-bundle/"
        value={bundleUrl}
        onChange={(e) => setBundleUrl(e.target.value)}
        hint="filled by AI; edit if you host the bundle elsewhere"
      />
      {aiHtml && (
        <div
          className="mono-caps text-[11px] text-teal border border-teal/40 bg-teal/10 px-2 py-1.5"
          data-testid="ai-bundle-ready"
        >
          ✓ AI bundle ready ({Math.round(aiHtml.length / 1024)}KB) — will be written to
          <span className="ml-1 font-mono">
            apps-bundles/{slug || "…"}-app/index.html
          </span>
        </div>
      )}
      {err && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy || generating}>
            cancel
          </Button>
        )}
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || generating}
        >
          {busy ? "creating…" : "Create app"}
        </Button>
      </div>
    </div>
  );
}

// ─── edit app form (admin) ───────────────────────────────────────────

function EditAppForm({
  app,
  onCancel,
  onSaved,
}: {
  app: AdminApp;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [version, setVersion] = useState(app.version);
  const [bundleUrl, setBundleUrl] = useState(app.bundle_url ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await apiPatch(`/apps/${app.id}`, {
        name: name.trim(),
        description: description.trim(),
        version: version.trim() || app.version,
        bundle_url: bundleUrl.trim() ? bundleUrl.trim() : null,
      });
      addToast({
        id: `app-update-${app.id}`,
        title: "App updated",
        tone: "success",
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-borderSoft bg-bg/40 p-4 space-y-3">
      <div className="mono-caps text-[11px] text-brass">
        Edit {app.name}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input
          name="edit-app-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          name="edit-app-version"
          label="Version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
      </div>
      <Input
        name="edit-app-desc"
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input
        name="edit-app-bundle"
        label="Bundle URL"
        placeholder="/apps/your-bundle/  or  https://cdn/your-bundle/"
        value={bundleUrl}
        onChange={(e) => setBundleUrl(e.target.value)}
        hint={
          app.bundle_url
            ? `current: ${app.bundle_url}`
            : "leave blank to fall back to /apps/{slug}/"
        }
      />
      {err && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? "saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ─── installs side panel (admin only) ────────────────────────────────

function AppInstallsPanel({
  app,
  onClose,
  onChanged,
}: {
  app: AdminApp;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { addToast } = useToast();
  const [installs, setInstalls] = useState<AppInstall[]>([]);
  const [panels, setPanels] = useState<PanelSummary[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [kind, setKind] = useState<"panel" | "user">("panel");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    apiGet<AppInstall[]>(`/apps/${app.slug}/installs`)
      .then(setInstalls)
      .catch(() => setInstalls([]));
  };

  useEffect(() => {
    reload();
    apiGet<PanelSummary[]>("/panels").then(setPanels).catch(() => {});
    apiGet<UserSummary[]>("/users").then(setUsers).catch(() => {});
  }, [app.slug]);

  async function install() {
    if (!target) {
      setErr("pick a target");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body = kind === "panel" ? { panel_id: target } : { user_id: target };
      const r = await apiPost<{ id: string; already_installed?: boolean }>(
        `/apps/${app.slug}/install`,
        body,
      );
      addToast({
        id: `app-install-${r.id}-${Date.now()}`,
        title: r.already_installed ? "Already installed" : "Installed",
        tone: r.already_installed ? "info" : "success",
      });
      setTarget("");
      reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(i: AppInstall) {
    const label =
      i.panel_name ??
      (i.user_username ? `@${i.user_username}` : i.id.slice(0, 8));
    if (!confirm(`Uninstall from ${label}?`)) return;
    await apiDelete(`/app-installs/${i.id}`);
    addToast({
      id: `app-uninstall-${i.id}`,
      title: "Uninstalled",
      description: label,
      tone: "warning",
    });
    reload();
    onChanged();
  }

  const bundleUrl = `${window.location.origin}/apps/${app.slug}/`;

  return (
    <div className="border-t border-borderSoft bg-bg/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="mono-caps text-[11px] text-brass">
          installs · {installs.length}
        </div>
        <button onClick={onClose} className="text-textMuted hover:text-text">
          <XIcon size={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setKind("panel");
                setTarget("");
              }}
              className={cn(
                "mono-caps text-[10px] px-2 h-7 border",
                kind === "panel"
                  ? "bg-brass text-bg border-brass"
                  : "bg-bg text-textMuted border-border hover:text-text",
              )}
            >
              for panel
            </button>
            <button
              onClick={() => {
                setKind("user");
                setTarget("");
              }}
              className={cn(
                "mono-caps text-[10px] px-2 h-7 border",
                kind === "user"
                  ? "bg-brass text-bg border-brass"
                  : "bg-bg text-textMuted border-border hover:text-text",
              )}
            >
              for user
            </button>
          </div>
          <div className="flex items-center gap-2">
            {kind === "panel" ? (
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 bg-panelAlt border border-border text-text px-2 font-mono text-[12px] flex-1"
              >
                <option value="">— pick a panel —</option>
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 bg-panelAlt border border-border text-text px-2 font-mono text-[12px] flex-1"
              >
                <option value="">— pick a user —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} (@{u.username})
                    {u.is_active ? "" : " · inactive"}
                  </option>
                ))}
              </select>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={install}
              disabled={!target || busy}
            >
              {busy ? "…" : "install"}
            </Button>
          </div>
          {err && (
            <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
              {err}
            </div>
          )}

          {installs.length === 0 ? (
            <div className="mono-caps text-[10px] text-textFaint py-3 text-center border border-borderSoft">
              no installs yet
            </div>
          ) : (
            <ul className="space-y-1 max-h-[260px] overflow-auto">
              {installs.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center gap-2 bg-panelAlt border border-border px-2 py-1.5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-text truncate">
                      {i.panel_name
                        ? `panel · ${i.panel_name}`
                        : i.user_username
                          ? `user · @${i.user_username}`
                          : i.id.slice(0, 8)}
                    </div>
                    <div className="mono-caps text-[9px] text-textFaint truncate">
                      {new Date(i.installed_at).toLocaleString()}
                      {i.installed_by_name ? ` · by ${i.installed_by_name}` : ""}
                    </div>
                  </div>
                  <a
                    href={`/apps-embed?slug=${app.slug}&install=${i.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mono-caps text-[10px] text-brass hover:underline shrink-0"
                    title="Open app"
                  >
                    open
                  </a>
                  <button
                    className="text-textMuted hover:text-rust p-0.5"
                    onClick={() => uninstall(i)}
                    aria-label="Uninstall"
                  >
                    <XIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <div>
            <div className="mono-caps text-[10px] text-textMuted mb-1">
              Bundle URL
            </div>
            <div className="bg-panelAlt border border-border px-2.5 py-2 mono-caps text-[11px] text-text break-all">
              {bundleUrl}
            </div>
            <div className="mono-caps text-[10px] text-textFaint mt-1.5 leading-relaxed">
              drop an <code className="text-text">index.html</code> (and any
              other assets) under{" "}
              <code className="text-text">apps-bundles/{app.slug}/</code> on the
              server. auth happens inside the bundle via the data API.
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <div>
              <div className="mono-caps text-[10px] text-textFaint">routes</div>
              <div className="font-mono text-text">
                {Array.isArray(app.routes)
                  ? (app.routes as unknown[]).length
                  : 0}
              </div>
            </div>
            <div>
              <div className="mono-caps text-[10px] text-textFaint">data</div>
              <div className="font-mono text-text">
                {Array.isArray(app.data_sources)
                  ? (app.data_sources as unknown[]).length
                  : 0}
              </div>
            </div>
            <div>
              <div className="mono-caps text-[10px] text-textFaint">scopes</div>
              <div className="font-mono text-text">
                {Array.isArray(app.permissions)
                  ? (app.permissions as unknown[]).length
                  : 0}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="border border-border bg-panel h-[150px] animate-pulse"
        />
      ))}
    </div>
  );
}

function variantForSlug(slug: string) {
  if (slug === "standup") return "standup" as const;
  if (slug === "notes") return "notes" as const;
  if (slug === "inbox") return "inbox" as const;
  return "default" as const;
}

function openApp(slug: string, installId: string | null, bundleUrl?: string | null) {
  // Pass the actual bundle URL through so the embed page points at the
  // right directory even when the app's slug doesn't match the bundle's
  // path (e.g. slug="standup", bundle_url="/apps/standup-app/").
  const params = new URLSearchParams();
  params.set("slug", slug);
  if (bundleUrl) params.set("bundle", bundleUrl);
  if (installId) params.set("install", installId);
  window.open(`/apps-embed?${params.toString()}`, "_blank", "noopener,noreferrer");
}

// Silence "unused" warning when isAdminApp isn't strictly needed at the
// call site — the type guard is exported for callers that branch on
// admin fields.
export { isAdminApp };
