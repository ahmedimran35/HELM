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
// We parse into a block tree, then render each block as real React
// elements (never dangerouslySetInnerHTML). The only dynamic sink is
// anchor href, which is sanitized via safeHref.

import { Fragment } from "react";
import { safeHref } from "../../lib/safe-href";

type Block =
  | { kind: "p"; children: InlineNode[] }
  | { kind: "ul"; items: InlineNode[][] }
  | { kind: "ol"; items: InlineNode[][] }
  | { kind: "h"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "code"; text: string };

type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: InlineNode[] };

// Parse inline markdown into a tree of InlineNode. We do this
// recursively so nested emphasis / code inside links etc. is handled.
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;

  while (i < text.length) {
    // Link: [title](url)
    const linkMatch = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const title = linkMatch[1]!;
      const url = linkMatch[2]!;
      nodes.push({
        type: "link",
        href: safeHref(url) ? url : "#", // sanitize; fall back to harmless anchor
        children: parseInline(title),
      });
      i += linkMatch[0].length;
      continue;
    }

    // Bold: **text** (not followed by *)
    const boldMatch = text.slice(i).match(/^\*\*([^*]+?)\*\*(?!\*)/);
    if (boldMatch) {
      nodes.push({ type: "strong", children: parseInline(boldMatch[1]!) });
      i += boldMatch[0].length;
      continue;
    }

    // Italic: *text* (single asterisk, not **, not followed by *)
    const italicMatch = text.slice(i).match(/^(?<!\*)\*([^*]+?)\*(?!\*)/);
    if (italicMatch) {
      nodes.push({ type: "em", children: parseInline(italicMatch[1]!) });
      i += italicMatch[0].length;
      continue;
    }

    // Inline code: `text`
    const codeMatch = text.slice(i).match(/^`([^`]+?)`/);
    if (codeMatch) {
      nodes.push({ type: "code", value: codeMatch[1]! });
      i += codeMatch[0].length;
      continue;
    }

    // Plain text — consume until next markdown char or end
    const nextSpecial = text.slice(i).search(/[*`[\\[]/);
    if (nextSpecial === -1) {
      nodes.push({ type: "text", value: text.slice(i) });
      break;
    }
    if (nextSpecial === 0) {
      // Single special char that didn't match a pattern above — treat as literal
      nodes.push({ type: "text", value: text[i]! });
      i += 1;
    } else {
      nodes.push({ type: "text", value: text.slice(i, i + nextSpecial) });
      i += nextSpecial;
    }
  }
  return nodes;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Heading
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "h",
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!),
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
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^[-*]\s+(.+)$/);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list (1. 2. ...)
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^\d+\.\s+(.+)$/);
        if (!m) break;
        items.push(parseInline(m[1]!));
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
    blocks.push({ kind: "p", children: parseInline(paraLines.join(" ")) });
  }
  return blocks;
}

function renderInline(nodes: InlineNode[]): React.ReactNode {
  return nodes.map((node, idx) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "strong":
        return <strong key={idx}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={idx}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code
            key={idx}
            className="px-1 py-0.5 bg-panelAlt border border-borderSoft text-brass font-mono text-[12px]"
          >
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={idx}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brass underline underline-offset-2 hover:text-text"
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: MarkdownProps) {
  if (!content) return null;

  const lines = content.split("\n");
  const blocks = parseBlocks(lines);

  return (
    <div className={className}>
      {blocks.map((b, idx) => {
        if (b.kind === "p") {
          return (
            <p
              key={idx}
              className="text-[13px] leading-relaxed"
            >
              {renderInline(b.children)}
            </p>
          );
        }
        if (b.kind === "ul") {
          return (
            <ul
              key={idx}
              className="list-disc pl-5 my-1 space-y-1 text-[13px] leading-relaxed"
            >
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol
              key={idx}
              className="list-decimal pl-5 my-1 space-y-1 text-[13px] leading-relaxed"
            >
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ol>
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
              <h1 className={sizes[1]}>{renderInline(b.children)}</h1>
            )}
            {b.level === 2 && (
              <h2 className={sizes[2]}>{renderInline(b.children)}</h2>
            )}
            {b.level === 3 && (
              <h3 className={sizes[3]}>{renderInline(b.children)}</h3>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}