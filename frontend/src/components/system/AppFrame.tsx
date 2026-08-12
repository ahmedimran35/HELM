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

type IframeMessage =
  | { type: "helm:ready"; name?: string; version?: string }
  | { type: "helm:context"; theme?: string; install?: { id: string } }
  | { type: "helm:install"; install?: { id: string } }
  | { type: "helm:theme"; theme: string }
  | { type: "helm:toast"; title?: string; description?: string; tone?: string; duration?: number }
  | { type: "helm:navigate"; path: string }
  | { type: string; [k: string]: unknown };

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

  // Listen for messages from the embedded iframe. We accept messages
  // from any origin because the iframe's contentWindow.origin is the
  // same as ours (/apps-embed is served by the same backend); we still
  // verify the shape so a hostile page can't crash our handler.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const data = ev.data as IframeMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") {
        return;
      }
      switch (data.type) {
        case "helm:ready":
          setReady(true);
          setError(null);
          // The iframe's SDK is up — re-push the latest context so
          // it has fresh theme + install info even if it missed our
          // initial load message (e.g. due to a slow first paint).
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
          break;
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
        case "helm:navigate":
          // The app wants to take the user somewhere else. We can't
          // know the host's router here — emit an event the page can
          // listen for. The default action for the page is to call
          // `window.location.href = path`, but the host can intercept
          // if it wants soft-navigation instead.
          if (typeof data.path === "string" && data.path.length > 0) {
            window.dispatchEvent(
              new CustomEvent("helm:app-navigate", { detail: { path: data.path, slug } }),
            );
          }
          break;
        case "helm:context":
        case "helm:install":
        case "helm:theme":
          // Informational; we don't need to act on these.
          break;
        default:
          // Ignore unknown messages.
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug, install, addToast]);

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
            w.postMessage(
              { type: "helm:context", theme: next, install: { id: install } },
              "*",
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

  // When the iframe loads, push our context. The embed HTML also pushes
  // its own context, but doing it again here is belt-and-braces for
  // any embed-page version that forgets.
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

  // The sandbox keeps the app honest: it can run scripts and post forms
  // back to itself, but cannot navigate the top window or open popups.
  // `allow-same-origin` is required for the SDK to make same-origin
  // fetch calls to /api/*.
  const sandbox = "allow-scripts allow-same-origin allow-forms";

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
