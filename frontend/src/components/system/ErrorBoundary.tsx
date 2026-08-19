// ErrorBoundary — top-level React error boundary. Catches any render-time
// error thrown in the tree beneath it and renders a calm fallback so the
// user sees a recoverable error instead of a white screen. The boundary
// is mounted around the entire <App /> in main.tsx so any error in routing,
// providers, or page render is captured — including errors from lazy
// chunks that fail to mount.
//
// Behaviour:
//   - On error: logs the full error + component stack to console for
//     debugging, sets local state so the fallback renders.
//   - Fallback UI: rust-tinted banner with the error message, plus two
//     actions — "Reload" (full page reload) and "Copy error" (puts the
//     message + stack on the clipboard so it can be pasted into a bug
//     report).
//   - Uses existing design tokens (text-rust, text-textMuted, bg-panel)
//     so the fallback matches the rest of the console.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log once to the browser console so the original stack is preserved
    // alongside the React component stack.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] unhandled render error:", error, info);
    this.setState({ info });
  }

  private handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  private handleCopy = async (): Promise<void> => {
    if (typeof navigator === "undefined") return;
    const { error, info } = this.state;
    const payload = [
      error?.message ?? "(no message)",
      error?.stack ?? "(no stack)",
      info?.componentStack ?? "(no component stack)",
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      // Clipboard can be blocked (insecure context, permission denied).
      // Swallow — the user can still reload and the error is logged.
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="h-full w-full flex items-center justify-center bg-bg p-6">
          <div className="max-w-[520px] w-full border border-rust/40 bg-panel p-5">
            <div className="mono-caps text-[11px] text-rust tracking-wider">
              error · render failed
            </div>
            <h2 className="mt-2 font-display text-[18px] text-text font-semibold leading-tight">
              Something went wrong.
            </h2>
            <p className="mt-1 text-[12px] text-textMuted leading-[1.5]">
              The interface hit an unexpected error and the page can't
              continue. Reload to recover, or copy the details below into
              a bug report.
            </p>
            <pre className="mt-3 p-3 border border-borderSoft bg-panelAlt text-[12px] text-textMuted overflow-auto max-h-[180px] whitespace-pre-wrap break-words">
              {error.message}
            </pre>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="bg-brass text-bg hover:bg-brass/90 active:bg-brassSoft border border-brass disabled:opacity-50 inline-flex items-center justify-center gap-2 font-medium mono-caps tracking-wider h-9 px-3.5 text-[13px]"
              >
                Reload
              </button>
              <button
                type="button"
                onClick={this.handleCopy}
                className="bg-panelAlt text-text border border-border hover:bg-panel hover:border-borderSoft disabled:opacity-50 inline-flex items-center justify-center gap-2 font-medium mono-caps tracking-wider h-9 px-3.5 text-[13px]"
              >
                Copy error
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
