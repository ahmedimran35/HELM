// Chart primitives — pure SVG, no external library. Three shapes:
//   - <Sparkline>     — a single trend line, no axes, used inline in stat
//                        tiles, table cells, and status pills.
//   - <BarChart>      — vertical bars with optional axis labels; used in
//                        Analytics spend-by-model and message-volume.
//   - <LineChart>     — line + area fill; used for time series.
//
// All three:
//   - render into a viewBox so they scale to whatever width the parent
//     gives them (no fixed pixel sizes);
//   - read colour from CSS custom properties (--brass / --teal / --rust)
//     so they auto-theme with the rest of the app;
//   - include a hover tooltip driven by SVG <title> children — pure DOM,
//     zero JS. Screen readers see the title; sighted users see the
//     browser-native tooltip on mouseover.
//
// The component is intentionally small. If a chart needs more than what
// these primitives can express (e.g. stacked bars, dual-axis), add a
// dedicated component rather than threading more props through here.

import { useId, type CSSProperties, type ReactNode } from "react";
import { cn } from "../../../lib/cn";

// ─────────────────────────────────────────────────────────────────────
// Sparkline
// ─────────────────────────────────────────────────────────────────────

interface SparklineProps {
  values: number[];
  /** Width and height in viewBox units. Default 120x32. */
  width?: number;
  height?: number;
  /** Stroke colour: "brass" | "teal" | "rust" | "currentColor". */
  tone?: "brass" | "teal" | "rust" | "muted";
  /** Optional caption shown in the tooltip on hover (e.g. the period). */
  caption?: string;
  className?: string;
  /** Render an area fill below the line. */
  area?: boolean;
}

const SPARK_TONE: Record<NonNullable<SparklineProps["tone"]>, string> = {
  brass: "var(--brass)",
  teal: "var(--teal)",
  rust: "var(--rust)",
  muted: "var(--textMuted)",
};

export function Sparkline({
  values,
  width = 120,
  height = 32,
  tone = "brass",
  caption,
  className,
  area = true,
}: SparklineProps) {
  if (values.length === 0) return null;
  // Coerce NaN / Infinity to safe defaults — upstream data can be polluted
  // by partial API failures (e.g. an analytics endpoint returns 401 for one
  // user but 200 for another), so we don't trust raw values.
  const clean = values.map((v) =>
    Number.isFinite(v) ? v : 0,
  );
  const id = useId();
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const stepX = clean.length > 1 ? width / (clean.length - 1) : 0;

  const pts = clean.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return [x, y] as const;
  });

  const linePath = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");

  const areaPath =
    `M${pts[0]![0].toFixed(2)},${height} ` +
    pts.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(" ") +
    ` L${pts[pts.length - 1]![0].toFixed(2)},${height} Z`;

  const last = pts[pts.length - 1]!;
  const tooltipText = caption
    ? `${caption} · ${values[values.length - 1]} (last)`
    : `Last: ${values[values.length - 1]}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("block", className)}
      role="img"
      aria-label={tooltipText}
    >
      <title>{tooltipText}</title>
      {area && (
        <path d={areaPath} fill={SPARK_TONE[tone]} fillOpacity={0.12} stroke="none" />
      )}
      <path
        d={linePath}
        fill="none"
        stroke={SPARK_TONE[tone]}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last-value dot */}
      <circle
        cx={last[0]}
        cy={last[1]}
        r={2}
        fill={SPARK_TONE[tone]}
        data-end={id}
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// BarChart
// ─────────────────────────────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
  /** Optional pre-formatted value (defaults to value.toLocaleString()). */
  display?: string;
  /** Optional second value rendered at the right edge (e.g. %). */
  secondary?: string;
}

interface BarChartProps {
  data: BarDatum[];
  tone?: "brass" | "teal" | "rust";
  /** Total height in pixels; bars share this. Default 220. */
  height?: number;
  /** Render the left-edge axis label. */
  showValues?: boolean;
  className?: string;
}

const BAR_TONE_BG: Record<NonNullable<BarChartProps["tone"]>, string> = {
  brass: "bg-brass",
  teal: "bg-teal",
  rust: "bg-rust",
};

const BAR_TONE_FG: Record<NonNullable<BarChartProps["tone"]>, string> = {
  brass: "text-brass",
  teal: "text-teal",
  rust: "text-rust",
};

export function BarChart({
  data,
  tone = "brass",
  height = 220,
  showValues = true,
  className,
}: BarChartProps) {
  if (data.length === 0) {
    return (
      <div className="text-textMuted text-[13px] py-6 text-center">no data</div>
    );
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={cn("flex flex-col gap-2.5", className)} style={{ minHeight: height }}>
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        return (
          <div key={i} className="flex items-center gap-3">
            <div
              className="w-[28%] min-w-0 truncate text-[12px] text-text font-mono"
              title={d.label}
            >
              {d.label}
            </div>
            <div className="flex-1 relative h-[18px] bg-panel border border-borderSoft">
              <div
                className={cn("absolute inset-y-0 left-0", BAR_TONE_BG[tone])}
                style={{ width: `${pct}%` }}
                role="img"
                aria-label={`${d.label}: ${d.display ?? d.value}`}
              >
                <svg width="100%" height="100%" aria-hidden>
                  <title>{`${d.label}: ${d.display ?? d.value}`}</title>
                </svg>
              </div>
            </div>
            {showValues && (
              <div
                className={cn(
                  "w-[120px] text-right font-mono text-[12px] tabular-nums",
                  BAR_TONE_FG[tone],
                )}
              >
                <span className="text-text">{d.display ?? d.value.toLocaleString()}</span>
                {d.secondary && (
                  <span className="ml-2 text-textMuted text-[11px]">
                    {d.secondary}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// LineChart (time series)
// ─────────────────────────────────────────────────────────────────────

export interface LineDatum {
  /** Optional x label shown on hover; if absent we use index. */
  label?: string;
  value: number;
}

interface LineChartProps {
  data: LineDatum[];
  height?: number;
  tone?: "brass" | "teal" | "rust";
  /** Render a y-axis with 0 / mid / max ticks. Default false. */
  yAxis?: boolean;
  /** Render an x-axis with the first / mid / last labels. */
  xAxis?: boolean;
  className?: string;
}

const LINE_TONE: Record<NonNullable<LineChartProps["tone"]>, string> = {
  brass: "var(--brass)",
  teal: "var(--teal)",
  rust: "var(--rust)",
};

export function LineChart({
  data,
  height = 200,
  tone = "brass",
  yAxis = false,
  xAxis = true,
  className,
}: LineChartProps) {
  if (data.length === 0) return null;
  const paddingLeft = yAxis ? 36 : 8;
  const paddingRight = 8;
  const paddingTop = 8;
  const paddingBottom = xAxis ? 22 : 8;
  const width = 600;
  const innerW = width - paddingLeft - paddingRight;
  const innerH = height - paddingTop - paddingBottom;
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value), 0);
  const range = max - min || 1;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const pts = data.map((d, i) => {
    const x = paddingLeft + i * stepX;
    const y = paddingTop + innerH - ((d.value - min) / range) * innerH;
    return { x, y, d };
  });

  const linePath = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
  const areaPath =
    `M${pts[0]!.x.toFixed(2)},${paddingTop + innerH} ` +
    pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ") +
    ` L${pts[pts.length - 1]!.x.toFixed(2)},${paddingTop + innerH} Z`;

  const yTicks = yAxis ? [min, (min + max) / 2, max] : [];
  const xTicks = xAxis
    ? pts.length > 0
      ? [pts[0]!, pts[Math.floor(pts.length / 2)]!, pts[pts.length - 1]!]
      : []
    : [];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={cn("block", className)}
      role="img"
      aria-label="Time series chart"
    >
      {/* Y-axis ticks */}
      {yAxis && (
        <g>
          {yTicks.map((v, i) => {
            const y = paddingTop + innerH - ((v - min) / range) * innerH;
            return (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  x2={width - paddingRight}
                  y1={y}
                  y2={y}
                  stroke="var(--borderSoft)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                />
                <text
                  x={paddingLeft - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="var(--textFaint)"
                  fontFamily="IBM Plex Mono, monospace"
                  fontSize="9"
                >
                  {Math.round(v).toLocaleString()}
                </text>
              </g>
            );
          })}
        </g>
      )}
      {/* Area + line */}
      <path d={areaPath} fill={LINE_TONE[tone]} fillOpacity={0.12} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={LINE_TONE[tone]}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* X-axis tick labels */}
      {xAxis && (
        <g>
          {xTicks.map((p, i) => (
            <text
              key={i}
              x={p.x}
              y={height - 6}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              fill="var(--textFaint)"
              fontFamily="IBM Plex Mono, monospace"
              fontSize="9"
            >
              {p.d.label ?? ""}
            </text>
          ))}
        </g>
      )}
      {/* Hover dots with native tooltip */}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={0.001} fill="transparent" stroke="none">
          <title>{`${p.d.label ?? `#${i + 1}`}: ${p.d.value.toLocaleString()}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stat tile — combines a number, a label, an optional delta, and an
// inline sparkline. Designed to be the building block of the home
// dashboard.
// ─────────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Pre-formatted value for the sparkline tooltip. */
  formatted?: string;
  delta?: { value: number; suffix?: string };
  spark?: number[];
  tone?: "brass" | "teal" | "rust";
  icon?: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Inline style for the wrapping element (e.g. CSS grid placement). */
  style?: CSSProperties;
}

const DELTA_POSITIVE = "text-teal";
const DELTA_NEGATIVE = "text-rust";

export function StatTile({
  label,
  value,
  formatted,
  delta,
  spark,
  tone = "brass",
  icon,
  hint,
  className,
  style,
}: StatTileProps) {
  return (
    <div
      style={style}
      className={cn(
        "relative bg-panel border border-border p-3.5 flex flex-col gap-2",
        "hover:border-borderSoft transition-colors",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="mono-caps text-[10px] text-textMuted">{label}</span>
        {icon && <span className="text-textFaint">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[22px] leading-none text-text tabular-nums">
          {value}
        </span>
        {delta && (
          <span
            className={cn(
              "mono-caps text-[10px] tabular-nums",
              delta.value >= 0 ? DELTA_POSITIVE : DELTA_NEGATIVE,
            )}
          >
            {delta.value >= 0 ? "▲" : "▼"} {Math.abs(delta.value)}
            {delta.suffix ?? ""}
          </span>
        )}
        {formatted && (
          <span className="text-[11px] text-textMuted ml-auto">{formatted}</span>
        )}
      </div>
      {spark && spark.length > 0 && (
        <div className="mt-auto pt-1">
          <Sparkline values={spark} tone={tone} height={28} width={220} />
        </div>
      )}
      {hint && <div className="text-[11px] text-textMuted">{hint}</div>}
    </div>
  );
}
