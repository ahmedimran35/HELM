// PresenceDot — small status indicator (online / away / busy / offline).
// Stacks onto the bottom-right of an avatar (Avatar already has an admin
// badge; this is the "online" overlay used in panels and team rosters).
//
// Sizes match Avatar's standard sizes (24, 28, 32, 40) so the dot stays
// proportional no matter which size the avatar uses.

import { cn } from "../../../lib/cn";

export type Presence = "online" | "away" | "busy" | "offline";

interface Props {
  presence: Presence;
  size?: number;
  /** Render with a small ring matching the surface colour. */
  withRing?: boolean;
  className?: string;
  title?: string;
}

const DOT: Record<Presence, string> = {
  online: "bg-teal",
  away: "bg-brass",
  busy: "bg-rust",
  offline: "bg-textFaint",
};

const GLOW: Record<Presence, string> = {
  online: "shadow-[0_0_4px_rgb(76_156_144/0.7)]",
  away: "",
  busy: "",
  offline: "",
};

const LABEL: Record<Presence, string> = {
  online: "online",
  away: "away",
  busy: "busy",
  offline: "offline",
};

export function PresenceDot({
  presence,
  size = 10,
  withRing = true,
  className = "",
  title,
}: Props) {
  const ringSize = size + 2;
  return (
    <span
      className={cn(
        "inline-block rounded-full",
        DOT[presence],
        GLOW[presence],
        className,
      )}
      style={{
        width: size,
        height: size,
        boxShadow: withRing ? "0 0 0 2px var(--panel)" : undefined,
      }}
      aria-label={title ?? LABEL[presence]}
      title={title ?? LABEL[presence]}
      role="status"
    />
  );
}
