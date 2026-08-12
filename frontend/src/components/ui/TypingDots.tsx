// Typing indicator — three brass dots that pulse in sequence. Used in
// the Chat thread while we wait for the model's first token to arrive
// and to mark the tail of a streaming reply.

interface Props {
  size?: "sm" | "md";
  label?: string;
}

export function TypingDots({ size = "md", label }: Props) {
  const dotClass = size === "sm" ? "w-1 h-1" : "w-1.5 h-1.5";
  return (
    <span
      className="inline-flex items-center gap-1.5 align-middle"
      aria-label={label ?? "typing"}
    >
      <span
        className={`${dotClass} bg-brass rounded-full animate-pulse`}
        style={{ animationDelay: "0ms", animationDuration: "900ms" }}
      />
      <span
        className={`${dotClass} bg-brass rounded-full animate-pulse`}
        style={{ animationDelay: "200ms", animationDuration: "900ms" }}
      />
      <span
        className={`${dotClass} bg-brass rounded-full animate-pulse`}
        style={{ animationDelay: "400ms", animationDuration: "900ms" }}
      />
    </span>
  );
}