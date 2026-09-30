// AppFrame — the React wrapper around an embedded HELM app.
//
// Architecture:
//   The app itself lives at /apps/:slug/?install=<uuid>, served as a
//   static bundle by the backend. We host it inside a sandboxed iframe
//   pointed at /apps-embed?slug=…&install=…&embedded=1 — the embed
//   page provides its own chrome when visited standalone, and hides it
//   here so this React-managed header is the only chrome the user sees.
//
// The iframe runs the app's own scripts and exposes window.helmApp
// (the SDK injected by the bundle server). The SDK posts messages to
// the parent for navigation, theming, and toasts; we listen for those
// here and:
//   - forward `helm:toast` messages into the React ToastProvider
//   - treat `helm:ready` as "the iframe is alive" and hide the loader
//   - forward `helm:navigate` requests to the router so the SPA moves
//
// The host page composes AppFrame with its own close handler — e.g.
// "close" pops the router back to the My Apps list. We don't know the
// page above us, so the parent passes `onClose` as a prop.
//
// Usage:
//
//   <AppFrame
//     slug="hello-app"
//     install="00000000-…"
//     appName="Hello App"
//     onClose={() => navigate('/apps')}
//   />

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XIcon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { useToast } from "../ui/feedback/Toast";

interface AppFrameProps {
  /** App slug — matches /apps/:slug/ when the slug aligns with the bundle
   *  directory. Ignored if `bundleUrl` is provided. */
  slug: string;
  /** Install id; required for apps that read/write per-install data. */
  install: string;
  /** Display name shown in the chrome. Falls back to a title-cased slug. */
  appName?: string;
  /**
   * Optional override for the bundle location. The catalog stores
   * `bundle_url` separately from the slug (e.g. an app whose slug is
   * "standup" but whose bundle is served at `/apps/standup-app/`).
   * When set, the embed iframe is pointed at this URL directly.
   */
  bundleUrl?: string | null;
  /**
   * Called when the user clicks the close button. The host page is
   * responsible for actually navigating back to wherever they came
   * from. We don't pop history ourselves — that would surprise users
   * who arrived at this frame via a deep link.
   */
  onClose: () => void;
}

// Incoming postMessage types from the embedded app bundle (via the SDK).
type InboundMessage =
  | { type: "helm:ready"; name?: string; version?: string }
  | { type: "helm:context"; theme?: string; install?: { id: string } }
  | { type: "helm:install"; install?: { id: string } }
  | { type: "helm:theme"; theme: string }
  | { type: "helm:toast"; title?: string; description?: string; tone?: string; duration?: number }
  | { type: "helm:navigate"; path: string }
  // SDK calls the host for privileged API access (no allow-same-origin).
  | { type: "helm:api"; id: string; method: string; path: string; body?: unknown }
  | { type: "helm:app-data"; id: string; op: "get" | "set" | "del" | "list"; key?: string; value?: unknown }
  | { type: string; [k: string]: unknown };

// SECURITY: the helm:api bridge runs with the HOST user's session cookie
// (credentials: "include"), so it is a privilege boundary. A bundle is
// untrusted code — it must NOT be able to reach admin/user-mutating
// endpoints (POST /api/users, DELETE /api/providers/:id, …) or read
// another user's data. We therefore enforce a strict DENY-BY-DEFAULT
// allowlist: only read-only, self-scoped endpoints are reachable, and
// only via GET (POST/PUT/PATCH/DELETE are rejected outright). Anything
// not matched here is refused before a request is ever issued.
//
// The allowlist is deliberately narrow. If a future app legitimately
// needs a mutating call, that scope must be granted explicitly on the
// install (granted_scopes) and wired through here — never by widening
// this list. Module-scoped so it is a stable reference (no re-render
// churn, no useCallback dependency).
const APP_API_ALLOWLIST: Array<{ method: "GET"; test: (path: string) => boolean }> = [
  // Per-install data is handled by handleAppDataRequest, not callAPI,
  // but allow the raw GET form for parity.
  { method: "GET", test: (p) => /^\/api\/app-data\/[0-9a-f-]{36}\/[^/]+$/.test(p) },
  // Panels the user belongs to (read-only listing + messages).
  { method: "GET", test: (p) => /^\/api\/panels$/.test(p) },
  { method: "GET", test: (p) => /^\/api\/panels\/[0-9a-f-]{36}$/.test(p) },
  { method: "GET", test: (p) => /^\/api\/panels\/[0-9a-f-]{36}\/messages$/.test(p) },
  // Self identity + usable models (read-only, self-scoped).
  { method: "GET", test: (p) => /^\/api\/me$/.test(p) },
  { method: "GET", test: (p) => /^\/api\/models$/.test(p) },
  { method: "GET", test: (p) => /^\/api\/users\/me$/.test(p) },
  // App catalog (read-only).
  { method: "GET", test: (p) => /^\/api\/apps$/.test(p) },
  { method: "GET", test: (p) => /^\/api\/apps\/[a-z0-9][a-z0-9-]{0,62}$/.test(p) },
];

export function AppFrame({ slug, install, appName, bundleUrl, onClose }: AppFrameProps) {
  const { addToast } = useToast();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // We mount once; if slug/install change, we remount via key.
  const mountedKey = useMemo(() => `${slug}:${install}:${bundleUrl ?? ""}`, [slug, install, bundleUrl]);

  // Pretty-print the app name from the slug when the caller didn't
  // supply a label.
  const displayName = appName || slug
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

  const src = useMemo(() => {
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("install", install);
    if (bundleUrl) params.set("bundle", bundleUrl);
    params.set("embedded", "1");
    return `/apps-embed?${params.toString()}`;
  }, [slug, install, bundleUrl]);

// Type guards for the message union.
  function isApiMessage(msg: InboundMessage): msg is Extract<InboundMessage, { type: "helm:api" }> {
    return msg.type === "helm:api";
  }
  function isAppDataMessage(msg: InboundMessage): msg is Extract<InboundMessage, { type: "helm:app-data" }> {
    return msg.type === "helm:app-data";
  }
  // Proxy an authenticated /api/* request from the sandboxed app.
  // (Allowlist lives at module scope — see APP_API_ALLOWLIST above.)
  const handleApiRequest = useCallback(
    async (msg: Extract<InboundMessage, { type: "helm:api" }>) => {
      const { id, method, path } = msg;
      // Normalise the path (strip query string) so the allowlist matches
      // the route, not the query.
      let pathname = "";
      try {
        pathname = new URL(path, window.location.origin).pathname;
      } catch {
        pathname = "";
      }
      if (
        typeof path !== "string" ||
        !pathname.startsWith("/api/") ||
        method !== "GET" ||
        !APP_API_ALLOWLIST.some((rule) => rule.method === method && rule.test(pathname))
      ) {
        postResponse(id, 403, { error: "forbidden_api_path_or_method" });
        return;
      }
      try {
        // Fetch the validated pathname only — never the raw app-supplied
        // string, which could carry a query or fragment we did not vet.
        const res = await fetch(pathname, {
          method,
          credentials: "include",
          headers: {
            Accept: "application/json",
          },
        });
        const text = await res.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        postResponse(id, res.status, parsed);
      } catch (err) {
        postResponse(id, 502, { error: "api_proxy_failed", detail: String(err) });
      }
    },
    [],
  );

  // Proxy per-install app-data CRUD.
  const handleAppDataRequest = useCallback(
    async (msg: Extract<InboundMessage, { type: "helm:app-data" }>) => {
      const { id, op, key, value } = msg;
      if (!key || typeof key !== "string") {
        postResponse(id, 400, { error: "key_required" });
        return;
      }
      try {
        let path = `/api/app-data/${encodeURIComponent(install)}/${encodeURIComponent(key)}`;
        let method: string;
        let body: string | undefined;
        switch (op) {
          case "get":
            method = "GET";
            break;
          case "set":
            method = "POST";
            body = JSON.stringify({ value });
            break;
          case "del":
            method = "DELETE";
            break;
          case "list":
            path = `/api/app-data/${encodeURIComponent(install)}`;
            method = "GET";
            break;
          default:
            postResponse(id, 400, { error: "unknown_op" });
            return;
        }
        const res = await fetch(path, {
          method,
          credentials: "include",
          headers: {
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body,
        });
        const text = await res.text();
        let parsed: unknown = null;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }
        postResponse(id, res.status, parsed);
      } catch (err) {
        postResponse(id, 502, { error: "app_data_proxy_failed", detail: String(err) });
      }
    },
    [install],
  );

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      // We only accept messages from the iframe we own.
      if (ev.source !== iframeRef.current?.contentWindow) return;

      const data = ev.data as InboundMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") {
        return;
      }

      switch (data.type) {
        case "helm:ready": {
          setReady(true);
          setError(null);
          // Push fresh context to the iframe.
          try {
            const w = iframeRef.current?.contentWindow;
            if (w) {
              w.postMessage(
                {
                  type: "helm:context",
                  theme: currentThemeRef.current,
                  install: { id: install },
                },
                "*", // iframe is opaque origin; "*" is the only option
              );
            }
          } catch {
            /* ignore */
          }
          break;
        }
        case "helm:toast": {
          const title = typeof data.title === "string" ? data.title : "";
          const description =
            typeof data.description === "string" ? data.description : undefined;
          const tone: "info" | "success" | "warning" =
            data.tone === "success" || data.tone === "warning"
              ? data.tone
              : "info";
          addToast({
            id: `app-${slug}-${install}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title,
            description,
            tone,
            duration: typeof data.duration === "number" ? data.duration : 4000,
          });
          break;
        }
        case "helm:navigate": {
          if (
            typeof data.path === "string" &&
            data.path.length > 0 &&
            data.path.length < 256 &&
            /^\/[A-Za-z0-9_\-/.?&=]*$/.test(data.path)
          ) {
            window.dispatchEvent(
              new CustomEvent("helm:app-navigate", { detail: { path: data.path, slug } }),
            );
          }
          break;
        }
        default: {
          if (isApiMessage(data)) {
            handleApiRequest(data);
          } else if (isAppDataMessage(data)) {
            handleAppDataRequest(data);
          }
          // "helm:context", "helm:install", "helm:theme" are informational; ignore.
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug, install, addToast, handleApiRequest, handleAppDataRequest]);

  // If the iframe doesn't signal "ready" within a reasonable timeout,
  // surface an error so the user isn't staring at a spinner forever.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => {
      setError((cur) => cur ?? "App did not finish loading. Check the bundle URL or the server logs.");
    }, 12_000);
    return () => clearTimeout(t);
  }, [ready, mountedKey]);

  // Push our current theme down to the iframe on load. We use a ref so
  // the message handler can read the latest value without re-binding.
  const currentThemeRef = useRef<string>("dark");
  useEffect(() => {
    const dt = document.documentElement.getAttribute("data-theme");
    if (dt === "light" || dt === "dark") currentThemeRef.current = dt;
    function onTheme(ev: Event) {
      const next = (ev as CustomEvent<{ theme: string }>).detail?.theme;
      if (next === "light" || next === "dark") {
        currentThemeRef.current = next;
        try {
          const w = iframeRef.current?.contentWindow;
          if (w) {
            // Use the iframe's exact origin, not "*". The iframe origin
            // matches the host's by construction (we set `src` ourselves)
            // and the explicit value is what the postMessage spec
            // requires — "*" would let a swapped iframe forward our
            // context to an unexpected origin.
            const iframeOrigin = w.location.origin || window.location.origin;
            w.postMessage(
              { type: "helm:context", theme: next, install: { id: install } },
              iframeOrigin,
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
    window.addEventListener("helm:theme", onTheme as EventListener);
    return () => window.removeEventListener("helm:theme", onTheme as EventListener);
  }, [install, mountedKey]);

  // When the iframe loads, push our context.
  const handleIframeLoad = useCallback(() => {
    try {
      const w = iframeRef.current?.contentWindow;
      if (w) {
        w.postMessage(
          {
            type: "helm:context",
            theme: currentThemeRef.current,
            install: { id: install },
          },
          "*",
        );
      }
    } catch {
      /* ignore */
    }
  }, [install]);


  function postResponse(id: string, status: number, body: unknown) {
    try {
      const w = iframeRef.current?.contentWindow;
      if (w) {
        w.postMessage(
          { type: "helm:api-response", id, status, body },
          "*",
        );
      }
    } catch {
      /* ignore */
    }
  }

  // The sandbox keeps the app honest: it can run scripts and post forms
  // back to itself, but cannot navigate the top window or open popups.
  // `allow-same-origin` is REMOVED — without it, the iframe gets an
  // opaque origin and cannot access the parent's DOM, localStorage,
  // cookies, or make same-origin fetch calls. The SDK communicates
  // via postMessage to a privileged bridge in this component (see
  // handleApiRequest / handleAppDataRequest) for scoped /api/* access.
  const sandbox = "allow-scripts allow-forms";

  return (
    <div key={mountedKey} className="flex flex-col h-full bg-bg" data-app-frame={slug}>
      <header className="flex items-center gap-3 h-10 px-4 bg-panel border-b border-border flex-shrink-0">
        <span className="mono-caps text-[10px] tracking-wider text-brass">
          APP
        </span>
        <span className="font-medium text-[13px] text-text truncate">{displayName}</span>
        <span className="text-textFaint text-[11px] mono-caps tracking-wider">
          {slug}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close app"
          data-testid="appframe-close"
        >
          <XIcon size={14} />
          close
        </Button>
      </header>

      <div className="relative flex-1 min-h-0">
        {!ready && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-bg z-10"
            data-testid="appframe-loader"
          >
            <span className="mono-caps text-[11px] text-textFaint tracking-wider">
              loading {slug}…
            </span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg z-10 p-6">
            <div className="border border-rust/40 bg-rust/10 text-rust px-4 py-3 max-w-md text-[12px]">
              <div className="mono-caps text-[10px] tracking-wider mb-1">
                app failed to load
              </div>
              <div>{error}</div>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          sandbox={sandbox}
          title={`${displayName} (HELM app)`}
          onLoad={handleIframeLoad}
          className="w-full h-full border-0 bg-bg"
          data-testid="appframe-iframe"
        />
      </div>
    </div>
  );
}
