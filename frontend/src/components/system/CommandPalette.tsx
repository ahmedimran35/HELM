// CommandPalette — Cmd+K (Ctrl+K on win/linux) opens a modal palette that
// lets the user navigate to any page, jump to a model thread, open a
// panel, find a user, or run an in-app action.
//
// Architecture:
//   - One <CommandPalette /> is mounted near the root (in AppShell). It
//     owns the open state and listens for the keyboard shortcut.
//   - When open, it renders a portal at document.body with an
//     autocomplete-style list grouped by kind (page / model / panel /
//     user / action).
//   - The input is debounced (150ms) and fetches /api/search?q=… on
//     each non-empty change. Empty queries render the recent items
//     stored in localStorage.
//   - Keyboard: ↑/↓ to navigate, Enter to activate, Esc to close.
//     ⌘K and Ctrl+K toggle; clicking outside closes.
//
// We don't pull in a "command palette" library — the surface area is
// small and a custom implementation gives us full control over the
// visual treatment (which matches the rest of the chrome).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../../api/client";
import {
  SearchIcon,
  ArrowRightIcon,
  ChatIcon,
  PanelsIcon,
  WorkspaceIcon,
  AnalyticsIcon,
  SettingsIcon,
  ProvidersIcon,
  RequestsIcon,
  IntegrationsIcon,
  ZapIcon,
  MoonIcon,
  SunIcon,
  LogOutIcon,
  UserIcon,
  ModelIcon,
  CheckIcon,
  InfoIcon,
} from "../ui/Icon";
import { Avatar } from "../ui/Avatar";
import { cn } from "../../lib/cn";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/ThemeProvider";

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

interface CommandPaletteValue {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

const Ctx = createContext<CommandPaletteValue | null>(null);

export function useCommandPalette(): CommandPaletteValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  return ctx;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const value = useMemo<CommandPaletteValue>(
    () => ({ open, close, toggle, isOpen }),
    [open, close, toggle, isOpen],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(
            <CommandPalette isOpen={isOpen} onClose={close} />,
            document.body,
          )
        : null}
    </Ctx.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Result model + helpers
// ─────────────────────────────────────────────────────────────────────

type Kind = "page" | "model" | "panel" | "user" | "action";

interface Result {
  id: string;
  kind: Kind;
  title: string;
  subtitle?: string;
  path?: string | null;
  badge?: string;
}

const KIND_ICON: Record<Kind, typeof SearchIcon> = {
  page: ArrowRightIcon,
  model: ModelIcon,
  panel: PanelsIcon,
  user: UserIcon,
  action: ZapIcon,
};

const KIND_LABEL: Record<Kind, string> = {
  page: "Pages",
  model: "Models",
  panel: "Panels",
  user: "Users",
  action: "Actions",
};

function KindIcon({
  kind,
  className,
}: {
  kind: Kind;
  className?: string;
}) {
  const Icon = KIND_ICON[kind];
  return <Icon size={14} className={cn("text-textMuted", className)} />;
}

// Map a `kind:path` to a page icon for page-kind results.
function PageIcon({ path, className }: { path: string; className?: string }) {
  const I =
    path === "/chat" ? ChatIcon
      : path === "/panels" ? PanelsIcon
      : path === "/workspace" ? WorkspaceIcon
      : path === "/analytics" ? AnalyticsIcon
      : path === "/requests" ? RequestsIcon
      : path === "/providers" ? ProvidersIcon
      : path === "/integrations" ? IntegrationsIcon
      : path === "/settings" ? SettingsIcon
      : ArrowRightIcon;
  return <I size={14} className={cn("text-textMuted", className)} />;
}

// ─────────────────────────────────────────────────────────────────────
// Recents — localStorage-backed ring buffer of "what did the user open"
// ─────────────────────────────────────────────────────────────────────

const RECENTS_KEY = "helm.recents";
const RECENTS_MAX = 8;

function readRecents(): Result[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.title === "string" &&
        typeof r.kind === "string",
    );
  } catch {
    return [];
  }
}

function pushRecent(result: Result): void {
  if (typeof window === "undefined") return;
  if (result.kind === "action") return; // actions don't repeat
  const cur = readRecents().filter((r) => r.id !== result.id);
  cur.unshift(result);
  if (cur.length > RECENTS_MAX) cur.length = RECENTS_MAX;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(cur));
  } catch {
    /* private mode etc. */
  }
}

// ─────────────────────────────────────────────────────────────────────
// The palette itself
// ─────────────────────────────────────────────────────────────────────

function CommandPalette({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [recents, setRecents] = useState<Result[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset state on every open.
  useEffect(() => {
    if (!isOpen) return;
    setQ("");
    setActive(0);
    setResults([]);
    setRecents(readRecents());
    // Defer focus until after the portal mount.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Debounced fetch on query change.
  useEffect(() => {
    if (!isOpen) return;
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const data = await apiGet<{ results: Result[] }>(
          `/search?q=${encodeURIComponent(trimmed)}`,
        );
        setResults(data.results ?? []);
        setActive(0);
      } catch (err) {
        console.warn("search failed:", err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [q, isOpen]);

  // The active list (recents when empty, results otherwise).
  const list = q.trim().length === 0 ? recents : results;

  // Group by kind, preserving order.
  const grouped = useMemo(() => {
    const groups: Array<{ kind: Kind; items: Result[] }> = [];
    for (const r of list) {
      let g = groups.find((x) => x.kind === r.kind);
      if (!g) {
        g = { kind: r.kind, items: [] };
        groups.push(g);
      }
      g.items.push(r);
    }
    return groups;
  }, [list]);

  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  const activate = useCallback(
    (r: Result) => {
      // Action handling.
      if (r.id === "action:toggle-theme") {
        toggleTheme();
        onClose();
        return;
      }
      if (r.id === "action:sign-out") {
        logout();
        onClose();
        navigate("/login", { replace: true });
        return;
      }
      if (r.path) {
        pushRecent(r);
        navigate(r.path);
        onClose();
      }
    },
    [navigate, onClose, toggleTheme, logout],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = flat[active];
        if (r) activate(r);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [flat, active, activate, onClose],
  );

  // Scroll active row into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector<HTMLElement>(`[data-active="true"]`);
    if (node) {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-w-[calc(100vw-32px)] bg-panel border border-border shadow-md"
      >
        <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
          <SearchIcon size={16} className="text-textMuted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, models, panels, users…"
            className="flex-1 bg-transparent outline-none text-[14px] text-text placeholder:text-textFaint"
            aria-label="Search"
          />
          <kbd className="mono-caps text-[10px] text-textFaint border border-borderSoft px-1.5 h-[18px] inline-flex items-center">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {flat.length === 0 ? (
            <EmptyState
              loading={loading}
              query={q.trim()}
              hasRecents={recents.length > 0}
            />
          ) : (
            grouped.map((g, gi) => (
              <div key={g.kind} className={cn(gi > 0 && "mt-1")}>
                <div className="px-4 py-1.5 mono-caps text-[10px] text-textFaint tracking-wider">
                  {KIND_LABEL[g.kind]}
                </div>
                <ul>
                  {g.items.map((r) => {
                    const flatIdx = flat.indexOf(r);
                    const isActive = flatIdx === active;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          data-active={isActive}
                          onMouseEnter={() => setActive(flatIdx)}
                          onClick={() => activate(r)}
                          className={cn(
                            "w-full flex items-center gap-3 px-4 py-2 text-left",
                            isActive
                              ? "bg-panelAlt border-l-2 border-brass"
                              : "border-l-2 border-transparent hover:bg-panelAlt",
                          )}
                        >
                          {r.kind === "page" ? (
                            <PageIcon path={r.path ?? ""} />
                          ) : r.kind === "user" ? (
                            <Avatar name={r.title} size={20} />
                          ) : r.kind === "action" ? (
                            <ActionIcon id={r.id} />
                          ) : (
                            <KindIcon kind={r.kind} />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] text-text truncate">
                              {r.title}
                            </div>
                            {r.subtitle && (
                              <div className="text-[11px] text-textMuted truncate">
                                {r.subtitle}
                              </div>
                            )}
                          </div>
                          {r.badge && (
                            <span className="mono-caps text-[10px] text-textFaint tracking-wider ml-auto">
                              {r.badge}
                            </span>
                          )}
                          {isActive && (
                            <ArrowRightIcon size={12} className="text-brass" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-4 h-9 border-t border-border bg-bg text-[11px] text-textMuted">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[16px] inline-flex items-center">↑↓</kbd>
            navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[16px] inline-flex items-center">↵</kbd>
            select
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[16px] inline-flex items-center">esc</kbd>
            close
          </span>
          <span className="ml-auto mono-caps text-[10px] text-textFaint">
            {user ? `@${user.username}` : "guest"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ActionIcon({ id, className }: { id: string; className?: string }) {
  if (id === "action:toggle-theme") {
    const { theme } = useTheme();
    return theme === "dark" ? (
      <SunIcon size={14} className={cn("text-textMuted", className)} />
    ) : (
      <MoonIcon size={14} className={cn("text-textMuted", className)} />
    );
  }
  if (id === "action:sign-out") {
    return <LogOutIcon size={14} className={cn("text-textMuted", className)} />;
  }
  return <ZapIcon size={14} className={cn("text-textMuted", className)} />;
}

function EmptyState({
  loading,
  query,
  hasRecents,
}: {
  loading: boolean;
  query: string;
  hasRecents: boolean;
}) {
  if (loading) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-textMuted">
        searching…
      </div>
    );
  }
  if (query.length === 0 && hasRecents) {
    return null; // recents render above
  }
  return (
    <div className="px-4 py-8 text-center text-[12px] text-textMuted">
      no results
    </div>
  );
}
