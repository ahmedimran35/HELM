// Frontend URL safety helper.
//
// Every `<a href={…} />` and `window.location.href = …` whose value
// comes from server data (citations, search results, LLM-emitted
// links, etc.) must go through `safeHref()` first. This rejects any
// scheme other than `http`, `https`, `mailto`, and a small set of
// internal SPA paths. The companion helper `safeWindowOpen(url)` is
// for `window.open(url, "_blank")`.
//
// Why this matters: the backend `Markdown` renderer already enforces
// `^(https?:|mailto:)` on link URLs, but the backend then echoes
// the same URL into JSON fields that the React layer reads back
// (`/api/chat/.../citations`, `/api/web-search`, OAuth install
// callbacks, etc.). One missed filter downstream of the Markdown
// renderer is enough to surface a `javascript:…` or `data:text/html`
// URL straight into a React component — where it would fire on click
// via the `javascript:` protocol.
//
// We anchor the regex to the END of the protocol and strip control
// characters. The return is the original URL when it's safe, or "#"
// (a no-op) otherwise.

const SAFE_PROTOCOL = /^(https?|mailto):/i;
const SAFE_PATH = /^\/(?![\/\\])/; // internal SPA path, no leading slash traversal

export function isSafeHref(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (/[\x00-\x1f\x7f]/.test(url)) return false;
  // Reject the schemes the browser will execute script from. This is
  // the canonical allow-list per the WHATWG URL spec.
  if (/^\s*javascript:/i.test(url)) return false;
  if (/^\s*data:(?!image\/(png|jpe?g|gif|webp|svg\+xml);,)/i.test(url)) return false;
  if (/^\s*vbscript:/i.test(url)) return false;
  if (/^\s*file:/i.test(url)) return false;
  // Allow http(s) / mailto / fragment / internal SPA path.
  if (/^\s*(https?|mailto):/i.test(url)) return true;
  if (/^\s*#/.test(url)) return true; // in-document anchor
  if (SAFE_PATH.test(url)) return true;
  return false;
}

/** Coerce an arbitrary URL string into one safe to render as `<a href>`.
 *  Returns "#" for unsafe inputs. */
export function safeHref(url: unknown): string {
  return isSafeHref(url) ? String(url) : "#";
}

/** Coerce an arbitrary URL for `window.open(url, "_blank")`. */
export function safeWindowOpen(url: unknown): string {
  return isSafeHref(url) ? String(url) : "about:blank";
}

/** Same but for `window.location.href = …`. */
export function safeLocationHref(url: unknown): string {
  return isSafeHref(url) ? String(url) : "/";
}
