// PageHeader — the single page-title pattern.
//
// Before this existed, each page opened with a bare `<div className="p-6 …">`
// and the title was whatever heading happened to be first, at whatever size
// that page chose. Scanning the app meant re-learning the hierarchy on every
// route. Every page should now start with this so the title, subtitle and
// page-level actions always sit in the same place at the same size.

import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  /** Optional eyebrow above the title, e.g. "SETTINGS" or a breadcrumb tail. */
  section?: string;
  /** Page-level actions, right-aligned on the same row as the title. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, section, actions }: Props) {
  return (
    <header className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        {section && (
          <div className="mono-caps text-[10px] text-textFaint mb-1.5">
            {section}
          </div>
        )}
        <h1 className="font-display text-[20px] font-semibold text-text leading-tight truncate">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[13px] text-textMuted mt-1.5 max-w-[70ch]">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0 pt-0.5">{actions}</div>
      )}
    </header>
  );
}
