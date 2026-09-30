# Palette Refresh — fix drab/grey feel in both themes

## Root cause
Both palettes are built entirely from desaturated grey tones. The only
colour in the whole UI is the brass accent — and it's dark/muted in light
mode (140 97 16) while the dark theme leans into cold slate-blue. The
result: every surface, border, and text layer is a different shade of grey.
There is nothing to look at. The UI has no vibrancy, no visual interest, and
no energy.

Modern AI products solve this by adding **colour-tinted neutrals** (not
pure grey) and **saturated accents**. The fix is a CSS-only palette swap —
no component changes needed.

## Direction

### Dark theme — "deep indigo" with bright gold/teal accents
Current dark is cool slate (28 32 44) with muted brass (220 184 64) as the
only warm tone. New dark uses a deeper navy with better surface stepping,
brighter brass, and teal as a visible secondary accent:

| Token | Current (grey) | New (tinted) | Why |
|---|---|---|---|
| bg | 28 32 44 | **16 20 38** | Deeper — more contrast between bg and panel |
| panel | 54 62 84 | **26 33 58** | More saturated blue-navy, clearer lift from bg |
| panelAlt | 40 48 66 | **22 28 48** | Distinct from bg — not a grey wash |
| border | 100 114 140 | **55 68 105** | Visible but not grey — has a blue tint |
| borderSoft | 80 94 122 | **40 52 82** | Quiet but present, tinted |
| text | 234 234 242 | **230 235 248** | Slightly warmer than pure white |
| textMuted | 178 186 202 | **150 165 205** | Cooler, but more saturated |
| textFaint | 138 148 168 | **100 115 160** | Visible against navy bg |
| brass | 220 184 64 | **255 205 50** | Bright, saturated gold — the hero colour |
| brassSoft | 156 128 38 | **200 165 40** | Brighter hover state |
| teal | 96 184 168 | **80 220 195** | Vibrant secondary — now actually visible |
| rust | 220 110 86 | **245 120 85** | Warmer, more saturated |
| gridColor | rgba(100,114,140,0.16) | **rgba(55,68,105,0.08)** | Quieter — grid fades into bg |
| shadowCard | black 45%/30% | **rgba(0,0,0,0.55), rgba(0,0,0,0.35)** | Tighter, more contrast |
| shadowCardHover | black 50%/35% | **rgba(0,0,0,0.60), rgba(0,0,0,0.40)** | More lift |

### Light theme — "warm cream with rich earth accents"
Current light is near-grey (238 237 234 bg) with dark brass (140 97 16).
New light is warmer, more saturated, with a brighter brass that still passes
AA:

| Token | Current (grey) | New (tinted) | Why |
|---|---|---|---|
| bg | 238 237 234 | **248 245 240** | Warmer cream, not muddy grey |
| panel | 255 255 255 | 255 255 255 | Unchanged — white cards pop |
| panelAlt | 228 227 223 | **232 226 216** | Warmer beige, more visible inset |
| border | 190 187 180 | **195 188 174** | Warmer, slightly more saturated |
| borderSoft | 214 211 204 | **218 212 202** | Warm divider |
| text | 28 27 25 | **22 20 18** | Near-black, same |
| textMuted | 80 77 72 | **75 70 62** | Warmer grey |
| textFaint | 112 106 96 | **125 118 106** | Warm, AA |
| brass | 140 97 16 | **165 105 12** | Richer, more saturated — visible against warm bg |
| brassSoft | 176 138 48 | **195 145 35** | Brighter hover |
| teal | 34 94 82 | **28 115 92** | More saturated, matches dark's vibrancy |
| rust | 160 62 40 | **175 60 30** | Slightly warmer |
| gridColor | rgba(28,27,25,0.05) | **rgba(22,20,18,0.03)** | Quieter grid |
| shadowCard | black 5%/7% | **rgba(22,20,18,0.06), rgba(22,20,18,0.08)** | Warmer shadow tone |
| shadowCardHover | black 7%/10% | **rgba(22,20,18,0.08), rgba(22,20,18,0.12)** | Warmer hover |

### Also sync svg-theme.ts
Both the `dark` and `light` objects in `svg-theme.ts` must match the new
CSS values (workflow canvas uses hex fills, not CSS vars). Update both.

## Files changed
| File | Change |
|---|---|
| `frontend/src/styles/index.css` | Replace both `:root` colour blocks (dark lines 26–45, light lines 85–99). No structural changes. |
| `frontend/src/pages/workflow-editor/svg-theme.ts` | Replace `dark` and `light` objects to match new CSS values. |

## Verification
1. `bun run typecheck` — clean
2. `npx eslint src --ext .ts,.tsx` — 0 warnings
3. `bun run build` — succeeds
4. Toggle dark ↔ light and confirm:
   - Dark mode: deep navy bg, blue-tinted panels, bright gold accent, visible teal secondary
   - Light mode: warm cream bg, warm beige insets, rich brass accent
   - Both modes: no washed-out grey, no muddy surfaces
5. Run the contrast checker to verify WCAG AA on all text/accent vs surface pairs
