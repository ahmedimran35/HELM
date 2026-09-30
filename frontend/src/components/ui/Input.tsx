import { type InputHTMLAttributes, forwardRef } from "react";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, hint, className = "", id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <label className="block">
      {label && (
        <span className="block mono-caps text-[11px] text-textMuted mb-1.5">
          {label}
        </span>
      )}
      <input
        ref={ref}
        id={inputId}
        {...rest}
        className={`w-full h-9 bg-panelAlt border border-border text-text px-3 rounded-md font-mono text-[13px] placeholder:text-textFaint transition-[border-color,box-shadow] duration-150 focus:border-brass focus:outline-none focus:shadow-[0_0_0_3px_rgb(var(--brass-rgb)/0.16)] ${className}`}
      />
      {hint && (
        <span className="block mono-caps text-[10px] text-textFaint mt-1">
          {hint}
        </span>
      )}
    </label>
  );
});