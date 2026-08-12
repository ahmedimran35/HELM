// Avatar — circular monogram with a deterministic colour per user.
// Use as the left rail of every chat / panel message so the sender is
// recognisable at a glance.

import { type CSSProperties } from "react";

interface Props {
  name: string;
  size?: number;
  role?: "admin" | "user";
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

const PALETTE = [
  { bg: "#3a2c1a", fg: "#C9A227" }, // brass on warm brown
  { bg: "#1a2e2c", fg: "#4C9C90" }, // teal on dark teal
  { bg: "#2a1f2c", fg: "#B98FC2" }, // soft violet
  { bg: "#1f2a1a", fg: "#9CB87C" }, // sage
  { bg: "#2c2418", fg: "#D89B5C" }, // amber
  { bg: "#1c2530", fg: "#7DA8D9" }, // sky
  { bg: "#2b1d1d", fg: "#D17D7D" }, // dusty red
  { bg: "#1d2920", fg: "#86C292" }, // mint
];

function initials(name: string): string {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({ name, size = 32, role }: Props) {
  const palette = PALETTE[hashStr(name) % PALETTE.length]!;
  const isAdmin = role === "admin";
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: palette.bg,
    color: palette.fg,
    fontSize: size * 0.42,
  };
  return (
    <span
      className="relative inline-flex items-center justify-center rounded-full font-display font-semibold select-none"
      style={style}
      aria-label={name}
    >
      {initials(name)}
      {isAdmin && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-brass border border-bg rounded-full"
          title="admin"
        />
      )}
    </span>
  );
}