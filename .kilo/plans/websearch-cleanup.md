# Web Search page — readability + performance cleanup

## Problem
The Web Search page (`frontend/src/pages/WebSearch.tsx`) shows a "Direct answer"
that is unreadable. Root cause, confirmed in code:

- The backend `answer` field is `answerBox || topMarkdown` where `topMarkdown`
  is the **raw markdown dump of the top result's entire page** — up to 12,000
  chars in `lightpanda.ts`, then sliced to 4,000 in `websearch.ts:318/340`.
  For a query with no search-engine answer box, the whole page (nav, images,
  social-share links, footer) becomes the "answer".
- The frontend renders it as **plain text** (`WebSearch.tsx:149`), so every
  `#`, `##`, `[text](url)`, `![](image)` and share URL is shown verbatim as a
  wall of text. The app already has a `Markdown` component
  (`components/ui/Markdown.tsx`, used in Chat/Panels/Skills) — the page just
  doesn't use it.
- The results list is cluttered: duplicate URLs (same page with/without
  `#anchor`), full raw URLs repeated, no favicons.

## Changes

### 1. Backend — make `answer` a concise answer, not a page dump
`backend/src/routes/websearch.ts`, in `callLightpandaSearch` (both the `url`
branch and the free-search branch):

- Keep `answerBox` as-is when present (it is already a clean snippet).
- When falling back to `topMarkdown`, **truncate to ~600 chars** instead of
  4,000, and strip leading chrome (nav/footer noise) before truncating.
- Same for the `url` branch: `r.markdown.slice(0, 4000)` → a cleaned ~600-char
  excerpt.

This alone removes the giant blob and shrinks the JSON payload (faster).

### 2. Frontend — render the answer as Markdown
`frontend/src/pages/WebSearch.tsx`:

- Import `Markdown` from `../components/ui/Markdown`.
- Replace the plain-text `<div>{response.answer}</div>` (line 149) with
  `<Markdown content={response.answer} />`.
- Cap the rendered answer height (e.g. `max-h-[320px] overflow-y-auto`) so a
  long answer doesn't dominate the page.

### 3. Frontend — clean up the results list
`frontend/src/pages/WebSearch.tsx` results map (lines 167–195):

- **Deduplicate** by normalised URL (strip `#fragment` and trailing slash)
  before rendering, so the same page doesn't appear twice.
- **Add a favicon** (Google favicon service `https://www.google.com/s2/favicons?domain=…&sz=32`)
  next to each result title, and keep the hostname; drop the full raw URL line
  (or move it to a tiny secondary line).
- Keep the `[n]` index badge and snippet, but tighten spacing.

### 4. Performance notes
- Truncating `answer` (step 1) cuts the response payload from ~4 KB of markdown
  to a few hundred bytes.
- Results are already cached 24h (`web_search_cache`); no change needed there.
- No new dependencies — the `Markdown` component already exists.

## Files to change
| File | Change |
|---|---|
| `backend/src/routes/websearch.ts` | Truncate + clean `answer` (both branches) |
| `frontend/src/pages/WebSearch.tsx` | Render answer via `Markdown`; dedupe results; favicon + hostname; cap answer height |

## Out of scope
- Changing the search provider / lightpanda scraping logic
- Quota / posture behaviour
- The chat SSE search path (separate code path)

## Verification
1. `cd backend && bun run typecheck` + `bun run lint:ratchet` — clean
2. `cd frontend && bun run typecheck` + `npx eslint src --ext .ts,.tsx` — 0 warnings
3. `cd frontend && bun run build` — succeeds
4. Visual: search a query that returns a page-dump answer (e.g. the
   tariquerahman.info case) → the "Direct answer" is now a short, formatted
   excerpt (headings/links render), not a wall of raw markdown; results show
   favicons and no duplicate URLs.
