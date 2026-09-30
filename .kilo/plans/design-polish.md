# Design Polish — addressing "looks flat and not standard"

## Problem
The current visual language is deliberately **terminal / brutalist** — sharp
corners everywhere, hairline 1px borders, tiny fonts (10–13 px), minimal
elevation, and content that hugs the edges. Evidence in code:

- `components/ui/Button.tsx` — `rounded-none` hard-coded into the base class
- `components/ui/Input.tsx` — `rounded-none` hard-coded; label is 11 px
- `pages/Skills.tsx` — 5 separate `rounded-none` overrides on inputs
- `pages/Panels.tsx` — panels explicitly `rounded-none`
- `pages/Workflows.tsx` — buttons and panels explicitly `rounded-none`
- 1 px borders are the only thing separating inputs from the page
- Page padding is often `p-2` or `p-3`; no consistent content max-width (pages
  pick `max-w-[960px]`, `[1080px]`, `[1100px]`, `[1280px]`, `[380px]` ad hoc)
- Text scales are very tight: body is 13 px, mono-caps labels are 10–11 px
- Only overlays (modals, popovers, sheets, toasts) use `shadow-*`; in-flow
  cards rely on borders alone
- Transitions are missing on most interactive elements (only `transition-colors`
  on a few hover targets)
- No content-area header pattern: many pages are just `<div className="p-6 …">`

This reads as "developer tool", which is intentional — but in 2026 it feels
outdated and inconsistent with what users expect from a hosted AI product
(Linear, Notion, Vercel, Anthropic Console, ChatGPT).

## Goal
Bring the UI up to a **standard polished modern** look while keeping the
project's strong identity (mono-caps labels, brass accent, terminal sensibility)
as a recognizable accent layer. Three directions to choose between:

| Direction | Character | Risk |
|---|---|---|
| **A. Subtle polish (recommended)** | 6 px corner radius on inputs/buttons/cards, soft 1-layer shadows on cards, bigger spacing, 14 px body, smooth 150 ms transitions everywhere. The brass accent and mono-caps labels stay. Closest to Linear / Vercel. | Lowest — reads "modern but still HELM". |
| **B. Full Material/Fluent conversion** | Rounded, shadows, spring transitions, segmented controls. Throws away the terminal accent. | High — most existing components would need rewrites, identity loss. |
| **C. Brutalist-on-purpose** | Keep sharp corners but make it *intentional*: heavier 2 px borders, monospace body, ASCII art accents, sharper contrast. Reads as "engineered by hand". | Low — but the user said "not standard", so this probably won't satisfy. |

I strongly recommend **A** (subtle polish) because it lands the user's complaint
("flat and not standard") while preserving what is already strong about the
design (mono-caps system, brass accent, dark mode).

## Concrete changes (Direction A)

### 1. Border radius — introduce a controlled rounding scale
Add CSS variables for radius tokens and use them in base components. Keep
`rounded-none` opt-in for the few terminal-style indicators (the chevron, the
mono-caps labels), but the default for surfaces is now rounded.

```css
:root {
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 14px;
}
```

Update:
- `components/ui/Button.tsx` — drop `rounded-none`, use `rounded-[var(--radius-md)]`
- `components/ui/Input.tsx` — same
- `components/ui/feedback/Toast.tsx` — same
- `components/ui/layout/SideSheet.tsx` — already rounded-2xl, keep
- ~15 explicit `rounded-none` overrides in `pages/*.tsx` → switch to `rounded-md`
  or `rounded-lg` depending on element size

### 2. Elevation — add real shadows to in-flow cards
Today the only shadows are on modals/sheets. Add a 1-layer shadow to cards so
they read as "lifted" from the surface.

```css
--shadowCard: 0 1px 2px rgba(28, 27, 25, 0.04), 0 1px 3px rgba(28, 27, 25, 0.06);
--shadowCardHover: 0 2px 4px rgba(28, 27, 25, 0.06), 0 4px 8px rgba(28, 27, 25, 0.08);
```

Apply:
- Cards in `pages/Workflows.tsx`, `pages/Panels.tsx`, `pages/Skills.tsx`,
  `pages/Marketplace.tsx`, `pages/Approvals.tsx`, `pages/Watches.tsx`
- Form sections in `pages/Settings.tsx`
- Inputs gain shadow on focus instead of just border colour swap

### 3. Typography hierarchy — bigger body, more breathing room
The body is 13 px and mono-caps labels are 10–11 px. That's terse to the point of
being hard to scan.

- Body text: 13 px → **14 px**
- Page heading: add a single, prominent page title pattern
- Mono-caps: keep at 10–11 px but add consistent `tracking-wider` (already there)
- Default line-height: 1.5 → **1.55**

Add a `<PageHeader>` component used by every page:
- Title (`h1`, 20 px, font-display, font-medium)
- Subtitle (`text-textMuted`, 13 px)
- Right-aligned actions slot
- Optional breadcrumb / section

Pages without it today: Settings, Providers, Workflows, Panels, Marketplace,
Watches, Health, etc.

### 4. Consistent content width and spacing
- Add `.content-page { @apply max-w-[1200px] mx-auto px-6 py-6; }` and use it
  everywhere. Replace the per-page `max-w-[960|1080|1100|1280|380]` with this
  one rule.
- Standardise spacing inside cards to `p-4` (was often `p-3`); spacing between
  sections `space-y-6` (was often `space-y-4`).

### 5. Interactive feedback
- Buttons: add `active:scale-[0.98]` and `transition-[background-color,border-color,transform] duration-150`
- Inputs: focus ring uses a shadow, not just a border swap
- Nav links: `transition-colors duration-150` on hover (already present in most
  places; add where missing)
- Hover lifts on cards: `hover:shadowCardHover hover:-translate-y-px transition-all duration-150`

### 6. Replace custom font stack with one body + one display + one mono
Current fonts: Inter (body), Space Grotesk (display headings), IBM Plex Mono
(mono labels). Loaded via Google Fonts in `index.html`.

Drop Space Grotesk → use Inter at display sizes with `font-weight: 600`. That
removes one font and saves ~30 KB on first paint. Mono stays IBM Plex Mono for
the terminal accent.

### 7. Page skeleton and empty states
Skeleton component already exists (`PageSkeleton.tsx`) but most pages render
their own ad-hoc skeletons (3 occurrences of `bg-panel animate-pulse`). Switch
them to `PageSkeleton`. Empty-state rows in lists should have a centered
illustration-free empty state with primary action.

### 8. Sidebar polish
The new sidebar (just shipped) still uses hairline borders and
`text-textMuted` links that don't communicate selected state strongly enough
once Core is collapsed. Add:
- A subtle vertical gradient on the brand header (`from-panel to-panelAlt`)
- Stronger active state for the selected NavLink (brass left-border 3 px instead
  of 2 px, and `font-medium` on the label)
- The collapsed group header chevron rotates with a 150 ms `transition-transform`
  (already there) but the group header itself gets `transition-colors` on hover

## Files to change
| File | Change |
|---|---|
| `frontend/src/styles/index.css` | Add `--radius-sm/md/lg/xl` and `--shadowCard/CardHover` CSS variables; body font-size 14 px; line-height 1.55; utility classes `.content-page`, `.shadow-card`, `.shadow-card-hover`, `.input-focus-ring` |
| `frontend/src/components/ui/Button.tsx` | Drop `rounded-none`, use `rounded-md`; add focus ring, active scale, transition |
| `frontend/src/components/ui/Input.tsx` | Same; focus uses shadow + border swap; 14 px text; padding bump |
| `frontend/src/components/ui/feedback/Toast.tsx` | Rounded; softer shadow |
| `frontend/src/components/ui/layout/PageHeader.tsx` | New component — title, subtitle, actions |
| `frontend/src/components/shell/Sidebar.tsx` | Brand gradient; stronger active state; 3 px active border |
| `frontend/index.html` | Drop Space Grotesk Google Fonts request; bump Inter weight range |
| `frontend/src/pages/*.tsx` (~15 pages) | Wrap content in `<PageHeader>` + `.content-page`; switch `rounded-none` to `rounded-md/lg`; add `hover:shadow-card-hover hover:-translate-y-px transition-all duration-150` to cards |
| `frontend/src/pages/Skills.tsx` and similar | Remove the 5 duplicate `rounded-none` overrides (now redundant once the base `Input` is rounded) |

## Out of scope
- Dark mode polish (palette already settled in the earlier work)
- Converting to a design-system library (Radix, shadcn) — heavy refactor, only
  justified if the polish pass proves insufficient
- Animation library / Framer Motion — keep CSS transitions only
- Replacing the brass accent — keeping project identity

## Verification
1. `cd frontend && bun run typecheck` — clean
2. `cd frontend && npx eslint src --ext .ts,.tsx` — 0 warnings
3. `cd frontend && bun run build` — succeeds; bundle size delta logged
4. Visual: load `:5173` in **light mode** (the redesign target). Every page
   should feel:
   - Cards visibly sit on the surface (shadow), not float on a hairline.
   - Buttons and inputs are clearly interactive (focus ring, hover lift).
   - Content has consistent left/right margin (no more edge-hugging).
   - Page title and subtitle are prominent (no more "scroll and find it").
5. Cross-theme: toggle dark/light, confirm dark still reads as the same
   product — the new shadows translate correctly via the dark-mode shadow
   tokens.
6. The terminal accents (mono-caps labels, brass dots, ASCII chevrons) are
   still visible and intentional, not lost.
