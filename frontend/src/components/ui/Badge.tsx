// Status badges — coloured dots used everywhere a state needs to read at a
// glance (online, denied, warning, etc.). Dot is the colour; label uses
// the same mono-caps typography as the call-signs.

type Tone = "neutral" | "brass" | "teal" | "rust";

interface Props {
  tone?: Tone;
  children: React.ReactNode;
}

const TONE: Record<Tone, { dot: string; text: string }> = {
  neutral: { dot: "bg-textMuted", text: "text-textMuted" },
  brass: { dot: "bg-brass", text: "text-brass" },
  teal: { dot: "bg-teal", text: "text-teal" },
  rust: { dot: "bg-rust", text: "text-rust" },
};

export function Badge({ tone = "neutral", children }: Props) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 mono-caps text-[11px] ${t.text}`}>
      <span className={`w-1.5 h-1.5 ${t.dot}`} />
      {children}
    </span>
  );
}