// Theme-aware SVG fill/stroke tokens for the workflow editor.
//
// Workflow canvas SVGs need explicit hex fills (SVGs don't inherit
// CSS variables inside attributes). This module exports a function
// that returns the correct hex values for the current theme, keeping
// every SVG in sync with the CSS-variable palette.

import { useTheme } from "../../theme/ThemeProvider";

interface ThemeTokens {
  bg: string; panel: string; panelAlt: string; border: string; borderSoft: string;
  text: string; textMuted: string; textFaint: string;
  brass: string; brassSoft: string; brassDark: string;
  teal: string; tealDark: string; rust: string; rustDark: string;
  blue: string; purple: string; gray: string;
  shadow: string; minimapBg: string;
}

const dark: ThemeTokens = {
  bg: "#0e1222", panel: "#1e2642", panelAlt: "#14192c",
  border: "#445480", borderSoft: "#344062",
  text: "#e6ebf8", textMuted: "#96a5cd", textFaint: "#8291be",
  brass: "#ffcd32", brassSoft: "#c8a528", brassDark: "#967a18",
  teal: "#50dcc3", tealDark: "#36bba3",
  rust: "#f57855", rustDark: "#d85f40",
  blue: "#6aa8f0", purple: "#a987f0", gray: "#8794b2",
  shadow: "rgba(0,0,0,0.55)", minimapBg: "#0a0d18",
};

const light: ThemeTokens = {
  bg: "#f0ece4", panel: "#ffffff", panelAlt: "#e8e2d8",
  border: "#c3bcae", borderSoft: "#dad4ca",
  text: "#161412", textMuted: "#4b463e", textFaint: "#6a6357",
  brass: "#915c0a", brassSoft: "#c39123", brassDark: "#7a4e08",
  teal: "#1c735c", tealDark: "#175e4c",
  rust: "#af3c1e", rustDark: "#963017",
  blue: "#3f73a8", purple: "#7650a8", gray: "#6b665e",
  shadow: "rgba(22,20,18,0.10)", minimapBg: "#e4ddd2",
};

export type ThemeColors = ThemeTokens;

export function useSvgTheme(): ThemeTokens {
  const { theme } = useTheme();
  return theme === "dark" ? dark : light;
}

export function getSvgTheme(theme: "light" | "dark"): ThemeTokens {
  return theme === "dark" ? dark : light;
}
