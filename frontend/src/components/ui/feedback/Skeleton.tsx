// Skeleton — placeholder shapes used while real content loads. The
// shimmer animation uses a linear gradient that crosses the element so
// the user sees motion (the eye is drawn to moving things) which feels
// more responsive than a static gray rectangle.
//
// Variants:
//   block   — generic rectangle (default)
//   text    — single line of "body text" (shorter than 100%)
//   circle  — round avatar placeholder
//   row     — table-row-shaped bar
//
// All variants honour `data-theme` via the --shimmer CSS variables
// defined in index.css so the highlight colour reads correctly in both
// light and dark modes.

import type { CSSProperties } from "react";
import { cn } from "../../../lib/cn";

export type SkeletonVariant = "block" | "text" | "circle" | "row";

interface Props {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  className?: string;
  /** Disable the shimmer animation (useful for static mocks). */
  static?: boolean;
  /** Override the animation duration in milliseconds. */
  durationMs?: number;
}

export function Skeleton({
  variant = "block",
  width,
  height,
  className = "",
  static: isStatic = false,
  durationMs = 1500,
}: Props) {
  const style: CSSProperties = {
    width,
    height:
      height ??
      (variant === "text"
        ? "0.85em"
        : variant === "row"
          ? 18
          : variant === "circle"
            ? width ?? 32
            : undefined),
    animationDuration: `${durationMs}ms`,
  };

  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "block bg-panelAlt relative overflow-hidden",
        variant === "text" && "rounded-[1px] h-[0.85em]",
        variant === "row" && "h-[18px]",
        variant === "circle" && "rounded-full",
        variant === "block" && "h-[60px]",
        !isStatic && "skeleton-shimmer",
        className,
      )}
    />
  );
}

// Convenience wrappers for common patterns.
export function SkeletonText({
  lines = 1,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          variant="text"
          width={i === lines - 1 ? "70%" : "100%"}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 5,
  columns = 4,
  className = "",
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton
              key={c}
              variant="row"
              width={`${100 / columns}%`}
              className="flex-1"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
