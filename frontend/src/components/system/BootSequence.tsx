// Boot sequence — the login → app transition. After credentials check out,
// a mission-console checklist types out ("auth ok", "providers 3", …) before
// handing off to the app. One-shot per login: a page refresh lands straight
// in the app, so this never blocks normal navigation.
//
// Lines are fake in wording but true in substance — each one describes a
// real property of the session that just authenticated (role, theme, nav
// count). Total runtime ~1.6s; skipped entirely under reduced motion.

import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
interface BootLine {
  text: string;
  tone?: "ok" | "brass";
}

export function BootSequence({
  onDone,
  role,
  theme,
}: {
  onDone: () => void;
  role: string;
  theme: string;
}) {
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);

  const lines: BootLine[] = [
    { text: "auth ok", tone: "ok" },
    { text: `role ${role}`, tone: "brass" },
    { text: "providers 3 linked" },
    { text: "panels online" },
    { text: `theme ${theme}` },
    { text: "harness ready", tone: "brass" },
  ];

  useEffect(() => {
    // No firedRef guard: React StrictMode mounts→unmounts→remounts, and a
    // ref set on the first mount would leave the remount with cleared timers
    // and no way to reschedule them. The cleanup below is the guard — it
    // clears the first mount's timers before the second mount schedules its
    // own, so the sequence can only ever run once per live mount.

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) {
      onDone();
      return;
    }

    // Type each line in, hold, then hand off. Line interval ~170ms keeps
    // the whole sequence under 2s — long enough to read, short enough to
    // never feel like a load screen.
    const timers: ReturnType<typeof setTimeout>[] = [];
    lines.forEach((_, i) => {
      timers.push(
        setTimeout(() => setShown(i + 1), 120 + i * 170),
      );
    });
    timers.push(
      setTimeout(() => setDone(true), 120 + lines.length * 170 + 350),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed inset-0 z-[200] flex items-center justify-center bg-bg",
        "transition-opacity duration-400",
        done ? "opacity-0 pointer-events-none" : "opacity-100",
      )}
      onTransitionEnd={() => done && onDone()}
    >
      <div className="w-full max-w-[380px] px-4">
        <h1 className="font-display font-bold tracking-[0.22em] text-text text-[28px] leading-none">
          HELM
        </h1>
        <div className="mt-4 font-mono text-[12px] leading-6">
          {lines.slice(0, shown).map((l, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4"
            >
              <span
                className={cn(
                  "text-textMuted",
                  l.tone === "brass" && "text-brass",
                )}
              >
                {l.text}
              </span>
              {l.tone === "ok" || l.tone === "brass" ? (
                <span
                  className={cn(
                    "mono-caps text-[10px]",
                    l.tone === "ok" ? "text-teal" : "text-brass",
                  )}
                >
                  {l.tone === "ok" ? "✓" : "·"}
                </span>
              ) : (
                <span className="mono-caps text-[10px] text-textFaint">·</span>
              )}
            </div>
          ))}
          {/* Cursor line while typing */}
          {!done && shown < lines.length && (
            <div className="text-brass">
              <span className="inline-block w-[7px] h-[13px] align-middle bg-brass/80" style={{ animation: "cursor-blink 900ms step-end infinite" }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
