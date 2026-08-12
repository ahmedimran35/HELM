// NodeView — SVG node primitive.
//
// Renders one node inside the canvas's <g transform="translate(x y)">.
// Three shape branches keyed off NODE_KIND_META[node.kind].shape:
//   - "circle" → trigger (centered icon + label)
//   - "diamond" → condition (centered icon + label)
//   - "rect"    → action card (header strip + body)
//
// Per-node run indicator is wired to the latest poll result: looks up
// run.result.log by node_id. Hover surfaces the full config via SVG
// <title> (native browser tooltip — zero JS, mirrors the charts.tsx
// pattern in this codebase).

import { cn } from "../../lib/cn";
import { MAX_LABEL, MAX_PREVIEW } from "./constants";
import { NODE_KIND_META, PORT_R } from "./constants";
import { nodeBodyPreview, nodeBounds } from "./helpers";
import type { NodeLogEntry, RunIndicatorStatus, WorkflowNode } from "./types";

interface Props {
  node: WorkflowNode;
  selected: boolean;
  logEntry: NodeLogEntry | undefined;
  isRunning: boolean;
  /** model_id → display_name lookup for showing the assigned model on
   *  the card body of an agent_run node. Optional — pass undefined if
   *  models aren't loaded yet. */
  modelDisplayName?: string;
  onMouseDown: (e: React.MouseEvent) => void;
  onPortMouseDown?: (
    e: React.MouseEvent,
    port: "in" | "out",
    nodeId: string,
  ) => void;
}

function runStatusFor(entry: NodeLogEntry | undefined, isRunning: boolean): RunIndicatorStatus {
  if (!entry) return isRunning ? "running" : "idle";
  if (entry.status === "ok") return "ok";
  if (entry.status === "error") return "error";
  return "skipped";
}

const RUN_COLOR: Record<RunIndicatorStatus, string> = {
  idle: "#4E5560",     // textFaint
  running: "#4c9c90",  // teal — animated
  ok: "#4c9c90",       // teal
  error: "#B5533C",    // rust
  skipped: "#4E5560",
};

function NodeTooltipBody({ node, logEntry }: { node: WorkflowNode; logEntry: NodeLogEntry | undefined }) {
  const meta = NODE_KIND_META[node.kind];
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const lines: string[] = [
    `${meta.label}  ·  ${node.id}`,
    node.label ? `Label: ${node.label}` : "No label",
  ];
  if (node.kind === "agent_run" && cfg.prompt)
    lines.push(`Prompt: ${String(cfg.prompt).slice(0, 120)}`);
  else if (node.kind === "panel_message" && cfg.message)
    lines.push(`Message: ${String(cfg.message).slice(0, 120)}`);
  else if (node.kind === "http_post")
    lines.push(`URL: ${String(cfg.url ?? "—")}  (${String(cfg.method ?? "POST")})`);
  else if (node.kind === "condition")
    lines.push(`Path: ${String(cfg.path ?? "—")}`);
  else if (node.kind === "delay")
    lines.push(`Wait: ${Number(cfg.seconds ?? 5)}s`);
  if (logEntry) {
    lines.push(
      logEntry.status === "ok"
        ? `Last run: ok (${logEntry.started_at})`
        : `Last run: ${logEntry.status}${logEntry.error ? ` — ${logEntry.error}` : ""}`,
    );
  }
  // SVG <title> uses \n for line breaks in most browsers.
  return <title>{lines.join("\n")}</title>;
}

export function NodeView({
  node,
  selected,
  logEntry,
  isRunning,
  modelDisplayName,
  onMouseDown,
  onPortMouseDown,
}: Props) {
  const meta = NODE_KIND_META[node.kind];
  const b = nodeBounds(node);
  const label = (node.label?.trim() || meta.label).slice(0, MAX_LABEL);
  // Body text — prefer the model name on agent_run (it tells the user
  // which AI answered last), then the body preview, then the description.
  const configuredModel = modelDisplayName?.trim();
  const baseBody = nodeBodyPreview(node) || meta.description;
  const bodyText = (configuredModel || baseBody).slice(0, MAX_PREVIEW);
  const runStatus = runStatusFor(logEntry, isRunning);
  const runColor = RUN_COLOR[runStatus];
  const bodyIsModel =
    node.kind === "agent_run" && Boolean(configuredModel) && !nodeBodyPreview(node);

  return (
    <g
      data-node-id={node.id}
      transform={`translate(${node.x} ${node.y})`}
      onMouseDown={onMouseDown}
      className={cn("cursor-grab active:cursor-grabbing")}
    >
      <NodeTooltipBody node={node} logEntry={logEntry} />

      {meta.shape === "circle" ? (
        // Trigger node — circle with icon and label inside.
        <g>
          <circle
            cx={b.w / 2}
            cy={b.h / 2}
            r={Math.min(b.w, b.h) / 2 - 2}
            fill="#14171d"
            stroke={selected ? "#C9A227" : meta.color}
            strokeWidth={selected ? 2.5 : 1.5}
          />
          <circle
            cx={b.w / 2}
            cy={b.h / 2}
            r={Math.min(b.w, b.h) / 2 - 8}
            fill={`url(#grad-${node.kind})`}
          />
          <text
            x={b.w / 2}
            y={b.h / 2 - 2}
            textAnchor="middle"
            fontSize={22}
            fill={meta.color}
            style={{ pointerEvents: "none" }}
          >
            {meta.icon}
          </text>
          <text
            x={b.w / 2}
            y={b.h / 2 + 18}
            textAnchor="middle"
            fontSize={10}
            fill="#e6e6e6"
            fontWeight={500}
            style={{ pointerEvents: "none" }}
          >
            {label}
          </text>
        </g>
      ) : meta.shape === "diamond" ? (
        // Condition node — diamond with icon and label inside.
        <g>
          <polygon
            points={`${b.w / 2},0 ${b.w},${b.h / 2} ${b.w / 2},${b.h} 0,${b.h / 2}`}
            fill="#14171d"
            stroke={selected ? "#C9A227" : meta.color}
            strokeWidth={selected ? 2.5 : 1.5}
          />
          <polygon
            points={`${b.w / 2},4 ${b.w - 4},${b.h / 2} ${b.w / 2},${b.h - 4} 4,${b.h / 2}`}
            fill={`url(#grad-${node.kind})`}
          />
          <text
            x={b.w / 2}
            y={b.h / 2 + 4}
            textAnchor="middle"
            fontSize={12}
            fill={meta.color}
            style={{ pointerEvents: "none" }}
          >
            {meta.icon} {label}
          </text>
        </g>
      ) : (
        // Action card — header stripe + body.
        <g>
          {/* Drop shadow */}
          <rect
            x={3}
            y={5}
            width={b.w}
            height={b.h}
            rx={8}
            fill="#000"
            opacity={0.6}
          />
          {/* Card body */}
          <rect
            width={b.w}
            height={b.h}
            rx={8}
            fill="#1a1e25"
            stroke={selected ? "#C9A227" : meta.color}
            strokeWidth={selected ? 2.5 : 2}
            strokeOpacity={selected ? 1 : 0.8}
          />
          {/* Header strip — kind color */}
          <path
            d={`M 8 0 H ${b.w - 8} A 8 8 0 0 1 ${b.w} 8 V 28 H 0 V 8 A 8 8 0 0 1 8 0 Z`}
            fill={`url(#grad-${node.kind})`}
          />
          <line
            x1={0}
            y1={28}
            x2={b.w}
            y2={28}
            stroke={meta.color}
            strokeWidth={0.5}
            opacity={0.4}
          />
          {/* Icon + kind label in header */}
          <text
            x={10}
            y={20}
            fontSize={14}
            fill={meta.color}
            style={{ pointerEvents: "none" }}
          >
            {meta.icon}
          </text>
          <text
            x={32}
            y={20}
            fontSize={10}
            fill={meta.color}
            fontWeight={600}
            letterSpacing="0.06em"
            style={{ pointerEvents: "none" }}
          >
            {meta.label.toUpperCase()}
          </text>
          {/* Run indicator (top-right) */}
          <circle
            cx={b.w - 12}
            cy={16}
            r={4}
            fill={runColor}
            opacity={runStatus === "running" ? 0.7 : 1}
          >
            {runStatus === "running" && (
              <animate
                attributeName="r"
                values="3;5;3"
                dur="1.1s"
                repeatCount="indefinite"
              />
            )}
            {runStatus === "running" && (
              <animate
                attributeName="opacity"
                values="0.5;1;0.5"
                dur="1.1s"
                repeatCount="indefinite"
              />
            )}
          </circle>
          {/* Title */}
          <text
            x={12}
            y={46}
            fontSize={12}
            fill="#e6e6e6"
            fontWeight={500}
            style={{ pointerEvents: "none" }}
          >
            {label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + "…" : label}
          </text>
          {/* Body preview */}
          <text
            x={12}
            y={62}
            fontSize={10}
            fill={bodyIsModel ? "#8A7220" : "#6a707a"}
            style={{ pointerEvents: "none" }}
          >
            {bodyText.length > MAX_PREVIEW ? bodyText.slice(0, MAX_PREVIEW - 1) + "…" : bodyText}
          </text>
        </g>
      )}

      {/* Output port (bottom). Larger transparent hit area on top of the
          visible circle so the user can grab it easily. */}
      <circle
        cx={b.w / 2}
        cy={b.h}
        r={PORT_R + 8}
        fill="transparent"
        style={{ cursor: "crosshair", pointerEvents: "all" }}
        data-port="out"
        onMouseDown={(e) => {
          if (onPortMouseDown) {
            e.stopPropagation();
            onPortMouseDown(e, "out", node.id);
          }
        }}
      />
      <circle
        cx={b.w / 2}
        cy={b.h}
        r={PORT_R}
        fill={meta.color}
        stroke="#0B0E12"
        strokeWidth={2}
        style={{ pointerEvents: "none" }}
        data-port="out-visual"
      />
      {/* Input port (top, except triggers). Same pattern — invisible
          larger hit area first, then the visible port. */}
      {node.kind !== "trigger" && (
        <>
          <circle
            cx={b.w / 2}
            cy={0}
            r={PORT_R + 8}
            fill="transparent"
            style={{ cursor: "crosshair", pointerEvents: "all" }}
            data-port="in"
            onMouseDown={(e) => {
              if (onPortMouseDown) {
                e.stopPropagation();
                onPortMouseDown(e, "in", node.id);
              }
            }}
          />
          <circle
            cx={b.w / 2}
            cy={0}
            r={PORT_R}
            fill="#1a1e25"
            stroke={meta.color}
            strokeWidth={1.5}
            style={{ pointerEvents: "none" }}
            data-port="in-visual"
          />
        </>
      )}
    </g>
  );
}
