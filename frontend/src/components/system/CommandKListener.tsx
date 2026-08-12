// CmdKListener — global keyboard listener that toggles the command
// palette when the user presses ⌘K (mac) or Ctrl+K (win/linux).
//
// We intentionally implement this as its own component (rather than
// inside CommandPaletteProvider) so the listener is mounted even when
// the palette is closed — and so the provider tree stays simple.

import { useEffect } from "react";
import { useCommandPalette } from "./CommandPalette";

export function CmdKListener() {
  const { toggle } = useCommandPalette();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when the user is typing into a field that isn't the
      // palette's own input. We use a simple heuristic: the listener
      // fires before React's onKeyDown, but we don't try to be too
      // clever — we just check `isContentEditable` or `tagName`.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        // Allow ⌘K / Ctrl+K even inside inputs (it's the global shortcut).
        if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
  return null;
}
