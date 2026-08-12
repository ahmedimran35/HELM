// AvatarStack — overlapping avatars with a "+N" overflow chip. Used in
// panel headers (showing who's online / assigned), in member pickers,
// and anywhere a list of people needs to read at a glance without
// consuming a whole row each.
//
// Behaviour:
//   - Always renders the first 5 avatars in full, then a "+N" pill for
//     the rest. The "rest" number includes the overflow so a team of 8
//     shows 5 avatars + "+3".
//   - Avatars are stacked from the right with a -ml overlap; the last
//     visible avatar is the leftmost.
//   - The wrapping element is `inline-flex` so it sits inline with
//     text. Pass `size` to scale the whole stack proportionally.

import { Avatar } from "../Avatar";
import { cn } from "../../../lib/cn";

export interface StackMember {
  /** Display name (used as the Avatar's `name` prop). */
  name: string;
  role?: "admin" | "user";
}

interface Props {
  members: StackMember[];
  /** Avatar diameter in px. Default 24. */
  size?: number;
  /** How many avatars to show before the "+N" chip. Default 5. */
  max?: number;
  /** Render the "+N" overflow chip. */
  showOverflow?: boolean;
  className?: string;
}

export function AvatarStack({
  members,
  size = 24,
  max = 5,
  showOverflow = true,
  className = "",
}: Props) {
  const visible = members.slice(0, max);
  const overflow = Math.max(0, members.length - visible.length);
  return (
    <div className={cn("inline-flex items-center", className)}>
      <div className="flex">
        {visible.map((m, i) => (
          <div
            key={`${m.name}-${i}`}
            className={cn(
              "ring-2 ring-panel",
              i > 0 && "-ml-2",
            )}
            style={{ zIndex: visible.length - i }}
          >
            <Avatar name={m.name} size={size} role={m.role} />
          </div>
        ))}
      </div>
      {showOverflow && overflow > 0 && (
        <div
          className={cn(
            "-ml-2 ring-2 ring-panel",
            "inline-flex items-center justify-center font-mono text-[10px] text-textMuted bg-panelAlt border border-border",
            "rounded-full",
          )}
          style={{ width: size, height: size }}
          aria-label={`${overflow} more`}
          title={`${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}
