// Tiny inline-markdown renderer for chat messages.
//
// Supports the subset the chat model uses:
//   **bold**      → <strong>
//   *italic*      → <em>
//   `code`        → <code>
//   line breaks   → preserved
//   bullet lists  (- or * at line start) → <ul><li>
//   numbered lists (1. 2. ...) → <ol><li>
//   headings      (# / ## / ### at line start)
//
// We escape everything first and only inject our own markup, so
// there's no XSS surface. We deliberately avoid a full markdown
// library to keep the bundle small and to avoid the extra dep.

import { Fragment } from "react";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Apply inline transforms (`**bold**`, `*italic*`, `` `code` ``, `[t](u)`)
 *  to an already-HTML-escaped line. Order matters — links must run
 *  before italics so `[*text*](url)` doesn't get split; `**` must be
 *  tried before `*` so we don't mis-parse bold as italic. */
function applyInline(escaped: string): string {
  let out = escaped;
  // Markdown link: [title](url)
  // We pre-escape URLs to escape & inside the URL, then rebuild an
  // <a> tag with the title as inner HTML (the title was escaped above).
  out = out.replace(
    /\[([^\]\n]+)\]\(([^\s)\n]+)\)/g,
    (_m, title: string, url: string) => {
      // URL sanitisation — anchored to end so trailing characters like
      // `[x](javascript:alert(1)//https://foo)` can't slip past.
      // (The previous regex was unanchored and accepted "javascript:foo//https://example"
      // because of the "//https" tail.)
      const safe = /^(https?:|mailto:)/i.test(url)
        && !/javascript:/i.test(url)
        && !/data:/i.test(url)
        && !/vbscript:/i.test(url);
      if (!safe) return `[${title}](${url})`;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-brass underline underline-offset-2 hover:text-text">${title}</a>`;
    },
  );
  // Bold: **text**
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  // Italic: *text* (single asterisks, not part of a pair)
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  // Inline code: `text`
  out = out.replace(/`([^`\n]+?)`/g, "<code class=\"px-1 py-0.5 bg-panelAlt border border-borderSoft text-brass font-mono text-[12px]\">$1</code>");
  return out;
}

interface MarkdownProps {
  content: string;
  className?: string;
}

/** Render a markdown string as React elements. Safe — escapes HTML
 *  first, then adds our own <strong>/<em>/<code>/<ul>/<ol>/<h*>. */
export function Markdown({ content, className }: MarkdownProps) {
  if (!content) return null;

  const lines = content.split("\n");
  const blocks: Array<
    | { kind: "p"; html: string }
    | { kind: "ul"; items: string[] }
    | { kind: "ol"; items: string[] }
    | { kind: "h"; level: 1 | 2 | 3; html: string }
    | { kind: "code"; text: string }
  > = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Heading
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      blocks.push({
        kind: "h",
        level,
        html: applyInline(escapeHtml(heading[2]!)),
      });
      i += 1;
      continue;
    }
    // Code block (``` ... ```)
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing ```
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }
    // Unordered list (- or * at line start)
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^[-*]\s+(.+)$/);
        if (!m) break;
        items.push(applyInline(escapeHtml(m[1]!)));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    // Ordered list (1. 2. ...)
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\d+\.\s+(.+)$/);
        if (!m) break;
        items.push(applyInline(escapeHtml(m[1]!)));
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // Empty line → paragraph break
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // Plain paragraph (collect consecutive non-empty non-list lines)
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.match(/^[-*]\s+/) &&
      !lines[i]!.match(/^\d+\.\s+/) &&
      !lines[i]!.match(/^#{1,3}\s+/) &&
      !lines[i]!.startsWith("```")
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "p", html: applyInline(escapeHtml(paraLines.join(" "))) });
  }

  return (
    <div className={className}>
      {blocks.map((b, idx) => {
        if (b.kind === "p") {
          return (
            <p
              key={idx}
              className="text-[13px] leading-relaxed"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: b.html }}
            />
          );
        }
        if (b.kind === "ul") {
          return (
            <ul
              key={idx}
              className="list-disc pl-5 my-1 space-y-1 text-[13px] leading-relaxed"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: b.items.map((i) => `<li>${i}</li>`).join("") }}
            />
          );
        }
        if (b.kind === "ol") {
          return (
            <ol
              key={idx}
              className="list-decimal pl-5 my-1 space-y-1 text-[13px] leading-relaxed"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: b.items.map((i) => `<li>${i}</li>`).join("") }}
            />
          );
        }
        if (b.kind === "code") {
          return (
            <pre
              key={idx}
              className="my-1 p-2 bg-panelAlt border border-borderSoft text-text font-mono text-[12px] overflow-x-auto"
            >
              <code>{b.text}</code>
            </pre>
          );
        }
        // h
        const sizes: Record<1 | 2 | 3, string> = {
          1: "text-[18px] font-display font-semibold mt-2 mb-1",
          2: "text-[15px] font-display font-semibold mt-1.5 mb-0.5",
          3: "text-[13px] font-semibold mt-1 mb-0.5",
        };
        return (
          <Fragment key={idx}>
            {b.level === 1 && (
              <h1 className={sizes[1]} dangerouslySetInnerHTML={{ __html: b.html }} />
            )}
            {b.level === 2 && (
              <h2 className={sizes[2]} dangerouslySetInnerHTML={{ __html: b.html }} />
            )}
            {b.level === 3 && (
              <h3 className={sizes[3]} dangerouslySetInnerHTML={{ __html: b.html }} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}