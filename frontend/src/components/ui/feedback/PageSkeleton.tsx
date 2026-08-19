// PageSkeleton — generic full-page loading placeholder. Used as the
// Suspense fallback while a route-level chunk is being fetched, so the
// user sees an instant pulsing shape (header bar + content rows) instead
// of a blank flash.
//
// The shape mirrors the typical HELM page layout: a header title strip
// at the top, a divider, then a stack of body rows. We deliberately
// keep it generic so it works for any of the 29 pages without forking
// per-page variants.

import { Skeleton } from "./Skeleton";

export function PageSkeleton() {
  return (
    <div className="p-6 max-w-[1100px] mx-auto space-y-6" aria-busy="true">
      {/* Header strip — mirrors the page title + subtitle shape. */}
      <div className="space-y-2">
        <Skeleton
          variant="block"
          height={28}
          width="40%"
          className="!h-[28px]"
        />
        <Skeleton variant="text" width="60%" />
      </div>

      {/* Body — a 2-column tile grid then a list of rows. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} variant="block" height={72} />
        ))}
      </div>

      <div className="border border-border bg-panel">
        <div className="px-4 py-2 border-b border-borderSoft">
          <Skeleton variant="text" width="30%" />
        </div>
        <div className="p-4 space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} variant="row" />
          ))}
        </div>
      </div>
    </div>
  );
}
