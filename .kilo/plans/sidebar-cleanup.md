# Sidebar Cleanup — reduce visual clutter in the left nav

## Problem
The left sidebar lists **26 nav items in 5 collapsible groups**
(`frontend/src/nav/items.ts`). For an admin — the default login here — that is
26 destinations competing for attention in a 260px rail. Concretely:

| Group | Items | Problem |
|---|---|---|
| chat | 4 | fine |
| build | 5 | fine |
| run | 2 | stub group — one header for 2 items |
| discover | 3 | stub group — one header for 3 items |
| **operate** | **12** | junk drawer; nearly half of everything, and its header shows a "12" badge |

Additional clutter sources:
- The 5 group headers are *always* rendered, even collapsed — permanent chrome.
- Groups are independent toggles, so several can be open at once and stack past
  the fold.
- A **sidebar search box** duplicates ⌘K. The palette already calls
  `/api/search?q=…` (`CommandPalette.tsx:240`) and the backend returns
  `kind: "page"` results filtered by role (`backend/src/routes/search.ts`),
  so the inline filter is a strictly weaker copy of an existing feature.
- Each admin-only item carries a redundant "A" badge, and the group header
  carries a count — both add visual noise without adding information.

Non-admins see 18 items (8 are `adminOnly`); admins see all 26.

## Proposed shape: 5 groups → 4, with admin split out

Regroup into **Core / Build / System / Admin**:

| Group | Items | Count | Visibility |
|---|---|---|---|
| **Core** (open by default) | Home `/`, Chat `/chat`, Panels `/panels`, Approvals `/approvals`, Search `/search`, Knowledge Graph `/kg`, Web Search `/web-search` | 7 | all roles |
| **Build** | Workspace `/workspace`, Workflows `/workflows`, Apps `/apps`, Marketplace `/marketplace`, Sandbox `/sandbox`, Watches `/watches` | 6 | all roles |
| **System** | Health `/health`, Performance `/perf`, Spend Caps `/spend-caps`, Connected Accounts `/connected-accounts`, Settings `/settings` | 5 | all roles |
| **Admin** (collapsed) | Skills `/skills`, Providers `/providers`, Analytics `/analytics`, Integrations `/integrations`, Memory Strategies `/memory-strategies`, Feedback `/feedback`, Status `/status`, Requests `/requests` | 8 | **admin only** |

Totals: `7 + 6 + 5 + 8 = 26` ✓ (matches today's list exactly — nothing is added
or dropped).

Result:
- **Non-admin:** 18 items in 3 groups (Admin group is not rendered at all).
- **Admin:** 26 items in 4 groups, with the 8 admin-only destinations behind a
  single collapsed header instead of mixed into the 12-item junk drawer.

> Role correctness note: `Connected Accounts` and `Settings` are
> `adminOnly: false` today, so they MUST stay in a group visible to all roles.
> The 8 items assigned to **Admin** are exactly the current `adminOnly: true`
> set — verified against `items.ts`: Skills, Analytics, Integrations,
> Providers, Memory Strategies, Feedback, Status, Requests.

## Changes

### 1. `frontend/src/nav/items.ts`
- Replace `NavGroup` (`"chat" | "build" | "run" | "discover" | "operate"`) with
  `"core" | "build" | "system" | "admin"`.
- Re-assign `group` on all 26 items per the table above. Do not touch `path`,
  `label`, `section`, `hint`, or `adminOnly`.
- Update `groupLabel()` for the new four values.
- Update the `groupedNav()` groupless ordering array to
  `["core", "build", "system", "admin"]` (order matters — it drives render order).
- Fix the duplicated header comment (lines 1–5 repeat the same paragraph twice).
- Update the group doc comment (lines 9–20) to describe the new taxonomy.

### 2. `frontend/src/components/shell/Sidebar.tsx`
- **Remove the search box** and all related state: `filter`, `searchRef`, the
  `filteredGroups` memo, and the auto-expand `useEffect`. `groups` (from
  `groupedNav`) is then rendered directly.
- **Switch to accordion:** replace `collapsed: Record<NavGroup, boolean>` with
  `openGroup: NavGroup | null`, initialised to `"core"`. Opening a group closes
  the others; clicking the open group closes it. This bounds the vertical
  footprint to one group's items plus the collapsed headers.
- **Remove the count badge** (`{items.length}`) from each group header.
- **Remove the admin "A" badge** from items — the Admin group is only rendered
  for admins, so the per-item marker conveys nothing.
- Update the file header comment (it currently says "FIVE collapsible sections"
  and documents the search box).
- Keep: brand block, role badge, account footer, theme toggle, logout, and the
  `if (!user) return null` guard **after** all hooks (do not reintroduce the
  hook-order bug fixed earlier).

### 3. `frontend/src/components/ui/Icon/index.tsx`
- `NAV_ICONS` has 25 entries for 26 paths — `/approvals` is missing and falls
  back to a blank `w-3` spacer. Add an entry for `/approvals` so its row aligns
  with the rest.
- Optional: `/` currently maps to `PanelsIcon`, the same icon as `/panels`. Give
  Home its own icon so the two rows are distinguishable.

### 4. `backend/src/routes/search.ts` (⌘K coverage)
`STATIC_PAGES` currently lists only 9 of the 26 destinations, so ⌘K cannot reach
17 pages — including Search, Workflows, Sandbox, Watches and Status. Since ⌘K is
now the *only* way to filter nav, this gap matters more.

Add the missing entries (path, title, subtitle, `adminOnly` mirroring
`items.ts`): `/`, `/approvals`, `/apps`, `/skills`, `/marketplace`,
`/workflows`, `/sandbox`, `/watches`, `/search`, `/kg`, `/perf`, `/spend-caps`,
`/health`, `/memory-strategies`, `/feedback`, `/status`, `/connected-accounts`.

(9 existing + 17 new = 26, matching `items.ts`.)

## Files to change
| File | Change |
|---|---|
| `frontend/src/nav/items.ts` | New 4-group taxonomy; re-assign all 26 items; fix duplicated comment |
| `frontend/src/components/shell/Sidebar.tsx` | Drop search box + filter state; accordion; drop count and "A" badges |
| `frontend/src/components/ui/Icon/index.tsx` | Add `/approvals` to `NAV_ICONS` |
| `backend/src/routes/search.ts` | Extend `STATIC_PAGES` from 9 → 26 entries |

## Out of scope
- **Moving Admin off the sidebar entirely** (e.g. into `Settings` sub-tabs or a
  separate `/admin` hub). That is the larger structural fix and would change
  routing; worth considering as a follow-up, not in this pass.
- Re-routing any page — all 26 destinations stay where they are.
- ⌘K palette behaviour, dark/light palettes, the account footer.

## Verification
1. `cd frontend && bun run typecheck` — clean.
2. `cd frontend && npx eslint src --ext .ts,.tsx` — 0 warnings. (Note: the
   frontend `lint:ratchet` cap is stale at `--max-warnings 96` while actual is 0;
   tightening it to 0 is a separate one-line fix.)
3. `cd backend && bun run typecheck` — clean (for the `search.ts` edit).
4. `cd frontend && bun run build` — succeeds.
5. Visual, on `:5173` as **admin**: 4 headers — Core open, Build/System/Admin
   collapsed. Opening Build collapses Core. No search box. No count badges.
6. Re-login as a **non-admin** to confirm the Admin group is absent and that
   Connected Accounts + Settings are still reachable (they must not be lost).
7. Press ⌘K and confirm the newly added pages (Search, Workflows, Sandbox,
   Watches, Status) appear as results.
