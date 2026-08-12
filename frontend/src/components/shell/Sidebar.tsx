// Sidebar — left rail nav. Renders the nav items as FIVE collapsible
// sections (Chat / Build / Run / Discover / Operate) plus a search box at
// the top that filters items by label.
//
// Why grouped? A flat list of 13-20+ items is overwhelming and the user
// has to read every label to find what they want. Grouping turns the
// sidebar into a small set of menus the user can scan.
//
// Why a search box? Power users (and confused ones) can type to filter;
// when the box has focus or text, sections expand so all matches are
// visible regardless of which group they belong to.

import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/ThemeProvider";
import { groupedNav, groupLabel, type NavGroup, visibleNav } from "../../nav/items";
import { Avatar } from "../ui/Avatar";
import { PresenceDot } from "../ui/data/PresenceDot";
import { Button } from "../ui/Button";
import { NAV_ICONS } from "../ui/Icon";
import { ChevronDownIcon, SearchIcon, XIcon } from "../ui/Icon";
import { cn } from "../../lib/cn";

interface Props {
  onNavigate?: () => void;
}

const DEFAULT_OPEN: Record<NavGroup, boolean> = {
  chat: true,
  build: true,
  run: false,
  discover: false,
  operate: false,
};

export function Sidebar({ onNavigate }: Props) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Record<NavGroup, boolean>>(DEFAULT_OPEN);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  if (!user) return null;

  const groups = useMemo(() => groupedNav(user.role), [user.role]);

  // Filter groups: keep only items whose label or hint matches the
  // filter (case-insensitive). Groups with zero matches drop out.
  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return groups.map((g) => ({ ...g, matched: new Set<string>() }));
    return groups
      .map((g) => {
        const matched = new Set<string>();
        for (const it of g.items) {
          if (
            it.label.toLowerCase().includes(q) ||
            it.path.toLowerCase().includes(q) ||
            (it.hint ?? "").toLowerCase().includes(q)
          ) {
            matched.add(it.path);
          }
        }
        return { ...g, matched };
      })
      .filter((g) => g.matched.size > 0);
  }, [groups, filter]);

  // When the user is actively filtering, auto-expand all sections so
  // every match is visible at once (no need to click each header).
  useEffect(() => {
    if (filter.trim()) {
      setCollapsed({ chat: false, build: false, run: false, discover: false, operate: false });
    }
  }, [filter]);

  function toggle(g: NavGroup) {
    setCollapsed((c) => ({ ...c, [g]: !c[g] }));
  }

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <aside className="w-[260px] shrink-0 border-r border-border bg-panel flex flex-col h-full">
      {/* Brand + role badge */}
      <div className="px-4 pt-5 pb-4 border-b border-borderSoft">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div className="font-display text-[20px] font-bold tracking-[0.16em] text-text">
            HELM
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="mono-caps text-[10px] text-textFaint">OPS-01</span>
          <span className="text-textFaint">·</span>
          <span
            className={cn(
              "mono-caps text-[10px] tracking-wider px-1.5 h-[18px] inline-flex items-center border",
              user.role === "admin"
                ? "border-brass/40 text-brass"
                : "border-teal/40 text-teal",
            )}
          >
            {user.role}
          </span>
        </div>
      </div>

      {/* Search box — filters nav items by label */}
      <div className="px-3 py-2 border-b border-borderSoft">
        <div className="flex items-center gap-2 h-8 px-2 bg-bg border border-border focus-within:border-brass transition-colors">
          <SearchIcon size={12} className="text-textFaint shrink-0" />
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search nav…"
            aria-label="Search sidebar"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-text placeholder:text-textFaint"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-textFaint hover:text-text"
              aria-label="Clear search"
            >
              <XIcon size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Grouped nav sections */}
      <nav
        className="flex-1 overflow-y-auto py-1"
        role="navigation"
        aria-label="primary"
      >
        {filteredGroups.length === 0 && (
          <div className="px-3 py-6 text-center">
            <div className="mono-caps text-[10px] text-textFaint">no nav items match</div>
            <button
              type="button"
              onClick={() => setFilter("")}
              className="mt-2 mono-caps text-[10px] text-brass hover:underline"
            >
              clear search
            </button>
          </div>
        )}
        {filteredGroups.map(({ group, items, matched }) => {
          const isOpen = collapsed[group];
          const Icon = NAV_ICONS[items[0]?.path ?? "/"] ?? (() => null);
          const matchedPaths = matched as Set<string>;
          const showItems = !filter.trim() ? items : items.filter((it) => matchedPaths.has(it.path));
          return (
            <section key={group} className="border-b border-borderSoft last:border-b-0">
              <button
                type="button"
                onClick={() => toggle(group)}
                aria-expanded={isOpen}
                className="w-full px-3 py-2 flex items-center gap-2 group hover:bg-panelAlt/50 transition-colors"
              >
                <ChevronDownIcon
                  size={11}
                  className={cn(
                    "text-textMuted transition-transform shrink-0",
                    !isOpen && "-rotate-90",
                  )}
                />
                <span className="mono-caps text-[10px] tracking-wider text-textMuted uppercase flex-1 text-left">
                  {groupLabel(group)}
                </span>
                <span className="mono-caps text-[10px] text-textFaint tabular-nums">
                  {items.length}
                </span>
              </button>
              {isOpen && (
                <ul className="pb-2">
                  {showItems.map((item) => {
                    const ItemIcon = NAV_ICONS[item.path];
                    return (
                      <li key={item.path}>
                        <NavLink
                          to={item.path}
                          onClick={onNavigate}
                          aria-label={item.label}
                          title={item.hint ?? item.label}
                          className={({ isActive }) =>
                            cn(
                              "flex items-center gap-2.5 pl-7 pr-3 py-1.5 text-[12px] border-l-2 transition-colors",
                              isActive
                                ? "border-brass bg-panelAlt text-text"
                                : "border-transparent text-textMuted hover:bg-panelAlt/60 hover:text-text",
                            )
                          }
                        >
                          {ItemIcon ? (
                            <ItemIcon size={12} className="shrink-0" />
                          ) : (
                            <span className="w-3" />
                          )}
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.adminOnly && (
                            <span className="mono-caps text-[9px] text-brass/70 uppercase shrink-0">
                              A
                            </span>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>

      {/* Account footer */}
      <div className="border-t border-borderSoft px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0">
            <Avatar name={user.name} size={28} role={user.role} />
            <PresenceDot
              presence="online"
              size={8}
              className="absolute -bottom-0 -right-0"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-text truncate font-medium">
              {user.name}
            </div>
            {user.username !== user.name && (
              <div className="mono-caps text-[10px] text-textMuted truncate">
                @{user.username}
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleTheme}
            title={`switch to ${theme === "light" ? "dark" : "light"} theme`}
            aria-label={`switch to ${theme === "light" ? "dark" : "light"} theme`}
            className="flex-1 inline-flex items-center justify-between mono-caps text-[10px] text-textMuted hover:text-brass py-1 px-1.5 border border-borderSoft hover:border-brass"
          >
            <span>theme</span>
            <span>{theme}</span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
            className="!px-2"
          >
            ↪
          </Button>
        </div>
      </div>
    </aside>
  );
}

function BrandMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-brass shrink-0"
      aria-hidden
    >
      <path d="M3 20l4-16h2l4 16" />
      <path d="M7 4l3 16" />
      <path d="M11 12h6" />
      <path d="M17 4l-4 16" />
      <path d="M15 4l-3 16" />
    </svg>
  );
}
