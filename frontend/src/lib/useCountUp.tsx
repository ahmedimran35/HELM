// Animated count-up for stat values. Eases from 0 to `value` over ~900ms
// using easeOutCubic, re-rolling whenever `value` changes (so a 30s poll
// that brings a new number rolls from the old one, which reads as "live"
// rather than a jarring swap). Renders null until first observation so
// SSR-free initial mount never flashes a stale 0 for non-numeric values.
//
// Non-numeric values (strings like model names) pass straight through —
// callers can drop this component in only where counting makes sense.

import { useEffect, useRef, useState, type ReactNode } from "react";

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useCountUp(value: number, durationMs = 900): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number.isFinite(value) ? value : 0;
    // Same value → no animation, but still commit it as the animation start.
    if (from === to) {
      setDisplay(to);
      fromRef.current = to;
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const next = from + (to - from) * easeOutCubic(t);
      setDisplay(next);
      fromRef.current = next;
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, durationMs]);

  return display;
}

// Convenience wrapper: counts up a formatted number. `format` defaults to
// toLocaleString with rounding; pass a custom formatter for decimals ("ms",
// "¢", percentages). Render function receives the live value.
export function CountUp({
  value,
  format,
  durationMs,
}: {
  value: number;
  format?: (n: number) => ReactNode;
  durationMs?: number;
}) {
  const n = useCountUp(value, durationMs);
  if (format) return <>{format(n)}</>;
  return <>{Math.round(n).toLocaleString()}</>;
}
