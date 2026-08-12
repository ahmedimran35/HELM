// BrowserAutomation — small SideSheet for driving the headless
// browser. The user enters a URL, records a series of actions
// (click / fill / extract / wait), and the result renders inline in
// the chat with a screenshot URL.
//
// The chat page passes a callback that receives the result object
// so the message bubble can render the screenshot + extracted text.
//
//   POST /api/browser/exec →
//     {
//       finalUrl, title,
//       extracted: { [selector]: string[] },
//       screenshot: "<scope>/<ts>.png" | null,
//       duration_ms, stub?, reason?,
//     }
//
// Screenshots are fetched via GET /api/browser/screenshots/<scope>/<file>.
// We build the URL from the current user scope (no panelId).

import { useCallback, useEffect, useState } from "react";
import { useToast } from "../ui/feedback/Toast";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/feedback/Skeleton";
import { GlobeIcon, PlusIcon, TrashIcon, PlayIcon } from "../ui/Icon";
import { cn } from "../../lib/cn";

export type BrowserActionKind = "click" | "fill" | "extract" | "wait";

export interface BrowserAction {
  type: BrowserActionKind;
  selector?: string;
  value?: string;
  attr?: string;
  ms?: number;
}

export interface BrowserResult {
  finalUrl: string;
  title: string;
  extracted: Record<string, string[]>;
  screenshot: string | null;
  duration_ms: number;
  stub?: boolean;
  reason?: string;
}

interface Props {
  panelId?: string;
  open: boolean;
  onClose?: () => void;
  /** Called with the result object after a successful exec. */
  onResult?: (result: BrowserResult, url: string) => void;
}

const ACTION_KINDS: { kind: BrowserActionKind; label: string; needs: ("selector" | "value" | "attr" | "ms")[] }[] = [
  { kind: "click", label: "Click", needs: ["selector"] },
  { kind: "fill", label: "Fill", needs: ["selector", "value"] },
  { kind: "extract", label: "Extract", needs: ["selector"] },
  { kind: "wait", label: "Wait", needs: [] },
];

export function BrowserAutomation({ panelId, open, onClose, onResult }: Props) {
  const [url, setUrl] = useState("");
  const [actions, setActions] = useState<BrowserAction[]>([
    { type: "extract", selector: "h1" },
  ]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BrowserResult | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    fetch("/api/browser/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { available?: boolean }) => setAvailable(Boolean(d.available)))
      .catch(() => setAvailable(false));
  }, [open]);

  const addAction = useCallback((kind: BrowserActionKind) => {
    setActions((prev) => [
      ...prev,
      kind === "wait"
        ? { type: "wait", ms: 500 }
        : kind === "extract"
          ? { type: "extract", selector: "" }
          : kind === "fill"
            ? { type: "fill", selector: "", value: "" }
            : { type: "click", selector: "" },
    ]);
  }, []);

  const updateAction = useCallback((idx: number, patch: Partial<BrowserAction>) => {
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }, []);

  const removeAction = useCallback((idx: number) => {
    setActions((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const run = useCallback(async () => {
    if (!url.trim()) {
      toast.addToast({
        id: "br-no-url",
        title: "URL required",
        description: "Enter a URL to browse.",
        tone: "warning",
      });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/browser/exec", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          actions: actions.filter((a) => a.type !== "wait" || (a.ms && a.ms > 0)),
          panel_id: panelId || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `browser exec failed (${res.status})`);
      }
      const data = (await res.json()) as BrowserResult;
      setResult(data);
      onResult?.(data, url.trim());
      if (data.stub) {
        toast.addToast({
          id: "br-stub",
          title: "Browser stubbed",
          description: data.reason ?? "Playwright isn't installed on the server.",
          tone: "warning",
        });
      } else {
        toast.addToast({
          id: "br-ok",
          title: "Browser run complete",
          description: `${(data.duration_ms / 1000).toFixed(1)}s · ${Object.keys(data.extracted).length} extracts`,
          tone: "success",
        });
      }
    } catch (err) {
      toast.addToast({
        id: "br-err",
        title: "Browser exec failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setRunning(false);
    }
  }, [url, actions, panelId, onResult, toast]);

  if (!open) return null;
  const scope = panelId ? `panel-${panelId}` : `user-self`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="w-[640px] max-w-[95vw] max-h-[90vh] bg-panel border border-border shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-borderSoft">
          <div className="flex items-center gap-2">
            <GlobeIcon size={14} className="text-brass" />
            <span className="font-display text-[13px] text-text">Browse the web</span>
            {available === false && (
              <span className="mono-caps text-[10px] text-rust border border-rust/40 px-1.5">
                playwright unavailable
              </span>
            )}
            {available === true && (
              <span className="mono-caps text-[10px] text-teal border border-teal/40 px-1.5">
                ready
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-textFaint hover:text-text p-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-3 py-2 border-b border-borderSoft flex items-center gap-2">
          <span className="mono-caps text-[10px] text-textFaint w-12">URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="flex-1 bg-panelAlt border border-border text-text px-2 py-1 font-mono text-[12px] focus:border-brass outline-none"
          />
          <Button variant="primary" onClick={run} disabled={running}>
            <PlayIcon size={12} />
            {running ? "Running…" : "Run"}
          </Button>
        </div>

        <div className="px-3 py-2 flex-1 overflow-y-auto space-y-1.5">
          <div className="mono-caps text-[10px] text-textFaint">actions</div>
          {actions.map((a, i) => (
            <div key={i} className="flex items-start gap-2 border border-borderSoft p-2 bg-panelAlt">
              <select
                value={a.type}
                onChange={(e) => updateAction(i, { type: e.target.value as BrowserActionKind })}
                className="bg-bg border border-border text-text px-1 py-1 font-mono text-[11px] outline-none"
              >
                {ACTION_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              {a.type === "wait" ? (
                <input
                  type="number"
                  value={a.ms ?? 0}
                  min={0}
                  step={100}
                  onChange={(e) => updateAction(i, { ms: Number(e.target.value) })}
                  placeholder="ms"
                  className="flex-1 bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] outline-none"
                />
              ) : (
                <>
                  <input
                    value={a.selector ?? ""}
                    onChange={(e) => updateAction(i, { selector: e.target.value })}
                    placeholder="selector"
                    className="flex-1 bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] outline-none"
                  />
                  {a.type === "fill" && (
                    <input
                      value={a.value ?? ""}
                      onChange={(e) => updateAction(i, { value: e.target.value })}
                      placeholder="value"
                      className="flex-1 bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] outline-none"
                    />
                  )}
                  {a.type === "extract" && (
                    <input
                      value={a.attr ?? ""}
                      onChange={(e) => updateAction(i, { attr: e.target.value })}
                      placeholder="attr (optional)"
                      className="flex-1 bg-bg border border-border text-text px-2 py-1 font-mono text-[12px] outline-none"
                    />
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => removeAction(i)}
                className="text-textFaint hover:text-rust"
                aria-label="Remove action"
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            {ACTION_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => addAction(k.kind)}
                className="inline-flex items-center gap-1 mono-caps text-[10px] text-textMuted border border-dashed border-borderSoft hover:border-brass hover:text-brass px-2 py-1 transition-colors"
              >
                <PlusIcon size={10} />
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {(running || result) && (
          <div className={cn("px-3 py-2 border-t border-borderSoft")}>
            {running && (
              <div className="space-y-1.5">
                <Skeleton variant="text" />
                <Skeleton variant="block" height={120} />
              </div>
            )}
            {result && !running && (
              <div className="space-y-2">
                {result.screenshot && (
                  <img
                    src={`/api/browser/screenshots/${scope}/${result.screenshot}`}
                    alt={result.title || "screenshot"}
                    className="w-full border border-borderSoft"
                  />
                )}
                {result.title && (
                  <div className="font-mono text-[12px] text-text">
                    {result.title}
                  </div>
                )}
                {Object.entries(result.extracted).map(([sel, values]) => (
                  <div key={sel} className="border border-borderSoft p-1.5 bg-panelAlt">
                    <div className="mono-caps text-[10px] text-textFaint">{sel}</div>
                    {values.length === 0 ? (
                      <div className="font-mono text-[12px] text-textMuted italic">
                        (no matches)
                      </div>
                    ) : (
                      <ul className="font-mono text-[12px] text-text">
                        {values.slice(0, 8).map((v, j) => (
                          <li key={j} className="truncate">{v}</li>
                        ))}
                        {values.length > 8 && (
                          <li className="text-textFaint">
                            + {values.length - 8} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
                <div className="mono-caps text-[10px] text-textFaint">
                  {(result.duration_ms / 1000).toFixed(1)}s · {result.finalUrl}
                  {result.stub && (
                    <span className="ml-2 text-rust">stub</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="px-3 py-2 border-t border-borderSoft flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}