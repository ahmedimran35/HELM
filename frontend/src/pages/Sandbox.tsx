// Sandbox — real per-user code execution (qm-parity P1).
//
// Layout:
//   - Left rail:  list of recent sandbox sessions (most recent first).
//                 "New session" button at the top.
//   - Main panel: the active session's terminal-style exec area, plus
//                 a file-browser sidebar that lists files in the
//                 session's working directory.
//
// Every exec call returns: stdout, stderr, exit_code, duration_ms. We
// render stderr with the `rust` token, exit != 0 with a small badge,
// and stdout plain. File-browser reads the live on-disk tree (which
// catches files created by exec, not just files written via the API).
//
// Safety note shown to the user: no network egress filter, exec runs
// as the API user with a hard timeout. Documented in the page header.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import {
  PlayIcon,
  StopIcon,
  PlusIcon,
  TrashIcon,
  RefreshIcon,
  TerminalIcon,
  FileTextIcon,
  ChevronRightIcon,
  ClockIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface SandboxSession {
  id: string;
  user_id: string;
  panel_id: string | null;
  mode: "shell" | "repl";
  cwd: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  bytes_written: number;
  bytes_read: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  session_id: string;
}

interface ExecEntry {
  id: string;
  cmd: string;
  result: ExecResult | null;
  pending: boolean;
  error: string | null;
}

interface FileRow {
  path: string;
  size: number;
  mtime: string;
}

const MAX_HISTORY = 50;

export function SandboxPage() {
  const [sessions, setSessions] = useState<SandboxSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const rows = await apiGet<SandboxSession[]>("/sandbox/sessions");
      setSessions(rows);
      if (!activeId && rows.length > 0 && !rows[0]!.ended_at) {
        setActiveId(rows[0]!.id);
      }
    } catch {
      /* swallow — page-level error handled in card */
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  async function newSession() {
    const created = await apiPost<SandboxSession>("/sandbox/sessions", {
      mode: "shell",
    });
    setSessions((cur) => [created, ...cur]);
    setActiveId(created.id);
  }

  async function endSession(id: string) {
    await apiPost(`/sandbox/sessions/${id}/end`, {});
    setSessions((cur) =>
      cur.map((s) => (s.id === id ? { ...s, ended_at: new Date().toISOString() } : s)),
    );
  }

  return (
    <div className="h-full flex">
      {/* Left rail: sessions */}
      <aside className="w-[260px] shrink-0 border-r border-border bg-panel flex flex-col">
        <div className="px-4 py-3 border-b border-borderSoft flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TerminalIcon size={14} className="text-brass" />
            <span className="mono-caps text-[11px] text-text">Sessions</span>
          </div>
          <Button variant="primary" size="sm" onClick={newSession} title="Start a new shell session">
            <PlusIcon size={12} /> New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-6 mono-caps text-[11px] text-textFaint">
              loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-4 py-6 mono-caps text-[11px] text-textFaint">
              no sessions yet
            </div>
          ) : (
            sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                active={s.id === activeId}
                onClick={() => setActiveId(s.id)}
                onEnd={() => endSession(s.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* Main area */}
      <main className="flex-1 min-w-0 flex flex-col">
        {active ? (
          <ActiveSession
            key={active.id}
            session={active}
            onSessionEnded={() => {
              setSessions((cur) =>
                cur.map((s) =>
                  s.id === active.id
                    ? { ...s, ended_at: new Date().toISOString() }
                    : s,
                ),
              );
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-bg">
            <EmptyState
              variant="gear"
              title="No active session"
              description="Start a new shell session from the left rail. Each session gets its own working directory, timeout, and audit log."
              action={
                <Button variant="primary" onClick={newSession}>
                  <PlusIcon size={12} /> New session
                </Button>
              }
            />
          </div>
        )}
      </main>
    </div>
  );
}

function SessionCard({
  session,
  active,
  onClick,
  onEnd,
}: {
  session: SandboxSession;
  active: boolean;
  onClick: () => void;
  onEnd: () => void;
}) {
  const ended = !!session.ended_at;
  const state: "healthy" | "idle" | "degraded" = ended ? "idle" : "healthy";
  const label = ended ? "ended" : "running";
  const started = new Date(session.started_at);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKey}
      className={cn(
        "w-full text-left px-3 py-2 border-l-2 border-b border-b-borderSoft transition-colors flex flex-col gap-1 cursor-pointer",
        active
          ? "bg-panelAlt border-l-brass"
          : "border-l-transparent hover:bg-panelAlt/60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[12px] text-text truncate">
          {session.id.slice(0, 8)}
        </span>
        <StatusPill state={state} label={label} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono-caps text-[10px] text-textMuted">{session.mode}</span>
        <span className="mono-caps text-[10px] text-textFaint inline-flex items-center gap-1">
          <ClockIcon size={10} />
          {timeAgo(started)}
        </span>
      </div>
      {!ended && (
        <div className="flex justify-end">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEnd();
            }}
            className="mono-caps text-[10px] text-textMuted hover:text-rust"
          >
            end
          </button>
        </div>
      )}
    </div>
  );
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ============================================================================
// Active session view
// ============================================================================
function ActiveSession({
  session,
  onSessionEnded,
}: {
  session: SandboxSession;
  onSessionEnded: () => void;
}) {
  const { addToast } = useToast();
  const [history, setHistory] = useState<ExecEntry[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ended = !!session.ended_at;

  // Load the file tree whenever we switch sessions.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ root: string; files: FileRow[] }>(
      `/sandbox/sessions/${session.id}/tree`,
    )
      .then((r) => {
        if (!cancelled) {
          setFiles(r.files);
          setActiveFile(null);
          setActiveFileContent("");
        }
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  // Auto-scroll the output to the bottom when entries change.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history.length, running]);

  async function refreshTree() {
    const r = await apiGet<{ root: string; files: FileRow[] }>(
      `/sandbox/sessions/${session.id}/tree`,
    );
    setFiles(r.files);
  }

  async function pickFile(path: string) {
    setActiveFile(path);
    try {
      const res = await fetch(
        `/api/sandbox/sessions/${session.id}/raw?path=${encodeURIComponent(path)}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setActiveFileContent(`(could not read file: ${res.status})`);
        return;
      }
      const text = await res.text();
      // Cap UI render at 200KB so the page doesn't blow up on huge files.
      setActiveFileContent(
        text.length > 200_000
          ? text.slice(0, 200_000) + "\n…(truncated)…"
          : text,
      );
    } catch (err) {
      setActiveFileContent(`(error: ${(err as Error).message})`);
    }
  }

  async function run() {
    const c = cmd.trim();
    if (!c || running || ended) return;
    const entryId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const placeholder: ExecEntry = { id: entryId, cmd: c, result: null, pending: true, error: null };
    setHistory((cur) => [...cur, placeholder].slice(-MAX_HISTORY));
    setCmd("");
    setRunning(true);
    try {
      const res = await apiPost<ExecResult>(`/sandbox/sessions/${session.id}/exec`, {
        cmd: c,
        timeout_ms: 30_000,
      });
      setHistory((cur) =>
        cur.map((e) =>
          e.id === entryId
            ? { ...e, result: res, pending: false }
            : e,
        ),
      );
    } catch (err) {
      const msg = (err as Error).message ?? "exec failed";
      setHistory((cur) =>
        cur.map((e) =>
          e.id === entryId
            ? { ...e, pending: false, error: msg }
            : e,
        ),
      );
      addToast({
        id: `sandbox-exec-${entryId}`,
        title: "Exec failed",
        description: msg,
        tone: "warning",
        duration: 4000,
      });
    } finally {
      setRunning(false);
      // After every exec, refresh the file tree in case the command
      // wrote to disk (e.g. `python foo.py > out.csv`).
      refreshTree().catch(() => {});
    }
  }

  async function endSession() {
    await apiPost(`/sandbox/sessions/${session.id}/end`, {});
    onSessionEnded();
    addToast({
      id: `sandbox-end-${session.id}`,
      title: "Session ended",
      description: "Working directory freed.",
      tone: "info",
      duration: 3000,
    });
  }

  function clear() {
    setHistory([]);
  }

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Terminal column */}
      <div className="flex-1 min-w-0 flex flex-col bg-bg">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-panel flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono text-[13px] text-text truncate">
              {session.id.slice(0, 8)}
            </span>
            <Badge tone={ended ? "neutral" : "teal"}>
              {ended ? "ended" : session.mode}
            </Badge>
            <span className="mono-caps text-[10px] text-textFaint truncate">
              cwd: {shortPath(session.cwd)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={clear} disabled={history.length === 0}>
              clear
            </Button>
            {!ended && (
              <Button variant="danger" size="sm" onClick={endSession}>
                <StopIcon size={12} /> End
              </Button>
            )}
          </div>
        </div>

        {/* Output */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-[13px] leading-[1.5]"
        >
          {history.length === 0 ? (
            <div className="text-textFaint">
              <span className="text-brass">$</span> ready — type a command below.
              <div className="mt-3 text-textMuted">
                <div>· hard timeout: 30s (override up to 5min via timeout_ms)</div>
                <div>· 256KB stdout/stderr cap per command</div>
                <div>· commands run with cwd pinned to your sandbox directory</div>
                <div>· no network egress filter today — sandbox is best-effort isolation</div>
              </div>
            </div>
          ) : (
            history.map((e) => <ExecBlock key={e.id} entry={e} />)
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            run();
          }}
          className="border-t border-border bg-panel px-4 py-3 flex items-center gap-2"
        >
          <span className="font-mono text-[13px] text-brass">$</span>
          <Input
            ref={inputRef}
            name="cmd"
            placeholder={ended ? "session ended" : "exec command (e.g. ls -la, python -c 'print(2+2)')"}
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            disabled={running || ended}
            className="flex-1 font-mono"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!cmd.trim() || running || ended}
          >
            {running ? (
              <span className="mono-caps text-[11px]">running…</span>
            ) : (
              <>
                <PlayIcon size={12} /> Run
              </>
            )}
          </Button>
        </form>
      </div>

      {/* File sidebar */}
      <aside className="w-[280px] shrink-0 border-l border-border bg-panel flex flex-col">
        <div className="px-4 py-3 border-b border-borderSoft flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileTextIcon size={14} className="text-brass" />
            <span className="mono-caps text-[11px] text-text">Files</span>
          </div>
          <button
            onClick={() => refreshTree().catch(() => {})}
            title="refresh file tree"
            className="text-textMuted hover:text-text"
          >
            <RefreshIcon size={12} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {files.length === 0 ? (
            <div className="px-4 py-6 mono-caps text-[11px] text-textFaint">
              working directory empty
            </div>
          ) : (
            <ul>
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => pickFile(f.path)}
                    className={cn(
                      "w-full text-left px-3 py-1.5 border-l-2 flex items-center gap-2 transition-colors",
                      activeFile === f.path
                        ? "border-l-brass bg-panelAlt text-text"
                        : "border-l-transparent text-textMuted hover:bg-panelAlt/60 hover:text-text",
                    )}
                  >
                    <ChevronRightIcon size={10} className="shrink-0" />
                    <span className="font-mono text-[12px] truncate flex-1">{f.path}</span>
                    <span className="mono-caps text-[10px] text-textFaint tabular-nums">
                      {formatBytes(f.size)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {activeFile && (
          <div className="border-t border-borderSoft bg-bg max-h-[40%] flex flex-col">
            <div className="px-3 py-2 border-b border-borderSoft flex items-center justify-between">
              <span className="mono-caps text-[10px] text-text truncate">
                {activeFile}
              </span>
              <button
                onClick={() => {
                  setActiveFile(null);
                  setActiveFileContent("");
                }}
                className="text-textFaint hover:text-text"
                title="close preview"
              >
                <TrashIcon size={12} />
              </button>
            </div>
            <pre className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[12px] text-text whitespace-pre-wrap break-words">
              {activeFileContent || "(empty)"}
            </pre>
          </div>
        )}
      </aside>
    </div>
  );
}

function ExecBlock({ entry }: { entry: ExecEntry }) {
  const { cmd, pending, result, error } = entry;
  if (pending) {
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2 text-brass">
          <span>$</span>
          <span className="text-text">{cmd}</span>
          <span className="mono-caps text-[10px] text-textFaint ml-auto">running…</span>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <span className="text-brass">$</span>
          <span className="text-text">{cmd}</span>
          <Badge tone="rust">error</Badge>
        </div>
        <pre className="mt-1 text-rust whitespace-pre-wrap break-words">{error}</pre>
      </div>
    );
  }
  if (!result) return null;
  const ok = result.exit_code === 0 && !result.timed_out;
  const truncated = result.stdout_truncated || result.stderr_truncated;
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-brass">$</span>
        <span className="text-text">{cmd}</span>
        {result.timed_out ? (
          <Badge tone="rust">timed out</Badge>
        ) : ok ? (
          <Badge tone="teal">exit 0</Badge>
        ) : (
          <Badge tone="rust">exit {result.exit_code}</Badge>
        )}
        <span className="mono-caps text-[10px] text-textFaint ml-auto">
          {result.duration_ms}ms
        </span>
      </div>
      {result.stdout && (
        <pre className="mt-1 text-text whitespace-pre-wrap break-words bg-bg/50">
          {result.stdout}
        </pre>
      )}
      {result.stderr && (
        <pre className="mt-1 text-rust whitespace-pre-wrap break-words">
          {result.stderr}
        </pre>
      )}
      {!result.stdout && !result.stderr && (
        <pre className="mt-1 text-textFaint italic">(no output)</pre>
      )}
      {truncated && (
        <div className="mt-1 mono-caps text-[10px] text-textFaint">
          output truncated at 512KB
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function shortPath(p: string): string {
  // Show the last two path components to keep the header tidy.
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}
