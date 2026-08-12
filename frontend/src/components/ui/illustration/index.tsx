// Monoline illustration set for EmptyState + small visual moments.
// Every illustration is drawn on a 80x80 viewBox with stroke-width 1.5
// and `stroke="currentColor"` so callers control colour and opacity via
// Tailwind text-* classes. No fills — everything is line work to keep
// the ops-console feel.
//
// Add a new illustration by exporting a named function that takes
// `className?: string`. Keep proportions consistent (the 80x80 grid is
// shared across the set) and avoid adding detail below ~3px stroke
// equivalent — it won't render at the sizes EmptyState uses.

import type { SVGProps } from "react";

type IllustrationProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Shell(props: IllustrationProps) {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 80 80"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function InboxIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <path d="M14 50h14l4 8h16l4-8h14" />
      <path d="M12 16h56v34H62l-4 8H22l-4-8H12z" />
      <path d="M22 38h8" />
      <path d="M36 38h8" />
      <path d="M50 38h8" />
    </Shell>
  );
}

export function CheckCircleIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <circle cx="40" cy="40" r="26" />
      <path d="M28 40l8 8 16-18" />
    </Shell>
  );
}

export function SpeechBubbleIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <path d="M14 22a6 6 0 0 1 6-6h40a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H34l-10 10v-10h-4a6 6 0 0 1-6-6z" />
      <circle cx="30" cy="32" r="2" fill="currentColor" stroke="none" />
      <circle cx="40" cy="32" r="2" fill="currentColor" stroke="none" />
      <circle cx="50" cy="32" r="2" fill="currentColor" stroke="none" />
    </Shell>
  );
}

export function LedgerIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <path d="M22 12h36a4 4 0 0 1 4 4v48a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z" />
      <path d="M26 22h28" />
      <path d="M26 32h28" />
      <path d="M26 42h20" />
      <path d="M26 52h24" />
    </Shell>
  );
}

export function SearchIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <circle cx="34" cy="34" r="16" />
      <path d="M46 46l16 16" />
      <path d="M28 34h12" />
    </Shell>
  );
}

export function GearIllustration(props: IllustrationProps) {
  return (
    <Shell {...props}>
      <circle cx="40" cy="40" r="10" />
      <path d="M40 14v8" />
      <path d="M40 58v8" />
      <path d="M14 40h8" />
      <path d="M58 40h8" />
      <path d="M22 22l5.5 5.5" />
      <path d="M52.5 52.5L58 58" />
      <path d="M22 58l5.5-5.5" />
      <path d="M52.5 27.5L58 22" />
    </Shell>
  );
}

// App-preview thumbnail — a small "screen" with a chrome bar across the
// top and a couple of horizontal lines suggesting content. Used on the
// app cards in /apps and /my-apps so each tile has a recognisable
// placeholder instead of an empty box.
//
// `variant` picks which glyph family sits inside the chrome:
//   - "standup"   — three short bars (one for each standup section)
//   - "notes"     — long thin lines (a notepad)
//   - "inbox"     — stacked rows with one dot (an inbox row)
//   - "default"   — generic three-bar content
//
// The chrome bar is always there so the screen reads consistently across
// the variants.
export type AppPreviewVariant = "standup" | "notes" | "inbox" | "default";

interface AppPreviewIllustrationProps extends IllustrationProps {
  variant?: AppPreviewVariant;
}

export function AppPreviewIllustration({
  variant = "default",
  ...props
}: AppPreviewIllustrationProps) {
  return (
    <Shell {...props}>
      {/* outer screen */}
      <rect x="12" y="14" width="56" height="52" rx="2" />
      {/* chrome bar */}
      <path d="M12 22h56" />
      {/* chrome dots */}
      <circle cx="18" cy="18" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="22" cy="18" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="26" cy="18" r="1.2" fill="currentColor" stroke="none" />
      {variant === "standup" && (
        <>
          <path d="M18 30h44" />
          <path d="M18 36h36" />
          <path d="M18 30h28" />
          <path d="M18 46h44" />
          <path d="M18 52h32" />
        </>
      )}
      {variant === "notes" && (
        <>
          <path d="M18 30h44" />
          <path d="M18 36h44" />
          <path d="M18 42h36" />
          <path d="M18 48h44" />
          <path d="M18 54h28" />
        </>
      )}
      {variant === "inbox" && (
        <>
          <path d="M18 32h44" />
          <path d="M18 40h44" />
          <path d="M18 48h44" />
          <path d="M18 56h32" />
          <circle cx="16" cy="32" r="1" fill="currentColor" stroke="none" />
        </>
      )}
      {variant === "default" && (
        <>
          <path d="M18 32h44" />
          <path d="M18 40h36" />
          <path d="M18 48h44" />
          <path d="M18 56h28" />
        </>
      )}
    </Shell>
  );
}

// Re-export the Shell for advanced callers (e.g. brand mark).
export const IllustrationFrame = Shell;
