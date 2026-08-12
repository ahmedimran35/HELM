// EmptyState — illustrated placeholder for "no data yet" panels. Each
// variant is a small monoline SVG drawn on the same 80x80 grid, themed
// with `currentColor` so it picks up the brass/teal/rust accent. The
// component wraps the illustration in a sensible layout (illustration
// above title, action below) and stays accessible.
//
// Variants are explicit and named for the place they appear in the
// product. Add a new variant here when you need a new empty state —
// the page code only ever references a name, never a hard-coded SVG.

import type { ReactNode } from "react";
import { cn } from "../../../lib/cn";
import {
  InboxIllustration,
  CheckCircleIllustration,
  SpeechBubbleIllustration,
  LedgerIllustration,
  SearchIllustration,
  GearIllustration,
} from "../illustration";

export type EmptyVariant =
  | "inbox"
  | "allClear"
  | "conversation"
  | "ledger"
  | "search"
  | "gear";

interface Props {
  variant?: EmptyVariant;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "brass" | "teal" | "neutral";
  className?: string;
}

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  brass: "text-brass",
  teal: "text-teal",
  neutral: "text-textMuted",
};

function Illustration({
  variant,
  className,
}: {
  variant: EmptyVariant;
  className?: string;
}) {
  switch (variant) {
    case "inbox":
      return <InboxIllustration className={className} />;
    case "allClear":
      return <CheckCircleIllustration className={className} />;
    case "conversation":
      return <SpeechBubbleIllustration className={className} />;
    case "ledger":
      return <LedgerIllustration className={className} />;
    case "search":
      return <SearchIllustration className={className} />;
    case "gear":
      return <GearIllustration className={className} />;
    default:
      return <InboxIllustration className={className} />;
  }
}

export function EmptyState({
  variant = "inbox",
  title,
  description,
  action,
  tone = "brass",
  className = "",
}: Props) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center px-6 py-10",
        className,
      )}
    >
      <div
        className={cn(
          "mb-4 inline-flex items-center justify-center w-[88px] h-[88px] border border-borderSoft",
          TONE[tone],
        )}
      >
        <Illustration variant={variant} className="opacity-90" />
      </div>
      <h3 className="font-display text-[15px] font-medium text-text">
        {title}
      </h3>
      {description && (
        <p className="mt-1.5 max-w-[34ch] text-[13px] text-textMuted leading-[1.55]">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
