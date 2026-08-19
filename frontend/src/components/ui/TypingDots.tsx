// Typing indicator — three brass dots that pulse in a flowing wave.
// Used in the Chat thread while we wait for the model's first token to
// arrive and to mark the tail of a streaming reply.
//
// The wave animation (staggered delays) is more visually distinctive
// than simultaneous pulse — the user sees a clear "typing" rhythm
// rather than three dots breathing in unison. Also includes an optional
// "thinking" label for explicit context.

interface Props {
  size?: "sm" | "md";
  label?: string;
  /** When true, uses the larger "thinking" variant with a stronger
   *  pulsing rate. Use for the "model is thinking" placeholder
   *  before the first token arrives. */
  active?: boolean;
}

export function TypingDots({ size = "md", label, active = false }: Props) {
  // Larger dots than the previous version — at sm size (used in the
  // message row) we were getting 1.5×1.5 px circles which
  // disappear against the cream bg. Bigger dots + stronger colour
  // ramp (0.25 → 1.0 opacity) make the wave unmistakably visible.
  const sizeClass = size === "sm"
    ? "w-2 h-2"
    : "w-3 h-3";
  // Faster pulse when actively streaming — gives a clear "thinking"
  // sensation. Slower when merely waiting for the first token.
  const baseDuration = active ? "700ms" : "1100ms";
  return (
    <span
      className="inline-flex items-center gap-1.5 align-middle"
      aria-label={label ?? (active ? "thinking" : "typing")}
    >
      <span
        className={`${sizeClass} bg-brass rounded-full inline-block`}
        style={{
          animation: `typing-wave ${baseDuration} ease-in-out infinite`,
          animationDelay: "0ms",
        }}
      />
      <span
        className={`${sizeClass} bg-brass rounded-full inline-block`}
        style={{
          animation: `typing-wave ${baseDuration} ease-in-out infinite`,
          animationDelay: "180ms",
        }}
      />
      <span
        className={`${sizeClass} bg-brass rounded-full inline-block`}
        style={{
          animation: `typing-wave ${baseDuration} ease-in-out infinite`,
          animationDelay: "360ms",
        }}
      />
    </span>
  );
}
