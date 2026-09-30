# Web Search — full rethink (design + core functionality)

## Problem
The Web Search page is unusable: raw Wikipedia page dumps (60 language links) appear as snippets, only 1 result is returned for most queries, the answer is truncated mid-word, and the layout buries the search box under stat cards.

## Root causes (verified in code)

| # | Problem | Code location |
|---|---------|---------------|
| 1 | Snippet is raw page markdown with language links | `websearch.ts:376` — `snippet: r.source === "wikipedia" ? topMarkdown.slice(0, 800) : ""` |
| 2 | Only 1 result (Wikipedia fast-path skips search engines) | `lightpanda.ts:377-408` — early return after Wikipedia match |
| 3 | Answer truncated mid-word at 250 chars | `websearch.ts:301` — `stripped.slice(0, 250)` |
| 4 | Answer and details are redundant (same text, different lengths) | `websearch.ts:300-302` |
| 5 | Layout: stats cards above search box | `WebSearch.tsx:94-106` |

## Changes

### Backend (`websearch.ts` + `lightpanda.ts`)

**1. Clean snippets — use the Wikipedia extract, not raw page markdown.**
- For Wikipedia results: `snippet = answerBox` (the clean REST extract).
- For search engine results: use the search engine's own snippet (from `parseHTMLResults`/`parseSearchResults`).
- Remove the `topMarkdown.slice(0, 800)` line entirely.

**2. More results — combine Wikipedia + search engines.**
- When the Wikipedia fast-path matches, still run the search engines and merge results (Wikipedia first, then search engine results).
- This gives the clean Wikipedia answer PLUS 5-8 additional results.

**3. Sentence-boundary truncation.**
- In `sanitizeAnswer`, truncate `answer` at the last sentence boundary (`.`, `!`, `?`) before 250 chars.
- `details` stays at 2000 chars (the fuller content behind the expandable section).

**4. Clean the `topMarkdown` before using it anywhere.**
- Strip language selectors (the "60 languages" block with its list of language links).
- Strip nav chrome (menus, footers, social-share links).
- This feeds into both `details` and any remaining raw content.

### Frontend (`WebSearch.tsx`)

**5. Redesign layout — search box at top.**
- Move the search box to the top of the page (above the stats).
- Stats become a compact single-row strip below the search box (or a subtle footer).

**6. Clean result cards.**
- Each result: favicon + title (link) + hostname + clean snippet (2-3 lines).
- Remove the raw URL line (already done).
- Snippet is now clean text (from the backend fix).

**7. Direct answer card.**
- Concise, formatted (Markdown), sentence-boundary truncated.
- Brass-accent card with "Direct answer" label.

**8. Details section.**
- Collapsed `<details>` with clean markdown content.
- Only shown when `details` is non-null and different from `answer`.

## Files to change
| File | Change |
|---|---|
| `backend/src/routes/websearch.ts` | Clean snippets (use extract, not raw page); sentence-boundary truncation |
| `backend/src/lib/lightpanda.ts` | Combine Wikipedia + search engine results; strip language selectors from `topMarkdown` |
| `frontend/src/pages/WebSearch.tsx` | Layout redesign: search box at top, compact stats, clean result cards |

## Out of scope
- Changing the search engine scraping logic
- Quota / posture behaviour
- The chat SSE search path

## Verification
1. `cd backend && bun run typecheck` + `bun run lint:ratchet` — clean
2. `cd frontend && bun run typecheck` + `npx eslint src --ext .ts,.tsx` — 0 warnings
3. `cd frontend && bun run build` — succeeds
4. Search "prime minister of Japan" → clean Wikipedia extract as answer, multiple results with clean snippets (no language links), search box at top.