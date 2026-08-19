# Runbooks index

Operational playbooks. The on-call rotation should bookmark this
directory. If you write a new runbook, add it to the index below.

| Runbook                                          | When to use                                                 |
| ------------------------------------------------ | ----------------------------------------------------------- |
| [incident-response.md](./incident-response.md)   | Active incident — page the IC, drive the response           |
| [incident-triage.md](./incident-triage.md)       | Mitigate a single endpoint under attack (block at proxy)    |
| [rotate-secrets.md](./rotate-secrets.md)         | Any secret is suspected-leaked or rotation-due              |
| [recovery.md](./recovery.md)                     | Bring the stack back from a known-good backup / image tag   |
| [postmortem-template.md](./postmortem-template.md)| Write up a closed incident within 7 days                     |

## Conventions

Every runbook follows the same structure:

1. **When to use** — short paragraph at the top
2. **Pre-flight** — what to check BEFORE you start changing things
3. **Procedure** — the actual commands, copy-pasteable
4. **Verification** — how to know it worked
5. **After-action** — what to file / log before closing the incident

If a runbook requires a secret that's not in this repo, prefix the
variable name with `SECRET:` so reviewers know to look it up in
the password manager rather than commit it.
