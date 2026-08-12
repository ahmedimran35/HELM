// Icon system — monoline SVG icons (lucide style) drawn on a 24x24 grid.
// Every icon is a real React component so:
//   - theme colour is inherited via `currentColor`
//   - stroke-width and size are props (not baked in)
//   - the bundle can tree-shake (each export is a separate module)
//
// Naming follows lucide conventions so muscle memory carries over. Icons
// that are unique to HELM (e.g. brass mark, status rings) are namespaced
// under `helm.*`.
//
// Accessibility:
//   - default aria-hidden=true (decorative)
//   - callers can pass aria-label to make it labelled
//   - role="img" when labelled
//
// All strokes are 1.5 to match ops-console density. Square caps, round
// joins — the same line weight the rest of the chrome uses.

import {
  forwardRef,
  type SVGProps,
  type ReactNode,
  type Ref,
} from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number | string;
  strokeWidth?: number | string;
  title?: string;
};

const BaseIcon = forwardRef<SVGSVGElement, IconProps & { d: string; fillRule?: string }>(
  function BaseIcon(
    {
      d,
      size = 16,
      strokeWidth = 1.5,
      title,
      className = "",
      fillRule,
      ...rest
    },
    ref,
  ) {
    const ariaProps = title
      ? ({ role: "img", "aria-label": title } as const)
      : ({ "aria-hidden": true } as const);
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`inline-block shrink-0 ${className}`}
        {...ariaProps}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        <path d={d} fillRule={fillRule} />
      </svg>
    );
  },
);

// Helper: build a polyline/path from sub-paths so we can describe icons
// that need more than one stroke (e.g. a checkmark + a circle).
function Path(
  paths: string[],
  extras: { title?: string; size?: number | string; strokeWidth?: number | string; className?: string } & Partial<SVGProps<SVGSVGElement>> = {},
  ref?: Ref<SVGSVGElement>,
): ReactNode {
  const { title, size = 16, strokeWidth = 1.5, className = "", ...rest } = extras;
  const ariaProps = title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 ${className}`}
      {...ariaProps}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Navigation + page icons
// ─────────────────────────────────────────────────────────────────────

export const ChatIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
    ],
    p,
    r,
  ),
);
ChatIcon.displayName = "ChatIcon";

export const PanelsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z",
      "M16 3v5h5",
      "M8 12h8",
      "M8 16h6",
    ],
    p,
    r,
  ),
);
PanelsIcon.displayName = "PanelsIcon";

export const WorkspaceIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 7h18",
      "M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7",
      "M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      "M12 12v4",
      "M9 14h6",
    ],
    p,
    r,
  ),
);
WorkspaceIcon.displayName = "WorkspaceIcon";

export const SearchIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M11 3a8 8 0 1 0 5.3 14L21 21",
      "M11 3a8 8 0 0 1 8 8",
    ],
    p,
    r,
  ),
);
SearchIcon.displayName = "SearchIcon";

export const AnalyticsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 3v18h18",
      "M7 14l3-4 4 5 5-9",
    ],
    p,
    r,
  ),
);
AnalyticsIcon.displayName = "AnalyticsIcon";

export const RequestsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 6h13",
      "M3 12h13",
      "M3 18h13",
      "M19 6l3 3-3 3",
    ],
    p,
    r,
  ),
);
RequestsIcon.displayName = "RequestsIcon";

export const ProvidersIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2v4",
      "M12 18v4",
      "M4.93 4.93l2.83 2.83",
      "M16.24 16.24l2.83 2.83",
      "M2 12h4",
      "M18 12h4",
      "M4.93 19.07l2.83-2.83",
      "M16.24 7.76l2.83-2.83",
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    ],
    p,
    r,
  ),
);
ProvidersIcon.displayName = "ProvidersIcon";

export const IntegrationsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ],
    p,
    r,
  ),
);
IntegrationsIcon.displayName = "IntegrationsIcon";

export const LayoutIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 3h7v9H3z",
      "M14 3h7v5h-7z",
      "M14 12h7v9h-7z",
      "M3 16h7v5H3z",
    ],
    p,
    r,
  ),
);
LayoutIcon.displayName = "LayoutIcon";

// Slack — four lozenges around an octagon. Monoline outline only so the
// brand-mark glyph reads at 12px in the sidebar and 64px on the
// connected-accounts tile.
export const SlackIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M14.5 10.5a1.5 1.5 0 1 0-1.5-1.5v1.5h1.5z",
      "M9.5 14.5a1.5 1.5 0 1 0 1.5 1.5v-1.5h-1.5z",
      "M6 12a1.5 1.5 0 0 1-1.5-1.5 1.5 1.5 0 0 1 3 0V12H6z",
      "M18 12a1.5 1.5 0 0 1 1.5 1.5 1.5 1.5 0 0 1-3 0V12h1.5z",
      "M12 6a1.5 1.5 0 0 1-1.5-1.5A1.5 1.5 0 0 1 12 1.5V6z",
      "M12 18a1.5 1.5 0 0 1 1.5 1.5A1.5 1.5 0 0 1 12 22.5V18z",
      "M5.6 5.6a1.5 1.5 0 0 1 0-2.12 1.5 1.5 0 0 1 2.12 0L9.5 5.3 7.8 7l-2.2-2.2z",
      "M18.4 18.4a1.5 1.5 0 0 1 0 2.12 1.5 1.5 0 0 1-2.12 0L14.5 18.7l1.7-1.7 2.2 2.2z",
      "M5.6 18.4a1.5 1.5 0 0 1-2.12 0 1.5 1.5 0 0 1 0-2.12L5.3 14.5 7 16.2l-2.2 2.2z",
      "M18.4 5.6a1.5 1.5 0 0 1 2.12 0 1.5 1.5 0 0 1 0 2.12L18.7 9.5 17 7.8l2.2-2.2z",
      "M9.5 9.5a3 3 0 0 1 3-3h1.5a3 3 0 0 1 3 3v1.5a3 3 0 0 1-3 3h-1.5a3 3 0 0 1-3-3V9.5z",
    ],
    p,
    r,
  ),
);
SlackIcon.displayName = "SlackIcon";

export const SettingsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    ],
    p,
    r,
  ),
);
SettingsIcon.displayName = "SettingsIcon";

// ─────────────────────────────────────────────────────────────────────
// Action icons
// ─────────────────────────────────────────────────────────────────────

export const PlusIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M12 5v14", "M5 12h14"], p, r),
);
PlusIcon.displayName = "PlusIcon";

export const CheckIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M20 6 9 17l-5-5"], p, r),
);
CheckIcon.displayName = "CheckIcon";

export const XIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M18 6 6 18", "M6 6l12 12"], p, r),
);
XIcon.displayName = "XIcon";

export const ArrowRightIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M5 12h14", "M12 5l7 7-7 7"], p, r),
);
ArrowRightIcon.displayName = "ArrowRightIcon";

export const ChevronDownIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M6 9l6 6 6-6"], p, r),
);
ChevronDownIcon.displayName = "ChevronDownIcon";

export const ChevronUpIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M18 15l-6-6-6 6"], p, r),
);
ChevronUpIcon.displayName = "ChevronUpIcon";

export const ChevronLeftIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M15 18l-6-6 6-6"], p, r),
);
ChevronLeftIcon.displayName = "ChevronLeftIcon";

export const ChevronRightIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M9 18l6-6-6-6"], p, r),
);
ChevronRightIcon.displayName = "ChevronRightIcon";

export const TrashIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 6h18",
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      "M10 11v6",
      "M14 11v6",
    ],
    p,
    r,
  ),
);
TrashIcon.displayName = "TrashIcon";

export const DownloadIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
      "M7 10l5 5 5-5",
      "M12 15V3",
    ],
    p,
    r,
  ),
);
DownloadIcon.displayName = "DownloadIcon";

export const CopyIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
    p,
    r,
  ),
);
CopyIcon.displayName = "CopyIcon";

export const EditIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
      "M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z",
    ],
    p,
    r,
  ),
);
EditIcon.displayName = "EditIcon";

export const KeyIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
    ],
    p,
    r,
  ),
);
KeyIcon.displayName = "KeyIcon";

export const SendIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M22 2L11 13",
      "M22 2l-7 20-4-9-9-4z",
    ],
    p,
    r,
  ),
);
SendIcon.displayName = "SendIcon";

export const RefreshIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
      "M21 3v5h-5",
      "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
      "M3 21v-5h5",
    ],
    p,
    r,
  ),
);
RefreshIcon.displayName = "RefreshIcon";

export const EyeIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    ],
    p,
    r,
  ),
);
EyeIcon.displayName = "EyeIcon";

export const EyeOffIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94",
      "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24",
      "M1 1l22 22",
    ],
    p,
    r,
  ),
);
EyeOffIcon.displayName = "EyeOffIcon";

export const LogOutIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
      "M16 17l5-5-5-5",
      "M21 12H9",
    ],
    p,
    r,
  ),
);
LogOutIcon.displayName = "LogOutIcon";

export const BellIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9",
      "M13.73 21a2 2 0 0 1-3.46 0",
    ],
    p,
    r,
  ),
);
BellIcon.displayName = "BellIcon";

export const InfoIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z",
      "M12 16v-4",
      "M12 8h.01",
    ],
    p,
    r,
  ),
);
InfoIcon.displayName = "InfoIcon";

export const AlertTriangleIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
      "M12 9v4",
      "M12 17h.01",
    ],
    p,
    r,
  ),
);
AlertTriangleIcon.displayName = "AlertTriangleIcon";

export const SunIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
      "M12 1v2",
      "M12 21v2",
      "M4.22 4.22l1.42 1.42",
      "M18.36 18.36l1.42 1.42",
      "M1 12h2",
      "M21 12h2",
      "M4.22 19.78l1.42-1.42",
      "M18.36 5.64l1.42-1.42",
    ],
    p,
    r,
  ),
);
SunIcon.displayName = "SunIcon";

export const MoonIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"], p, r),
);
MoonIcon.displayName = "MoonIcon";

// ─────────────────────────────────────────────────────────────────────
// Domain-specific icons
// ─────────────────────────────────────────────────────────────────────

export const ModelIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2a4 4 0 0 0-4 4v1H6a2 2 0 0 0-2 2v2H3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1v2a2 2 0 0 0 2 2h2v1a4 4 0 0 0 4 4 4 4 0 0 0 4-4v-1h2a2 2 0 0 0 2-2v-2h1a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V6a2 2 0 0 0-2-2h-2V3a4 4 0 0 0-4-4z",
      "M9 12h6",
      "M12 9v6",
    ],
    p,
    r,
  ),
);
ModelIcon.displayName = "ModelIcon";

export const UserIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
      "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    ],
    p,
    r,
  ),
);
UserIcon.displayName = "UserIcon";

export const LockIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M5 11h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
      "M7 11V7a5 5 0 0 1 10 0v4",
    ],
    p,
    r,
  ),
);
LockIcon.displayName = "LockIcon";

export const DatabaseIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2C6.48 2 2 4.02 2 6.5v11C2 19.98 6.48 22 12 22s10-2.02 10-4.5v-11C22 4.02 17.52 2 12 2z",
      "M2 6.5C2 8.98 6.48 11 12 11s10-2.02 10-4.5",
      "M2 12c0 2.48 4.48 4.5 10 4.5s10-2.02 10-4.5",
    ],
    p,
    r,
  ),
);
DatabaseIcon.displayName = "DatabaseIcon";

export const TerminalIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M4 17l6-6-6-6",
      "M12 19h8",
    ],
    p,
    r,
  ),
);
TerminalIcon.displayName = "TerminalIcon";

export const WebhookIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2",
      "m6 16.01 3.09 5.4",
      "M12 2v5",
      "M11 8h2",
      "M8 8a4 4 0 1 0 7.83 1c0-.6-.16-1.18-.46-1.69",
    ],
    p,
    r,
  ),
);
WebhookIcon.displayName = "WebhookIcon";

// Skills — a small stack of layered cards. Each layer is an offset rect
// so the icon reads as "many skills / many grants" at small sizes.
export const SkillsIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 3 4 7v10l8 4 8-4V7z",
      "M4 7l8 4 8-4",
      "M12 11v10",
    ],
    p,
    r,
  ),
);
SkillsIcon.displayName = "SkillsIcon";

export const FileTextIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      "M14 2v6h6",
      "M16 13H8",
      "M16 17H8",
      "M10 9H8",
    ],
    p,
    r,
  ),
);
FileTextIcon.displayName = "FileTextIcon";

export const PlayIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M5 3l14 9-14 9V3z"], p, r),
);
PlayIcon.displayName = "PlayIcon";

// Mic — used by the voice activity indicator + the workflow voice
// trigger chip. Reads as "speaking into" a small microphone.
export const MicIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v3",
    ],
    p,
    r,
  ),
);
MicIcon.displayName = "MicIcon";

// MicOff — paired with MicIcon for the workflow trigger chip toggle
// ("voice trigger disabled" state). Diagonal slash through the body so
// the disabled meaning is unmistakable at small sizes.
export const MicOffIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M9 9v3a3 3 0 0 0 5.12 2.12",
      "M15 9.34V5a3 3 0 0 0-5.94-.6",
      "M19 10v2a7 7 0 0 1-.6 2.83",
      "M5 10v2a7 7 0 0 0 11.21 5.62",
      "M12 19v3",
      "M2 2l20 20",
    ],
    p,
    r,
  ),
);
MicOffIcon.displayName = "MicOffIcon";

// Gauge — half-arc dial with a needle. Reused for the /perf
// dashboard (latency + throughput) AND the /status sidebar link by
// Tier 7. The downstream definition lives further down this file.

export const StopIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M5 5h14v14H5z"], p, r),
);
StopIcon.displayName = "StopIcon";

export const ClockIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
      "M12 6v6l4 2",
    ],
    p,
    r,
  ),
);
ClockIcon.displayName = "ClockIcon";

export const DollarSignIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2v20",
      "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    ],
    p,
    r,
  ),
);
DollarSignIcon.displayName = "DollarSignIcon";

export const ZapIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
    ],
    p,
    r,
  ),
);
ZapIcon.displayName = "ZapIcon";

// LightningIcon — the workflow builder mark. A jagged bolt with a
// branch so it reads as "graph + lightning". Used in the sidebar so
// the /workflows link is visually distinct from the existing ZapIcon.
export const LightningIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M13 2 4 14h6l-1 8",
      "M11 8h6",
      "M14 14l4 6",
    ],
    p,
    r,
  ),
);
LightningIcon.displayName = "LightningIcon";

export const ActivityIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M22 12h-4l-3 9L9 3l-3 9H2",
    ],
    p,
    r,
  ),
);
ActivityIcon.displayName = "ActivityIcon";

export const InboxIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M22 12h-6l-2 3h-4l-2-3H2",
      "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    ],
    p,
    r,
  ),
);
InboxIcon.displayName = "InboxIcon";

// Thumbs up — closed-fist / cup thumb. Monoline so the outline reads
// at 12px in the chat meta row.
export const ThumbsUpIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M7 10v12",
      "M15 5l-1 5h6.5a2.5 2.5 0 0 1 2.45 3l-1.6 7.5A2.5 2.5 0 0 1 18.9 22H7V10l4-7a2 2 0 0 1 4 2z",
    ],
    p,
    r,
  ),
);
ThumbsUpIcon.displayName = "ThumbsUpIcon";

// Thumbs down — mirror of thumbs up so the pair reads as a balanced
// feedback widget.
export const ThumbsDownIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M17 14V2",
      "M9 17l1-5H3.5a2.5 2.5 0 0 1-2.45-3l1.6-7.5A2.5 2.5 0 0 1 5.1 2H17v12l-4 7a2 2 0 0 1-4-2z",
    ],
    p,
    r,
  ),
);
ThumbsDownIcon.displayName = "ThumbsDownIcon";

export const CheckCircleIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M22 11.08V12a10 10 0 1 1-5.93-9.14",
      "M22 4 12 14.01l-3-3",
    ],
    p,
    r,
  ),
);
CheckCircleIcon.displayName = "CheckCircleIcon";

// SaveIcon — a floppy-style disk mark. Used for the workflow editor
// "Save" button (and any other explicit-save action).
export const SaveIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z",
      "M17 21v-8H7v8",
      "M7 3v5h8",
    ],
    p,
    r,
  ),
);
SaveIcon.displayName = "SaveIcon";

export const LayersIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(["M12 2 2 7l10 5 10-5-10-5Z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"], p, r),
);
LayersIcon.displayName = "LayersIcon";

// App window — a grid-of-4-squares that reads as "an app, a window, a
// gallery". Used for /my-apps in the sidebar so the link doesn't collide
// visually with /apps (LayoutIcon = single quadrant).
export const AppWindowIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 5h7v7H3z",
      "M14 5h7v4h-7z",
      "M14 12h7v7h-7z",
      "M3 15h7v4H3z",
    ],
    p,
    r,
  ),
);
AppWindowIcon.displayName = "AppWindowIcon";

// Gauge — half-arc dial with a needle pointing up-right. Used for
// the /perf dashboard (latency + throughput) and the /status sidebar
// link. Reads as "you're looking at a meter" at 12px and 64px without
// redrawing.
export const GaugeIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 14l4-4",
      "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "M3 14a9 9 0 0 1 18 0",
    ],
    p,
    r,
  ),
);
GaugeIcon.displayName = "GaugeIcon";

// Wallet — slim billfold with a card slot. Used for the /spend-caps
// page so the link reads as money-management at a glance.
export const WalletIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z",
      "M3 7v-.5A1.5 1.5 0 0 1 4.5 5H17",
      "M16 12.5h2.5",
      "M16 12.5a1.5 1.5 0 1 0 0 3h2.5a1.5 1.5 0 1 0 0-3z",
    ],
    p,
    r,
  ),
);
WalletIcon.displayName = "WalletIcon";

// ─────────────────────────────────────────────────────────────────────
// Brand — the brass mark / wordmark accent
// ─────────────────────────────────────────────────────────────────────

export const HelmMark = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 20l4-16h2l4 16",
      "M7 4l3 16",
      "M11 12h6",
      "M17 4l-4 16",
      "M15 4l-3 16",
    ],
    p,
    r,
  ),
);
HelmMark.displayName = "HelmMark";

// ─────────────────────────────────────────────────────────────────────
// Discovery-tier icons (Marketplace, Graph)
// ─────────────────────────────────────────────────────────────────────

// Marketplace — a storefront / shelf glyph. Awning over three rectangles
// that read as "items in a shop". Pairs with the /marketplace nav item
// without competing with AppWindowIcon or LayoutIcon.
export const MarketplaceIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M3 7h18",
      "M5 7l-1 4",
      "M20 7l1 4",
      "M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7",
      "M9 11v3",
      "M12 11v3",
      "M15 11v3",
    ],
    p,
    r,
  ),
);
MarketplaceIcon.displayName = "MarketplaceIcon";

// Graph — three nodes connected by edges. Reads as a small knowledge
// graph; pairs with /kg in the sidebar.
export const GraphIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M5 5h4v4H5z",
      "M15 15h4v4h-4z",
      "M11 7h4v4h-4z",
      "M7 9l3 2",
      "M14 13l3 2",
    ],
    p,
    r,
  ),
);
GraphIcon.displayName = "GraphIcon";

// Star — five-point outline used for ratings in marketplace + citation cards.
export const StarIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
    ],
    p,
    r,
  ),
);
StarIcon.displayName = "StarIcon";

// ─────────────────────────────────────────────────────────────────────
// Tier 3 — Voice + Multimodal icons
// ─────────────────────────────────────────────────────────────────────

// Paperclip — used in the chat input toolbar for the "attach file"
// affordance.
export const PaperclipIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.98 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
    ],
    p,
    r,
  ),
);
PaperclipIcon.displayName = "PaperclipIcon";

// Globe — used for the "browse the web" affordance in the chat input
// toolbar (Tier 3 browser automation).
export const GlobeIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
      "M2 12h20",
      "M12 2a15 15 0 0 1 0 20",
      "M12 2a15 15 0 0 0 0 20",
    ],
    p,
    r,
  ),
);
GlobeIcon.displayName = "GlobeIcon";

// DocumentText — used for the "generate document" affordance.
export const DocumentIcon = forwardRef<SVGSVGElement, IconProps>((p, r) =>
  Path(
    [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      "M14 2v6h6",
      "M9 13h6",
      "M9 17h6",
    ],
    p,
    r,
  ),
);
DocumentIcon.displayName = "DocumentIcon";

// ─────────────────────────────────────────────────────────────────────
// NavItem icon map — single source for sidebar
// ─────────────────────────────────────────────────────────────────────

export const NAV_ICONS: Record<string, typeof ChatIcon> = {
  "/": PanelsIcon,
  "/chat": ChatIcon,
  "/panels": PanelsIcon,
  "/workspace": WorkspaceIcon,
  "/watches": BellIcon,
  "/web-search": SearchIcon,
  "/analytics": AnalyticsIcon,
  "/requests": RequestsIcon,
  "/providers": ProvidersIcon,
  "/integrations": IntegrationsIcon,
  "/connected-accounts": KeyIcon,
  "/memory-strategies": LayersIcon,
  "/apps": LayoutIcon,
  "/sandbox": TerminalIcon,
  "/skills": SkillsIcon,
  "/feedback": ThumbsUpIcon,
  "/status": GaugeIcon,
  "/workflows": LightningIcon,
  "/settings": SettingsIcon,
  "/perf": GaugeIcon,
  "/spend-caps": WalletIcon,
  "/health": ActivityIcon,
  "/marketplace": MarketplaceIcon,
  "/kg": GraphIcon,
  "/search": SearchIcon,
};
