# Postmortem template

Copy this file to `docs/postmortems/YYYY-MM-DD-<slug>.md` and fill
it in within 7 days of the incident. Blameless tone. Focus on the
system, not the individuals.

---

## Summary

One-paragraph TL;DR. The incident in 2-3 sentences: what broke,
how bad, how long.

- **Date**: YYYY-MM-DD
- **Severity**: 1 / 2 / 3 / 4 (see `incident-response.md` §2)
- **IC**:
- **Duration**:
- **Customer impact**:
- **Resolved by**:

## Timeline (UTC)

All times in UTC. Add a row for every meaningful event — every
status update, every command run, every decision made.

```
HH:MM  IC: declared incident, opened #incident-...
HH:MM  IC: rolled back to <commit>
HH:MM  COMMS: status page updated
HH:MM  IC: declared resolved
```

## Root cause

What was the underlying cause, not the symptom? "The DB ran out of
connections" is a symptom; "the migration added an unbounded
index that scanned on every INSERT" is a root cause.

## Contributing factors

Things that made it worse. Be specific. "Slow CI" is not a
contributing factor; "CI took 45 minutes because we don't cache
docker layers" is.

## What went well

What worked? This is the most under-reported section. If the IC
made the right call in the first 5 minutes, say so. If the rate
limits absorbed the attack, say so.

## What went poorly

What made the response harder? Be honest. "We couldn't find the
runbook" is fine — that's actionable.

## Action items

Every action item needs an owner and a due date. Owners are people,
not teams.

| Action                                                  | Owner | Due         |
| ------------------------------------------------------- | ----- | ----------- |
| Add rate-limit on `/api/foo`                            | @x    | YYYY-MM-DD  |
| Add alerts on `pg_stat_activity.waiting > 10`           | @y    | YYYY-MM-DD  |
| Move runbook to repo root so it's discoverable          | @z    | YYYY-MM-DD  |

## Lessons

Free-form. One bullet per lesson. "Always run the migration in
staging first" is a lesson; "be more careful" is not.
