// Empty state shown when a non-admin user navigates to an
// admin-only page. Replaces a blank/empty panel with a clear
// "you don't have access" message and a link back to Chat.

import { Link } from "react-router-dom";

export function NoAccess({ title }: { title: string }) {
  return (
    <div className="p-6 max-w-[640px]">
      <h1 className="font-display text-[20px] font-semibold text-text mb-2">
        {title}
      </h1>
      <p className="text-textMuted text-[13px] mb-4">
        This page is restricted to admins. You can keep using Chat, Panels
        and Workspace normally — just not this one.
      </p>
      <Link
        to="/chat"
        className="inline-block mono-caps text-[10px] text-brass hover:underline"
      >
        ← Back to Chat
      </Link>
    </div>
  );
}
