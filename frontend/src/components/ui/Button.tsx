import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brass text-bg hover:bg-brass/90 active:bg-brassSoft border border-brass disabled:opacity-50",
  secondary:
    "bg-panelAlt text-text border border-border hover:bg-panel hover:border-borderSoft disabled:opacity-50",
  ghost:
    "bg-transparent text-textMuted hover:text-text hover:bg-panelAlt border border-transparent disabled:opacity-50",
  danger:
    "bg-rust/15 text-rust border border-rust/40 hover:bg-rust/25 disabled:opacity-50",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={`inline-flex items-center justify-center gap-2 font-medium mono-caps tracking-wider rounded-none transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    />
  );
});