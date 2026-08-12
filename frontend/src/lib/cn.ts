// Tiny class-name joiner. Filters falsy values so callers can write
// `cn("base", isActive && "active")` without a trailing space.
//
// We don't pull in `clsx` or `tailwind-merge` — both are unnecessary
// weight for a 5-line utility. If callers ever need conditional Tailwind
// merging (e.g. "p-2 p-4"), add it then.

export function cn(
  ...args: Array<string | number | boolean | null | undefined>
): string {
  return args.filter((a) => typeof a === "string" && a.length > 0).join(" ");
}
