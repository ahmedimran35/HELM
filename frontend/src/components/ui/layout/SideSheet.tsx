// SideSheet — a sliding side panel that mounts a portal and overlays
// the right edge of the screen. Used for admin/management actions
// that shouldn't crowd the main task.
//
// Why it exists:
//   - The old Panels page stacked every admin control (members, skills,
//     knowledge) above the chat thread, so picking a panel meant
//     scrolling past 200px of admin chrome to reach the input.
//   - The fix is to put chat first, members/skills in a sheet that
//     opens on demand. The chat becomes the always-visible primary
//     surface; admin work is opt-in.
//
// API:
//   - <SideSheet open={bool} onClose={fn} title="Panel settings" side="right">
//       ...children...
//     </SideSheet>
//
// - ESC closes the sheet
// - Click on the backdrop closes the sheet
// - The sheet is a portal so it escapes any overflow:hidden ancestor
// - Animation is a 200ms translateX (no overshoot, no setTimeout)
// - The page below is inert (aria-modal semantics) and gets scroll-locked
//   while the sheet is open
// - Honors prefers-reduced-motion: snaps in instantly if the user opted
//   out of animations

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../../lib/cn";
import { XIcon } from "../Icon";

export type SheetSide = "right" | "left";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  side?: SheetSide;
  /** Tailwind width class — default `w-[420px]` for the right sheet. */
  widthClass?: string;
  children: ReactNode;
  /** Optional footer slot pinned to the bottom of the sheet. */
  footer?: ReactNode;
  className?: string;
}

export function SideSheet({
  open,
  onClose,
  title,
  description,
  side = "right",
  widthClass = "w-[420px] max-w-[90vw]",
  children,
  footer,
  className = "",
}: Props) {
  // ESC key closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // SSR-safe: only render the portal on the client.
  if (typeof document === "undefined" || !open) return null;

  const isRight = side === "right";
  // Off-screen transform when closed so the open animation is a slide-in.
  const closedTransform = isRight ? "translateX(100%)" : "translateX(-100%)";
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex"
      role="presentation"
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200"
      />
      {/* Sheet */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={cn(
          "relative h-full bg-panel border-l border-border flex flex-col shadow-2xl",
          widthClass,
          className,
        )}
        style={{
          transform: closedTransform,
          animation: `side-sheet-in 200ms ease-out forwards`,
        }}
      >
        <header className="px-4 py-3 border-b border-borderSoft flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {title && (
              <div className="font-display text-[14px] font-semibold text-text truncate">
                {title}
              </div>
            )}
            {description && (
              <div className="mono-caps text-[10px] text-textFaint mt-0.5">
                {description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="text-textMuted hover:text-text p-1"
          >
            <XIcon size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <footer className="border-t border-borderSoft px-4 py-3 bg-bg">
            {footer}
          </footer>
        )}
      </aside>
      <style>{`@keyframes side-sheet-in { from { transform: ${closedTransform}; } to { transform: translateX(0); } } @media (prefers-reduced-motion: reduce) { @keyframes side-sheet-in { from, to { transform: translateX(0); } } }`}</style>
    </div>,
    document.body,
  );
}

// TabStrip — small helper for sheets/sidebars that have multiple tabs.
// Lightweight on purpose: just buttons in a row.
export function SheetTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex border-b border-borderSoft">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "flex-1 px-3 py-2 mono-caps text-[11px] border-b-2 transition-colors",
            active === t.id
              ? "border-brass text-text"
              : "border-transparent text-textMuted hover:text-text",
          )}
        >
          {t.label}
          {typeof t.count === "number" && (
            <span className="ml-1.5 text-textFaint">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
