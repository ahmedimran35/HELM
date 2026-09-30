# Light Mode Palette — Round 2 (bolder, with real surface separation)

## Goal
Make light mode read as a deliberate, premium light theme (Claude/Anthropic lineage) with clearly
visible structure. The user's verdict on Round 1: **"I still see the same colour."** That is a correct
observation — Round 1 collapsed the palette into one flat warm off-white field.

## Root cause (Round 1 regression — verified with evidence)

Round 1 was too conservative *and* it broke the token hierarchy the whole UI relies on. Two tokens
carry almost all of the app's visual structure, and both were made nearly invisible:

| Token | Before (was visible) | Round 1 (now) | Contrast vs white panel | Effect |
|---|---|---|---|---|
| `--panelAlt` | `240 232 215` | `246 244 241` | **≈1.03:1** | ~100 uses as `bg-panelAlt` — inputs, code blocks, inset cards, table headers. All became indistinguishable from their container. |
| `--borderSoft` | `150 130 95` (≈3.5:1) | `225 222 217` | **≈1.09:1** | ~100 uses as `border-b border-borderSoft` row dividers and `divide-y`. Every separator vanished. |
| `--border` | `130 110 80` (≈4.9:1) | `214 211 205` | **≈1.39:1** | Card/input outlines became faint hairlines. |
| `--bg` | `245 240 230` | `244 243 240` | ΔR −1 / ΔG +3 / ΔB +10 | Imperceptible shift. |
| `--panel` | `255 255 255` | `255 255 255` | unchanged | — |

Net: bg ≈ panel ≈ panelAlt, and every border ≈ invisible. The three-level surface stack that dark mode
has (bg → panelAlt → panel, all clearly stepped) no longer existed, so the UI read as one washed-out
sheet. This is why it "looks the same" and simultaneously "bad".

Confirmed not a build/caching issue: `:5173` serves `244 243 240`, `dist/` is current, `theme-init.js`
correctly defaults to light, no `dark:` utility classes exist, and the backend does not serve the SPA.

## Design rule for Round 2
Light mode must reproduce dark mode's **layered separation**, inverted. Dark mode's steps are large
(`bg 28,32,44` → `panelAlt 40,48,66` → `panel 54,62,84`). Light mode needs comparable perceptual steps:

- `panel` (white) must **pop up** off `bg` → target ≥ 1.15:1
- `panelAlt` must read as an **inset** → target ≥ 1.25:1 vs panel, and ≥ 1.08:1 vs bg
- `border` must be a **visible** hairline → target ≥ 1.7:1
- `borderSoft` must be a **visible but soft** divider → target ≥ 1.4:1
- Reduce warm/yellow cast: keep R−B spread small (≤ 8) instead of the old 15

## Token values (contrast ratios computed against sRGB)

Replace the `:root[data-theme="light"]` block in `frontend/src/styles/index.css` (currently lines 54–88):

| Token | New value (channel RGB) | Hex | Rationale |
|---|---|---|---|
| `--bg-rgb` | `238 237 234` | `#eeedea` | Neutral light paper. **1.17:1 vs white panel** → panels pop. Warm cast reduced (R−B = 4). |
| `--panel-rgb` | `255 255 255` | `#ffffff` | Unchanged — white cards pop up off bg. |
| `--panelAlt-rgb` | `228 227 223` | `#e4e3df` | **1.28:1 vs panel, 1.10:1 vs bg** → insets/inputs clearly distinct again. |
| `--border-rgb` | `190 187 180` | `#bebbb4` | **1.92:1 vs panel** → crisp, visible outlines. |
| `--borderSoft-rgb` | `214 211 204` | `#d6d3cc` | **1.50:1 vs panel** → dividers visible but quiet. |
| `--text-rgb` | `28 27 25` | `#1c1b19` | **14.7:1 vs bg (AAA)**. Warm charcoal, not blue-black. |
| `--textMuted-rgb` | `82 79 74` | `#524f4a` | **6.96:1 vs bg (AAA)**. |
| `--textFaint-rgb` | `118 112 101` | `#767065` | **4.91:1 vs white (AA pass)** — deliberately darker than Round 1 so faint labels stay legible. |
| `--brass-rgb` | `150 106 22` | `#966a16` | **4.81:1 vs white (AA)**. Strong, unambiguous accent. |
| `--brassSoft-rgb` | `176 138 48` | `#b08a30` | Secondary brass for hover/soft fills. |
| `--teal-rgb` | `34 94 82` | `#225e52` | **7.53:1 vs white (AAA)**. |
| `--rust-rgb` | `160 62 40` | `#a03e28` | **6.53:1 vs white**. |
| `--gridColor` | `rgba(28, 27, 25, 0.05)` | — | Match new text hue. |
| `--shadowMd` | `0 2px 10px rgba(28, 27, 25, 0.10)` | — | Slightly stronger than Round 1's 0.06 so cards lift off the tinted bg. Keep it soft — borders now carry most of the structure. |

Also keep the `--bg`/`--panel`/… legacy aliases in the same block pointing at the new RGB vars.

Update the block comment to state the layering rule (bg < panelAlt < panel in lightness) and the
contrast targets, so a future edit doesn't repeat the Round 1 mistake.

## Ordered tasks

1. **Rewrite the light block** in `frontend/src/styles/index.css` with the table above. Keep the
   `:root, :root[data-theme="dark"]` block untouched.
2. **Sync the SVG tokens** in `frontend/src/pages/workflow-editor/svg-theme.ts` (`light` object) so the
   workflow canvas matches:
   - `bg #eeedea`, `panel #ffffff`, `panelAlt #e4e3df`, `border #bebbb4`, `borderSoft #d6d3cc`
   - `text #1c1b19`, `textMuted #524f4a`, `textFaint #767065`
   - `brass #966a16`, `brassSoft #b08a30`, `brassDark #7d5a12`
   - `teal #225e52`, `tealDark #225e52`, `rust #a03e28`, `rustDark #a03e28`
   - `blue #4a7396`, `purple #6b52a0`, `gray #7d7d78`
   - `shadow rgba(28,27,25,0.10)`, `minimapBg #e6e5e1`
3. **Sync the Avatar light palette** in `frontend/src/components/ui/Avatar.tsx` — the `PALETTE_LIGHT`
   backgrounds must be darker than the new `--bg` so monograms still read. Target ≥ 1.15:1 vs `#eeedea`.
   Suggested pairs (bg / fg): `#dcd7cc`/`#7d5a12`, `#cfe0dc`/`#225e52`, `#ddd6e6`/`#6b52a0`,
   `#d8e2d0`/`#41682f`, `#e3dad0`/`#8a5f18`, `#d3dde6`/`#3f647f`, `#e6d5d5`/`#95412f`,
   `#d2e2da`/`#2f6b50`.
4. **Check the `bg-panel` shadow rule** at `frontend/src/styles/index.css` — the
   `[class*="bg-panel"]:not(...)` selector gives every panel a shadow. With `panelAlt` now tinted,
   confirm inset elements that use `bg-panelAlt` don't accidentally pick up `shadowMd` (the `:not`
   guard should already exclude them — verify).
5. **Verify contrast in-browser** with DevTools in light mode across: Sidebar, Chat, Panels, Providers,
   Settings, Workflows (list + canvas), Workspace, Skills, Status, Analytics.

## Validation
- `cd frontend && bun run typecheck` — clean
- `cd frontend && npx eslint src --ext .ts,.tsx` — 0 warnings (ratchet is currently 0)
- `cd frontend && bun run build` — succeeds
- Load `:5173` with `<html data-theme="light">` and confirm, by eye and via DevTools colour picker:
  inputs/inset cards visibly differ from their container; table row dividers and section rules are
  visible; card outlines are visible; nothing reads as a single flat field
- Confirm dark mode is unchanged

## Risks / notes
- If the user still finds it too subtle after Round 2, the next lever is `--bg` alone (darken toward
  `#e8e7e3` for a stronger paper tint) — everything else already has AA-passing separation.
- Warn if any orange/amber global filter or monitor colour profile is in play; the previous bg was
  genuinely yellow-cast (`245 240 230`), so a partially colour-managed display may have muted it.
- `.kilo/worktrees/chalk-single/` and `.kilo/worktrees/winter-radar/` still hold the Round 0 palette.
  Out of scope, but if a browser or dev server points there it will show old colours.

## Out of scope
- Dark mode redesign
- Typography, spacing, or layout changes
- Removing the `data-theme` toggle mechanism
