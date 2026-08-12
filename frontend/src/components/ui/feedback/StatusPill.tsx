// StatusPill — semantic status indicator with a coloured ring, an optional
// label, and a trailing meta (latency, count, etc.). Replaces the binary
// "on/off" badges that are scattered across models, providers, panels,
// and integrations pages.
//
// State semantics:
//   healthy   — teal ring, dot filled   — operating normally
//   warming   — brass ring, half-dot    — degraded but still serving
//   degraded  — rust ring, dot filled   — failing or rate-limited
//   idle      — textFaint ring, hollow  — not in active use
//   unknown   — textFaint ring, dotted  — health not yet reported
//
// The component is purely presentational — pass `state` and any optional
// `meta` (e.g. "0.3s p50"). The provider of the data decides what counts
// as healthy.

import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";

export type StatusState =
  | "healthy"
  | "warming"
  | "degraded"
  | "idle"
  | "unknown";

interface Props {
  state: StatusState;
  label?: ReactNode;
  meta?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

const RING: Record<StatusState, string> = {
  healthy: "border-teal",
  warming: "border-brass",
  degraded: "border-rust",
  idle: "border-border",
  unknown: "border-border",
};

const DOT_BG: Record<StatusState, string> = {
  healthy: "bg-teal",
  warming: "bg-brass",
  degraded: "bg-rust",
  idle: "bg-bg",
  unknown: "bg-border",
};

const DOT_SHADOW: Record<StatusState, string> = {
  healthy: "shadow-[0_0_6px_rgb(76_156_144/0.6)]",
  warming: "shadow-[0_0_6px_rgb(201_162_39/0.6)]",
  degraded: "shadow-[0_0_6px_rgb(181_83_60/0.6)]",
  idle: "",
  unknown: "",
};

const LABEL_TONE: Record<StatusState, string> = {
  healthy: "text-teal",
  warming: "text-brass",
  degraded: "text-rust",
  idle: "text-textFaint",
  unknown: "text-textFaint",
};

export function StatusPill({
  state,
  label,
  meta,
  size = "sm",
  className = "",
}: Props) {
  const ringSize = size === "md" ? "w-2 h-2" : "w-1.5 h-1.5";
  const innerDotSize = size === "md" ? "w-1 h-1" : "w-0.5 h-0.5";
  const fontSize = size === "md" ? "text-[12px]" : "text-[11px]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 mono-caps tracking-wider",
        fontSize,
        className,
      )}
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center rounded-full border",
          ringSize,
          RING[state],
        )}
      >
        <span
          className={cn(
            "rounded-full",
            innerDotSize,
            DOT_BG[state],
            DOT_SHADOW[state],
          )}
        />
      </span>
      {label && (
        <span className={cn(LABEL_TONE[state])}>{label}</span>
      )}
      {meta && (
        <span className="text-textMuted normal-case font-body tracking-normal text-[11px]">
          · {meta}
        </span>
      )}
    </span>
  );
}
