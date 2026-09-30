# Chat Sources: fix ordering bug causing duplicate Sources blocks

## Problem
When a model produces a short response (< 20 chars body) alongside live
search, the user sees **two identical Sources blocks** and a confusing
response. Example: user says "hi", model responds "Hi" (2 chars), then
the client shows:

```
Sources
- [Hi](url)
- [Adolf Hitler](url)
...
Sources
- [Hi](url)
- [Adolf Hitler](url)
...
```

The model DID respond (the body "Hi" is present) — it's just very short.

## Root cause
In `backend/src/routes/chat.ts` (lines 321–359), the execution order is:

1. `planSourcesInjection(assembled, searchSources)` — strips the model's
   own `## Sources` block from `assembled`, sends a delta with
   `replaced_length` to the client, and updates `assembled` to include the
   injected Sources block.
2. `isSourcesOnlyResponse(assembled)` — checks whether the body (text
   minus Sources) is < 20 chars. But `assembled` now contains the
   **injected** Sources block from step 1, so the check sees a body of
   "Hi" (2 chars) + injected Sources and fires the refetch.
3. `refetchIfSourcesOnly(...)` re-queries the model, streams the new body,
   and appends **another** `## Sources` block of its own (sources-only.ts
   line 142).

Result: client accumulates model tokens → injection delta (replacing model's
Sources with canonical Sources) → refetch tokens → second Sources block.

## Fix
Swap the order so the sources-only check runs on the **raw** model output
(before injection), and injection only runs on the **final** assembled text
(after any refetch). The refetch path already handles its own Sources
injection (sources-only.ts:139–146), so we must not inject twice.

### New ordering in `chat.ts`:

```
assembled = model output;

// 1. Check for sources-only BEFORE injection (raw model output).
if (isSourcesOnlyResponse(assembled) && searchSources.length > 0) {
    refetch → streams new body + appends canonical Sources
    assembled = refetch result;
}

// 2. Inject canonical Sources (only if refetch didn't happen, or if
//    the refetch result still needs the Sources section).
if (!refetched) {
    injection = planSourcesInjection(assembled, searchSources);
    assembled = injection.text;
    stream injection delta;
}
```

Concretely, lines 316–358 change from:

```
// OLD (broken):
const injection = planSourcesInjection(assembled, searchSources);
if (injection.delta !== null) { ... send delta ... }
if (isSourcesOnlyResponse(assembled) && searchSources.length > 0) { ... refetch ... }
```

to:

```
// NEW:
let refetched = false;
if (isSourcesOnlyResponse(assembled) && searchSources.length > 0) {
    const refetch = await refetchIfSourcesOnly({ ... }, stream);
    if (refetch.refetched) {
        assembled = refetch.assembled;
        promptTokens = refetch.promptTokens ?? promptTokens;
        completionTokens = refetch.completionTokens ?? completionTokens;
        refetched = true;
    }
}
if (!refetched) {
    const injection = planSourcesInjection(assembled, searchSources);
    if (injection.delta !== null) {
        assembled = injection.text;
        await stream.writeSSE({ event: "token", data: JSON.stringify({ delta: injection.delta, ... }) });
    }
}
```

## Files to change
| File | Change |
|---|---|
| `backend/src/routes/chat.ts` | Move `isSourcesOnlyResponse` check + refetch BEFORE `planSourcesInjection`. Gate injection on `!refetched`. |

## Out of scope
- Model response quality (the "Hi" body is model behavior, not a code bug)
- `sources-injection.ts` / `sources-only.ts` internals (both are correct in isolation; the bug is purely ordering)
- Client-side rendering

## Verification
1. `cd backend && bun run typecheck` — clean
2. `cd backend && bun run lint:ratchet` — 0 warnings
3. `cd backend && bun run test` — 112 pass / 2 fail (pre-existing DNS)
4. `bun test src/lib/chat/sources-injection.test.ts` — 7/7 pass (helper unchanged)
5. Runtime: send "hi" via chat with live search enabled → verify exactly ONE Sources block appears in the response, not two
6. Runtime: send a normal query with search → verify Sources block appears exactly once
7. Runtime: send a query without search → verify no Sources injection
