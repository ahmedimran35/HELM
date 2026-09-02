// Inline theme bootstrap — runs BEFORE React mounts so the correct
// data-theme attribute is already on <html> for first paint. Without
// this, light-mode users see a flash of the dark default while the
// ThemeProvider's useEffect catches up after first render.
// Served as an external file (not inline) so the CSP can drop
// script-src 'unsafe-inline'.
(function () {
  try {
    var saved = window.localStorage.getItem("helm.theme");
    var theme = saved === "light" || saved === "dark" ? saved : "light";
    document.documentElement.setAttribute("data-theme", theme);
    // Clear any old A/B tester picks so the new defaults (warm-original
    // light, slate dark) stick. Future A/B tests can re-introduce the
    // helm.<theme>_bg localStorage key.
    window.localStorage.removeItem("helm.light_bg");
    window.localStorage.removeItem("helm.dark_bg");
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();