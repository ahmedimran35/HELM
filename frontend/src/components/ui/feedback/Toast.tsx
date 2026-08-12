// Toast — short-lived, non-blocking notification system.
// Architecture:
//   - ToastProvider mounts a portal at document.body and listens for
//     `addToast` calls from the `useToast()` hook.
//   - Toasts auto-dismiss after their `duration` (default 4s) but a
//     hover or focus keeps them open until the pointer leaves.
//   - Each toast has a stable id, an optional `action` (e.g. Undo), and
//     one of three tones: success (teal), warning (rust), info (brass).
//
// We deliberately use a portal + a context-driven imperative API. Redux-
// style stores are overkill for ephemeral UI; passing props down through
// every page would couple the layout to the notification. The portal
// keeps the viewport free from overflow:hidden ancestors.

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
import { cn } from "../../../lib/cn";
import { CheckIcon, AlertTriangleIcon, InfoIcon, XIcon } from "../Icon";

export type ToastTone = "info" | "success" | "warning";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  /** Required unique key (callers control to allow deduplication). */
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss after this many ms; 0 means "sticky". */
  duration?: number;
  action?: ToastAction;
}

interface InternalToast extends Required<Omit<ToastInput, "description" | "action" | "duration">> {
  description?: string;
  action?: ToastAction;
  duration: number;
  /** Wall-clock time when the toast was created. */
  createdAt: number;
}

interface ToastContextValue {
  addToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
  toasts: InternalToast[];
}

const Ctx = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (input: ToastInput) => {
      const tone = input.tone ?? "info";
      const duration = input.duration ?? 4000;
      const createdAt = Date.now();
      setToasts((cur) => {
        // Deduplicate by id — replace the previous toast with the same id
        // (useful for "still saving…" → "saved" transitions).
        const next = cur.filter((t) => t.id !== input.id);
        next.push({
          id: input.id,
          title: input.title,
          description: input.description,
          tone,
          duration,
          action: input.action,
          createdAt,
        });
        return next;
      });
      if (duration > 0) {
        const timer = setTimeout(() => dismissToast(input.id), duration);
        timersRef.current.set(input.id, timer);
      }
    },
    [dismissToast],
  );

  // Cleanup pending timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ addToast, dismissToast, toasts }),
    [addToast, dismissToast, toasts],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {typeof document !== "undefined"
        ? createPortal(<ToastViewport toasts={toasts} dismiss={dismissToast} />, document.body)
        : null}
    </Ctx.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

const TONE_ICON: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckIcon,
  warning: AlertTriangleIcon,
};

const TONE_STYLE: Record<ToastTone, string> = {
  info: "border-brass/40 text-text",
  success: "border-teal/40 text-text",
  warning: "border-rust/50 text-text",
};

const TONE_ICON_STYLE: Record<ToastTone, string> = {
  info: "text-brass",
  success: "text-teal",
  warning: "text-rust",
};

function ToastViewport({
  toasts,
  dismiss,
}: {
  toasts: InternalToast[];
  dismiss: (id: string) => void;
}) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: InternalToast;
  onDismiss: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = TONE_ICON[toast.tone];

  // When hovered, pause auto-dismiss by re-adding the toast on mouseleave.
  const handleMouseEnter = () => setHovered(true);
  const handleMouseLeave = () => setHovered(false);

  return (
    <div
      role="status"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "pointer-events-auto toast-enter toast-enter-active",
        "border bg-panel shadow-md",
        "px-3 py-2.5 flex items-start gap-2.5",
        TONE_STYLE[toast.tone],
      )}
      data-paused={hovered ? "true" : "false"}
    >
      <Icon size={16} className={cn("mt-[1px] shrink-0", TONE_ICON_STYLE[toast.tone])} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] leading-[1.4] font-medium">{toast.title}</div>
        {toast.description && (
          <div className="mt-0.5 text-[12px] text-textMuted leading-[1.4]">
            {toast.description}
          </div>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="mt-1.5 text-[12px] text-brass hover:text-brass/80 mono-caps tracking-wider"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="text-textFaint hover:text-text p-0.5 -mt-0.5 -mr-0.5"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
