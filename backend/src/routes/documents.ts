// Document generation route (Tier 3 — Voice + Multimodal).
//
//   POST /api/documents/generate  — build a docx/xlsx/pdf/pptx/md/html
//   GET  /api/documents           — list the user's generated docs
//   GET  /api/documents/:id/download — stream the blob
//   DELETE /api/documents/:id    — owner-only delete
//
// Generation strategy:
//   1. Always succeed with the .md fallback so the call never crashes.
//   2. Try richer libraries (docx, xlsx, pdfkit, pptxgenjs) when present.
//   3. Persist to tmp/documents/<user_id>/<id>.<format> and record the
//      row in generated_documents.
//
// We intentionally do NOT add new npm dependencies — we attempt the
// imports with `await import(...)` and fall back gracefully when the
// package isn't installed.

import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";

const router = new Hono();
router.use("*", requireAuth);

const ALLOWED_FORMATS = ["docx", "xlsx", "pdf", "pptx", "md", "html"] as const;
type DocFormat = (typeof ALLOWED_FORMATS)[number];

const CONTENT_TYPE: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const DOC_ROOT = join(process.cwd(), "tmp", "documents");

interface Section {
  heading?: string;
  content?: string;
}

// ----- POST /api/documents/generate -----
router.post("/generate", async (c) => {
  const user = c.get("user");
  let body: {
    title?: string;
    format?: DocFormat;
    sections?: Section[];
    panel_id?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      title: { type: "string", minLength: 1, maxLength: 200, trim: true },
      format: { type: "enum", values: ALLOWED_FORMATS as unknown as string[] },
      sections: {
        type: "array",
        of: { type: "object", fields: {} },
        maxLength: 200,
      },
      panel_id: { type: "uuid" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.title) {
    return c.json({ error: "title required" }, 400);
  }
  const format: DocFormat = body.format ?? "md";
  const sections = Array.isArray(body.sections) ? body.sections : [];
  let panelId: string | null = null;
  if (body.panel_id) {
    const exists = await sql<{ id: string }[]>`
      SELECT id FROM panels WHERE id = ${body.panel_id}::uuid LIMIT 1
    `;
    if (!exists[0]) return c.json({ error: "panel not found" }, 404);
    panelId = body.panel_id;
  }
  const result = await generateDocument({
    title: body.title,
    format,
    sections,
  });
  const id = crypto.randomUUID();
  const dir = join(DOC_ROOT, `user-${user.id}`);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${id}.${format}`);
  await writeFile(filePath, result.bytes);
  await sql`
    INSERT INTO generated_documents (id, user_id, panel_id, format, title, blob_ref, size_bytes)
    VALUES (${id}::uuid, ${user.id}::uuid, ${panelId}::uuid, ${format},
            ${body.title}, ${filePath}, ${result.bytes.byteLength}::bigint)
  `;
  await logAudit({
    userId: user.id,
    target: id,
    action: "document_generated",
    metadata: { format, size_bytes: result.bytes.byteLength, stub: result.stub ? "true" : "false" },
  });
  return c.json({
    id,
    format,
    title: body.title,
    size_bytes: result.bytes.byteLength,
    download_url: `/api/documents/${id}/download`,
    stub: result.stub,
    reason: result.reason,
  });
});

// ----- GET /api/documents -----
router.get("/", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    panel_id: string | null;
    format: string;
    title: string;
    size_bytes: number;
    created_at: Date;
  }[]>`
    SELECT id, panel_id, format, title, size_bytes, created_at
    FROM generated_documents
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return c.json(
    rows.map((r) => ({ ...r, download_url: `/api/documents/${r.id}/download` })),
  );
});

// ----- GET /api/documents/:id/download -----
router.get("/:id/download", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    format: string;
    title: string;
    blob_ref: string;
    size_bytes: number;
  }[]>`
    SELECT format, title, blob_ref, size_bytes
    FROM generated_documents
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  const { readFile } = await import("node:fs/promises");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(r.blob_ref));
  } catch {
    return c.json({ error: "blob_missing" }, 410);
  }
  const filename = `${r.title.replace(/[^a-zA-Z0-9._-]+/g, "-")}.${r.format}`;
  // Copy into a plain ArrayBuffer so the Response constructor's BodyInit
  // type is happy (Uint8Array's underlying buffer can be SharedArrayBuffer
  // in some Node builds).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, {
    headers: {
      "Content-Type": CONTENT_TYPE[r.format as DocFormat] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(r.size_bytes),
    },
  });
});

// ----- DELETE /api/documents/:id -----
router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`DELETE FROM generated_documents
    WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  await logAudit({ userId: user.id, target: id, action: "document_deleted" });
  return c.json({ ok: true });
});

// ============================================================================
// helpers
// ============================================================================

interface GenerationResult {
  bytes: Uint8Array;
  stub: boolean;
  reason?: string;
}

async function generateDocument(input: {
  title: string;
  format: DocFormat;
  sections: Section[];
}): Promise<GenerationResult> {
  const { title, format, sections } = input;
  // Markdown is always available and is our fallback.
  const md = renderMarkdown(title, sections);
  switch (format) {
    case "md":
      return { bytes: new TextEncoder().encode(md), stub: false };
    case "html":
      return { bytes: new TextEncoder().encode(renderHtml(title, sections)), stub: false };
    case "docx":
      return generateDocx(title, sections, md);
    case "xlsx":
      return generateXlsx(title, sections, md);
    case "pdf":
      return generatePdf(title, sections, md);
    case "pptx":
      return generatePptx(title, sections, md);
  }
}

function renderMarkdown(title: string, sections: Section[]): string {
  const parts: string[] = [];
  parts.push(`# ${title}`);
  parts.push("");
  if (sections.length === 0) {
    parts.push("_No sections provided._");
  }
  for (const s of sections) {
    if (s.heading) {
      parts.push(`## ${s.heading}`);
      parts.push("");
    }
    if (s.content) {
      parts.push(s.content);
      parts.push("");
    }
  }
  return parts.join("\n");
}

function renderHtml(title: string, sections: Section[]): string {
  const escape = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const body = sections
    .map((s) => {
      const h = s.heading ? `<h2>${escape(s.heading)}</h2>` : "";
      const p = s.content
        ? `<p>${escape(s.content).replace(/\n/g, "<br/>")}</p>`
        : "";
      return h + p;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 28px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
  h2 { font-size: 20px; margin-top: 24px; }
  p { line-height: 1.55; }
</style>
</head>
<body>
  <h1>${escape(title)}</h1>
  ${body || "<p><em>No sections provided.</em></p>"}
</body>
</html>`;
}

// The richer formats try optional npm packages. None of them are
// declared in package.json (the task says "fall back to .md" on
// missing libs); the imports return strings that look like errors so
// we can decide what to do.

async function generateDocx(
  title: string,
  sections: Section[],
  fallback: string,
): Promise<GenerationResult> {
  try {
    const mod = await import("docx" as string).catch(() => null);
    if (!mod) return docxFallback(title, sections, fallback);
    const docx = mod as unknown as {
      Document: new (opts: object) => { addSection: (s: object) => unknown };
      Packer: { toBuffer: (d: unknown) => Promise<Uint8Array> };
      Paragraph: new (opts: object) => object;
      HeadingLevel: Record<string, number>;
      TextRun: new (opts: string | object) => object;
    };
    const children: object[] = [new docx.Paragraph({
      heading: docx.HeadingLevel.HEADING_1,
      children: [new docx.TextRun(title)],
    })];
    for (const s of sections) {
      if (s.heading) {
        children.push(new docx.Paragraph({
          heading: docx.HeadingLevel.HEADING_2,
          children: [new docx.TextRun(s.heading)],
        }));
      }
      if (s.content) {
        for (const line of s.content.split(/\r?\n/)) {
          children.push(new docx.Paragraph({
            children: [new docx.TextRun(line)],
          }));
        }
      }
    }
    const doc = new docx.Document({ sections: [{ properties: {}, children }] });
    const buf = await docx.Packer.toBuffer(doc);
    return { bytes: buf, stub: false };
  } catch {
    return docxFallback(title, sections, fallback);
  }
}

function docxFallback(
  title: string,
  sections: Section[],
  fallback: string,
): GenerationResult {
  // Real .docx is a zip; without the lib we emit a plain-text blob
  // with a .docx extension and mark stub=true. The UI surfaces this
  // clearly so users aren't confused by an "open in Word" prompt.
  const text = `${title}\n\n${sections
    .map((s) => (s.heading ? `[${s.heading}]\n${s.content ?? ""}` : s.content ?? ""))
    .join("\n\n")}`;
  return {
    bytes: new TextEncoder().encode(text),
    stub: true,
    reason: "docx library not installed; returning plain-text fallback",
  };
}

async function generateXlsx(
  title: string,
  sections: Section[],
  fallback: string,
): Promise<GenerationResult> {
  try {
    const mod = await import("xlsx" as string).catch(() => null);
    if (!mod) return xlsxFallback(title, sections, fallback);
    const XLSX = mod as unknown as {
      utils: { book_new: () => unknown; aoa_to_sheet: (a: unknown[][]) => unknown; book_append_sheet: (b: unknown, s: unknown, n: string) => void };
      write: (b: unknown, opts: { type: string; bookType: string }) => Uint8Array;
    };
    const aoa: unknown[][] = [[title]];
    for (const s of sections) {
      if (s.heading) aoa.push([s.heading]);
      if (s.content) {
        for (const line of s.content.split(/\r?\n/)) aoa.push([line]);
      }
      aoa.push([]);
    }
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const out = XLSX.write(book, { type: "array", bookType: "xlsx" });
    return { bytes: out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer), stub: false };
  } catch {
    return xlsxFallback(title, sections, fallback);
  }
}

function xlsxFallback(
  title: string,
  sections: Section[],
  fallback: string,
): GenerationResult {
  // Tab-separated text — Excel and Numbers both open .tsv cleanly.
  const lines: string[] = [title.replace(/\t/g, " ")];
  for (const s of sections) {
    if (s.heading) lines.push(s.heading);
    if (s.content) lines.push(...s.content.split(/\r?\n/));
    lines.push("");
  }
  return {
    bytes: new TextEncoder().encode(lines.join("\n")),
    stub: true,
    reason: "xlsx library not installed; returning .tsv fallback",
  };
}

async function generatePdf(
  title: string,
  sections: Section[],
  fallback: string,
): Promise<GenerationResult> {
  try {
    const mod = await import("pdfkit" as string).catch(() => null);
    if (!mod) return pdfFallback(title, sections, fallback);
    const PDFDocument = (mod as unknown as { default?: new (opts?: object) => unknown }).default
      ?? (mod as unknown as new (opts?: object) => unknown);
    // The pdfkit types don't ship with the package — cast to a
    // narrow interface so we can call the methods we actually use.
    const doc = new PDFDocument({ margin: 50 }) as unknown as {
      on: (event: string, cb: (chunk: Buffer) => void) => void;
      fontSize: (n: number) => { text: (s: string) => { moveDown: (n?: number) => void } };
      text: (s: string) => { moveDown: (n?: number) => void };
      moveDown: (n?: number) => void;
      end: () => void;
    };
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.fontSize(20).text(title).moveDown();
    for (const s of sections) {
      if (s.heading) doc.fontSize(14).text(s.heading).moveDown(0.5);
      if (s.content) doc.fontSize(11).text(s.content).moveDown();
    }
    doc.end();
    await new Promise<void>((resolve) => doc.on("end", () => resolve()));
    return {
      bytes: new Uint8Array(Buffer.concat(chunks)),
      stub: false,
    };
  } catch {
    return pdfFallback(title, sections, fallback);
  }
}

function pdfFallback(
  title: string,
  sections: Section[],
  fallback: string,
): GenerationResult {
  // Real PDF without pdfkit isn't trivial. We emit plain text — the
  // client can `download` it and open it in any editor. We mark
  // stub=true so the UI knows it's not a true PDF.
  return {
    bytes: new TextEncoder().encode(fallback),
    stub: true,
    reason: "pdfkit not installed; returning .md fallback",
  };
}

async function generatePptx(
  title: string,
  sections: Section[],
  fallback: string,
): Promise<GenerationResult> {
  try {
    const mod = await import("pptxgenjs" as string).catch(() => null);
    if (!mod) return pptxFallback(title, sections, fallback);
    const PptxGen = (mod as unknown as { default?: new () => unknown }).default
      ?? (mod as unknown as new () => unknown);
    const pptx = new PptxGen();
    (pptx as unknown as { title: string }).title = title;
    // Title slide
    (pptx as unknown as { addSlide: () => unknown }).addSlide();
    (pptx as unknown as {
      addText: (text: string, opts: object) => unknown;
    }).addText(title, {
      x: 0.5, y: 2.5, w: 9, h: 1, fontSize: 32, align: "center",
    });
    for (const s of sections) {
      (pptx as unknown as { addSlide: () => unknown }).addSlide();
      (pptx as unknown as { addText: (text: string, opts: object) => unknown })
        .addText(s.heading ?? "", {
          x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 24,
        });
      (pptx as unknown as { addText: (text: string, opts: object) => unknown })
        .addText(s.content ?? "", {
          x: 0.5, y: 1.5, w: 9, h: 5, fontSize: 14,
        });
    }
    const buf = await (pptx as unknown as {
      write: (opts: { outputType: string }) => Promise<Uint8Array>;
    }).write({ outputType: "array" });
    return { bytes: buf, stub: false };
  } catch {
    return pptxFallback(title, sections, fallback);
  }
}

function pptxFallback(
  title: string,
  sections: Section[],
  fallback: string,
): GenerationResult {
  return {
    bytes: new TextEncoder().encode(fallback),
    stub: true,
    reason: "pptxgenjs not installed; returning .md fallback",
  };
}

export default router;