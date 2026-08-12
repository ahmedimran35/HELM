// CallSign — the signature visual device (docs §1). Every model, panel,
// request gets an ID rendered in mono with a brass accent. Two tones:
//   `default` — neutral border, brass text
//   `muted`   — softer, used in lists where many call-signs appear at once

interface Props {
  id: string;
  variant?: "default" | "muted";
}

export function CallSign({ id, variant = "default" }: Props) {
  const tone =
    variant === "muted"
      ? "border-borderSoft text-textMuted"
      : "border-brassSoft text-brass";
  return (
    <span
      className={`inline-flex items-center mono-caps text-[11px] px-1.5 py-0.5 border bg-bg/40 ${tone}`}
    >
      {id}
    </span>
  );
}