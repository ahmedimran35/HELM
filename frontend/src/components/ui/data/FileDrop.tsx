// FileDrop — drag-and-drop or click-to-browse file upload zone. Built
// for the chat input's paperclip affordance (Tier 3 — Voice +
// Multimodal). The component is a small shell that the chat page
// mounts in a SideSheet; on confirm it uploads every queued file via
// POST /api/files (multipart) and calls back with the resulting file
// metadata.
//
// Visual states:
//   - idle        — dashed border, "drop files here" copy
//   - dragover    — brass border, pulse
//   - uploading   — per-file progress dots
//   - done / err  — collapsed chip list with per-file status
//
// We deliberately do NOT show the actual uploaded bytes inline (the
// chat input is small); the parent owns the resulting `Attachment`
// objects and renders them above the textarea as chips.

import { useCallback, useRef, useState } from "react";
import { useToast } from "../feedback/Toast";
import { Button } from "../Button";
import {
  PaperclipIcon,
  XIcon,
  CheckIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from "../Icon";
import { cn } from "../../../lib/cn";

export type FilePurpose = "vision" | "attachment" | "knowledge";

export interface UploadedFile {
  id: string;
  name: string;
  mime_type: string;
  panel_id: string | null;
  purpose: FilePurpose;
  byte_size: number;
  description?: string;
  stub?: boolean;
}

interface QueuedFile {
  uid: string;
  file: File;
  progress: number; // 0..1
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
  uploaded?: UploadedFile;
}

interface Props {
  /** Optional panel scope. Empty string means "no panel". */
  panelId?: string;
  /** Allowed purposes for this dropzone — default lets the user pick. */
  purposes?: FilePurpose[];
  /** Called after each file finishes uploading. */
  onUploaded?: (file: UploadedFile) => void;
  /** Called once after the user dismisses the dropzone. */
  onClose?: () => void;
  /** Open state — render the modal when true. */
  open: boolean;
}

const PURPOSES: { value: FilePurpose; label: string; hint: string }[] = [
  { value: "vision", label: "Vision", hint: "Image / PDF — auto-described" },
  { value: "attachment", label: "Attachment", hint: "Generic chat attachment" },
  { value: "knowledge", label: "Knowledge", hint: "Long-lived doc" },
];

export function FileDrop({
  panelId,
  purposes = ["vision", "attachment", "knowledge"],
  onUploaded,
  onClose,
  open,
}: Props) {
  const [purpose, setPurpose] = useState<FilePurpose>(purposes[0] ?? "attachment");
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const addFiles = useCallback((files: FileList | File[]) => {
    const next: QueuedFile[] = [];
    for (const f of Array.from(files)) {
      next.push({
        uid: crypto.randomUUID(),
        file: f,
        progress: 0,
        status: "queued",
      });
    }
    if (next.length === 0) return;
    setQueued((prev) => [...prev, ...next]);
  }, []);

  const uploadOne = useCallback(
    async (qf: QueuedFile) => {
      const form = new FormData();
      form.append("file", qf.file, qf.file.name);
      form.append("name", qf.file.name);
      form.append("purpose", purpose);
      if (panelId) form.append("panel_id", panelId);
      setQueued((prev) =>
        prev.map((q) => (q.uid === qf.uid ? { ...q, status: "uploading", progress: 0.1 } : q)),
      );
      try {
        const res = await fetch("/api/files", {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `upload failed (${res.status})`);
        }
        const data = (await res.json()) as { id: string; mime_type: string; panel_id: string | null };
        const uploaded: UploadedFile = {
          id: data.id,
          name: qf.file.name,
          mime_type: data.mime_type,
          panel_id: data.panel_id,
          purpose,
          byte_size: qf.file.size,
        };
        // If the file is an image, fire-and-forget a describe request so
        // the chat can use the description as context. We don't await
        // it because the user might already be typing the next message.
        if (purpose === "vision" && qf.file.type.startsWith("image/")) {
          fetch(`/api/files/${data.id}/describe`, {
            method: "POST",
            credentials: "include",
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((desc) => {
              if (desc && typeof desc === "object" && "description" in desc) {
                uploaded.description = String((desc as { description: string }).description);
                uploaded.stub = Boolean((desc as { stub?: boolean }).stub);
                onUploaded?.(uploaded);
              } else {
                onUploaded?.(uploaded);
              }
            })
            .catch(() => onUploaded?.(uploaded));
        } else {
          onUploaded?.(uploaded);
        }
        setQueued((prev) =>
          prev.map((q) =>
            q.uid === qf.uid ? { ...q, status: "done", progress: 1, uploaded } : q,
          ),
        );
      } catch (err) {
        const msg = (err as Error).message;
        setQueued((prev) =>
          prev.map((q) =>
            q.uid === qf.uid ? { ...q, status: "error", error: msg } : q,
          ),
        );
        toast.addToast({
          id: `file-err-${qf.uid}`,
          title: `Upload failed: ${qf.file.name}`,
          description: msg,
          tone: "warning",
        });
      }
    },
    [panelId, purpose, onUploaded, toast],
  );

  const uploadAll = useCallback(async () => {
    const pending = queued.filter((q) => q.status === "queued" || q.status === "error");
    if (pending.length === 0) {
      toast.addToast({
        id: "file-noop",
        title: "No files to upload",
        description: "Drop one or more files first.",
        tone: "info",
      });
      return;
    }
    for (const qf of pending) {
      await uploadOne(qf);
    }
    const doneCount = queued.filter((q) => q.status === "done").length + pending.length;
    toast.addToast({
      id: "file-batch",
      title: `Uploaded ${doneCount} file${doneCount === 1 ? "" : "s"}`,
      tone: "success",
    });
  }, [queued, uploadOne, toast]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div className="w-[520px] max-w-[92vw] bg-panel border border-border shadow-lg flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-borderSoft">
          <div className="flex items-center gap-2">
            <PaperclipIcon size={14} className="text-brass" />
            <span className="font-display text-[13px] text-text">Attach file</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-textFaint hover:text-text p-1"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="px-3 pt-3 pb-2 flex items-center gap-1.5">
          <span className="mono-caps text-[10px] text-textFaint">purpose</span>
          {purposes.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPurpose(p)}
              title={PURPOSES.find((x) => x.value === p)?.hint}
              className={cn(
                "px-2 h-[22px] mono-caps text-[10px] tracking-wider border transition-colors",
                purpose === p
                  ? "border-brass/60 bg-brass/10 text-brass"
                  : "border-borderSoft text-textMuted hover:text-text hover:border-brass/40",
              )}
            >
              {p}
            </button>
          ))}
        </div>

        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "mx-3 my-2 h-32 border-2 border-dashed flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors",
            dragOver
              ? "border-brass bg-brass/10 text-brass"
              : "border-borderSoft text-textMuted hover:text-text hover:border-brass/50",
          )}
          role="button"
          tabIndex={0}
        >
          <PaperclipIcon size={20} />
          <span className="font-mono text-[12px]">
            {dragOver ? "Drop to upload" : "Drop files here or click to browse"}
          </span>
          <span className="mono-caps text-[10px] text-textFaint">
            max 25 MB · images, PDFs, audio, docs
          </span>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {queued.length > 0 && (
          <div className="px-3 pb-2 max-h-44 overflow-y-auto border-t border-borderSoft">
            {queued.map((q) => (
              <div
                key={q.uid}
                className="flex items-center gap-2 py-1.5 border-b border-borderSoft/60 last:border-b-0"
              >
                <StatusGlyph status={q.status} />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[12px] truncate text-text">{q.file.name}</div>
                  <div className="mono-caps text-[10px] text-textFaint">
                    {(q.file.size / 1024).toFixed(1)} KB
                    {q.status === "error" && q.error ? ` · ${q.error}` : ""}
                    {q.status === "done" && q.uploaded ? ` · ${q.uploaded.mime_type}` : ""}
                  </div>
                </div>
                {q.status === "error" && (
                  <button
                    type="button"
                    onClick={() => uploadOne(q)}
                    className="text-textFaint hover:text-text"
                    title="retry"
                  >
                    <RefreshIcon size={12} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() =>
                    setQueued((prev) => prev.filter((p) => p.uid !== q.uid))
                  }
                  className="text-textFaint hover:text-rust"
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="px-3 py-2 border-t border-borderSoft flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={uploadAll}
            disabled={queued.filter((q) => q.status === "queued" || q.status === "error").length === 0}
          >
            Upload
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: QueuedFile["status"] }) {
  if (status === "uploading") {
    return <span className="text-brass animate-pulse">·</span>;
  }
  if (status === "done") return <CheckIcon size={12} className="text-teal" />;
  if (status === "error") return <AlertTriangleIcon size={12} className="text-rust" />;
  return <span className="text-textFaint">·</span>;
}