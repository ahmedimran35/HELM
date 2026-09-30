// Sidebar — left rail nav. Renders the nav items as FOUR collapsible
// sections (Core / Build / System / Admin), behaving as an accordion: only
// one section is open at a time, so the rail can never grow taller than a
// single section plus the collapsed headers.
//
// Why an accordion? Earlier revisions let every section open independently,
// so a few clicks stacked Core + Build + Ops past the fold and the rail read
// as an undifferentiated wall of links. Bounding it to one open section keeps
// the vertical footprint predictable no matter what the user clicks.
//
// Grouping is defined in nav/items.ts. "Admin" holds every adminOnly item, so
// it disappears entirely for `user` role rather than being interleaved with
// everyday destinations. There is no inline search box: the ⌘K command
// palette already searches pages (via /api/search), models, panels, users and
// actions, so a second filter here would be a weaker duplicate.

import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/ThemeProvider";
import { groupedNav, groupLabel, type NavGroup } from "../../nav/items";
import { Avatar } from "../ui/Avatar";
import { PresenceDot } from "../ui/data/PresenceDot";
import { Button } from "../ui/Button";
import { NAV_ICONS } from "../ui/Icon";
import { ChevronDownIcon } from "../ui/Icon";
import { cn } from "../../lib/cn";

interface Props {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: Props) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  // Accordion: exactly one section open, or none (null). Core opens by
  // default so the most-used destinations are visible on first paint.
  const [openGroup, setOpenGroup] = useState<NavGroup | null>("core");

  // NOTE: the `if (!user) return null` guard lives *after* every hook below.
  // Returning early before a hook changes the hook order between renders
  // (user null → non-null) and breaks React's rules of hooks.
  const groups = useMemo(() => groupedNav(user?.role ?? "user"), [user?.role]);

  if (!user) return null;

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <aside className="w-[260px] shrink-0 border-r border-border bg-panel flex flex-col h-full">
      {/* Brand + role badge */}
      <div className="px-4 pt-5 pb-4 border-b border-borderSoft bg-gradient-to-b from-panel to-panelAlt/50">
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

      {/* Grouped nav sections — accordion */}
      <nav
        className="flex-1 overflow-y-auto py-1"
        role="navigation"
        aria-label="primary"
      >
        {groups.map(({ group, items }) => {
          const isOpen = openGroup === group;
          return (
            <section key={group} className="border-b border-borderSoft last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenGroup(isOpen ? null : group)}
                aria-expanded={isOpen}
                className="w-full px-3 py-2 flex items-center gap-2 group hover:bg-panelAlt/50 transition-colors duration-150"
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
              </button>
              {isOpen && (
                <ul className="pb-2">
                  {items.map((item) => {
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
                              "flex items-center gap-2.5 pl-7 pr-3 py-1.5 text-[12px] border-l-[3px] transition-colors duration-150",
                              isActive
                                ? "border-brass bg-panelAlt text-text font-medium"
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
