// VoiceRecorder — MediaRecorder capture + upload (Tier 3).
//
// Mounted from the chat input toolbar. Click the mic to start
// recording (webm/opus when supported, audio/mp4 fallback for
// Safari). Click again to stop. While recording a small brass dot
// pulses and the elapsed seconds tick. On stop we POST the blob to
// /api/voice, surface the transcript (or a stub when Whisper isn't
// configured), and the parent decides whether to send / discard.
//
// Browser support notes:
//   - Chrome / Edge : webm/opus works.
//   - Firefox       : webm/opus works.
//   - Safari (macOS, iOS 14.1+): prefers mp4/aac. We probe via
//                      MediaRecorder.isTypeSupported and fall back
//                      gracefully if the browser refuses webm.
//   - iOS Safari has historically rejected MediaRecorder entirely —
//     we surface a clear error toast instead of silently no-op'ing.

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../ui/feedback/Toast";
import { Button } from "../ui/Button";
import {
  MicIcon,
  StopIcon,
  SendIcon,
  TrashIcon,
  RefreshIcon,
} from "../ui/Icon";
import { cn } from "../../lib/cn";

interface Props {
  panelId?: string;
  /** Called when the user confirms the transcript and wants to send it. */
  onTranscript?: (text: string, recordingId: string) => void;
  /** Called when the user clicks discard — close without sending. */
  onClose?: () => void;
  /** Render as a modal? When false the component renders inline. */
  open: boolean;
}

interface RecordingState {
  status: "idle" | "recording" | "uploading" | "done" | "error";
  elapsedMs: number;
  transcript: string;
  recordingId: string | null;
  stub: boolean;
  error: string | null;
  audioUrl: string | null;
}

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function VoiceRecorder({ panelId, onTranscript, onClose, open }: Props) {
  const [state, setState] = useState<RecordingState>({
    status: "idle",
    elapsedMs: 0,
    transcript: "",
    recordingId: null,
    stub: false,
    error: null,
    audioUrl: null,
  });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toast = useToast();

  // Clean up any active stream / timer when the component unmounts.
  useEffect(() => {
    return () => {
      stopTick();
      try {
        mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startTick = useCallback(() => {
    startedAtRef.current = Date.now();
    tickRef.current = setInterval(() => {
      setState((s) =>
        s.status === "recording"
          ? { ...s, elapsedMs: Date.now() - startedAtRef.current }
          : s,
      );
    }, 100);
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.addToast({
        id: "vr-no-api",
        title: "Microphone API unavailable",
        description: "This browser doesn't expose getUserMedia.",
        tone: "warning",
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mime || "audio/webm" });
        const url = URL.createObjectURL(blob);
        setState((s) => ({ ...s, audioUrl: url }));
        // Auto-upload so the user immediately sees the transcript.
        void upload(blob);
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setState((s) => ({ ...s, status: "recording", elapsedMs: 0, error: null }));
      startTick();
    } catch (err) {
      const msg = (err as Error).message || "permission denied";
      toast.addToast({
        id: "vr-mic-fail",
        title: "Microphone unavailable",
        description: msg,
        tone: "warning",
      });
      setState((s) => ({ ...s, status: "error", error: msg }));
    }
  }, [startTick, toast]);

  const stopRecording = useCallback(() => {
    stopTick();
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      /* recorder already stopped */
    }
  }, [stopTick]);

  const upload = useCallback(
    async (blob: Blob) => {
      setState((s) => ({ ...s, status: "uploading" }));
      const form = new FormData();
      const ext = blob.type.includes("mp4") ? "m4a"
        : blob.type.includes("ogg") ? "ogg"
        : "webm";
      form.append("audio", blob, `voice-${Date.now()}.${ext}`);
      if (panelId) form.append("panel_id", panelId);
      form.append("duration_ms", String(state.elapsedMs));
      try {
        const res = await fetch("/api/voice", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `upload failed (${res.status})`);
        }
        const data = (await res.json()) as {
          id: string;
          transcript: string;
          duration_ms: number;
          stub: boolean;
        };
        setState((s) => ({
          ...s,
          status: "done",
          recordingId: data.id,
          transcript: data.transcript,
          stub: data.stub,
        }));
      } catch (err) {
        setState((s) => ({ ...s, status: "error", error: (err as Error).message }));
      }
    },
    [panelId, state.elapsedMs],
  );

  const send = useCallback(() => {
    if (state.recordingId && state.transcript) {
      onTranscript?.(state.transcript, state.recordingId);
    }
  }, [state.recordingId, state.transcript, onTranscript]);

  const reset = useCallback(() => {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    setState({
      status: "idle",
      elapsedMs: 0,
      transcript: "",
      recordingId: null,
      stub: false,
      error: null,
      audioUrl: null,
    });
  }, [state.audioUrl]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="w-[480px] max-w-[92vw] bg-panel border border-border shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-borderSoft">
          <div className="flex items-center gap-2">
            <MicIcon size={14} className="text-brass" />
            <span className="font-display text-[13px] text-text">Voice input</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-textFaint hover:text-text p-1"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-6 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() =>
              state.status === "recording" ? stopRecording() : startRecording()
            }
            aria-label={state.status === "recording" ? "Stop recording" : "Start recording"}
            className={cn(
              "relative w-16 h-16 rounded-full border-2 flex items-center justify-center transition-colors",
              state.status === "recording"
                ? "border-rust text-rust bg-rust/10"
                : "border-brass text-brass hover:bg-brass/10",
            )}
          >
            {state.status === "recording" ? (
              <StopIcon size={20} />
            ) : (
              <MicIcon size={20} />
            )}
            {state.status === "recording" && (
              <span className="absolute inset-0 rounded-full border-2 border-rust animate-ping opacity-60" />
            )}
          </button>

          <div className="mono-caps text-[11px] text-textMuted tracking-wider">
            {state.status === "idle" && "Tap to record"}
            {state.status === "recording" && `recording · ${(state.elapsedMs / 1000).toFixed(1)}s`}
            {state.status === "uploading" && "transcribing…"}
            {state.status === "done" && "ready"}
            {state.status === "error" && (state.error ?? "error")}
          </div>

          {state.status === "done" && (
            <div className="w-full mt-2">
              <label className="mono-caps text-[10px] text-textFaint block mb-1">
                transcript {state.stub && <span className="text-rust">· stub</span>}
              </label>
              <textarea
                className="w-full bg-panelAlt border border-border text-text px-2 py-1.5 font-mono text-[12px] resize-none focus:border-brass outline-none"
                rows={3}
                value={state.transcript}
                onChange={(e) =>
                  setState((s) => ({ ...s, transcript: e.target.value }))
                }
                placeholder="(empty transcript)"
              />
            </div>
          )}
        </div>

        <div className="px-3 py-2 border-t border-borderSoft flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {state.status === "done" ? (
            <>
              <Button variant="secondary" onClick={reset} title="discard & retry">
                <RefreshIcon size={12} />
                Retry
              </Button>
              <Button variant="primary" onClick={send} disabled={!state.transcript.trim()}>
                <SendIcon size={12} />
                Send
              </Button>
            </>
          ) : state.status === "recording" ? (
            <Button variant="primary" onClick={stopRecording}>
              <StopIcon size={12} />
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={startRecording}>
              <MicIcon size={12} />
              Start
            </Button>
          )}
          {state.status === "done" && (
            <button
              type="button"
              onClick={() => {
                if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
                setState((s) => ({ ...s, audioUrl: null }));
                onClose?.();
              }}
              className="text-textFaint hover:text-rust"
              title="discard"
            >
              <TrashIcon size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of PREFERRED_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* not supported in this browser */
    }
  }
  return null;
}