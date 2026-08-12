import type { Config } from "tailwindcss";

// Design tokens come straight from CwLab-project-docs.md §1. Every colour is
// referenced by name in CSS / TSX, never by hex inline, so re-skinning is a
// single-file change. The actual values come from CSS variables defined
// in src/styles/index.css so light/dark theming works via `data-theme` on
// the <html> element without a rebuild.

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Each color is `rgb(var(--X-rgb) / <alpha-value>)` so Tailwind
        // emits a runtime-resolved rule (not an inlined hex). Switching
        // the `data-theme` attribute on <html> swaps every value at
        // once. This is the standard Tailwind 3 pattern for CSS-var
        // theme tokens.
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        panel: "rgb(var(--panel-rgb) / <alpha-value>)",
        panelAlt: "rgb(var(--panelAlt-rgb) / <alpha-value>)",
        border: "rgb(var(--border-rgb) / <alpha-value>)",
        borderSoft: "rgb(var(--borderSoft-rgb) / <alpha-value>)",
        text: "rgb(var(--text-rgb) / <alpha-value>)",
        textMuted: "rgb(var(--textMuted-rgb) / <alpha-value>)",
        textFaint: "rgb(var(--textFaint-rgb) / <alpha-value>)",
        brass: "rgb(var(--brass-rgb) / <alpha-value>)",
        brassSoft: "rgb(var(--brassSoft-rgb) / <alpha-value>)",
        teal: "rgb(var(--teal-rgb) / <alpha-value>)",
        rust: "rgb(var(--rust-rgb) / <alpha-value>)",
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        base: ["14px", { lineHeight: "20px" }],
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
    },
  },
  corePlugins: {
    preflight: true,
  },
  plugins: [],
};

export default config;