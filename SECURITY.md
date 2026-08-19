# Security policy

This document is the user-facing entry point for security concerns.
The in-repo deployment recipe lives in [HARDENING.md](./HARDENING.md);
operational incident response lives in [docs/runbooks/](./docs/runbooks/).

## Supported versions

| Branch  | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark:  |
| `<` 1y  | :white_check_mark: critical-only backports |
| older   | :x:                |

## Reporting a vulnerability

**Please DO NOT file a public GitHub issue for security bugs.**

Email `security@helmlabs.example` (replace with the real address
when the org is formed). Include:

- A short description of the issue and impact
- Reproduction steps / proof-of-concept
- The affected version / commit SHA
- Whether you want public credit in the advisory

We aim to acknowledge new reports within 48 hours and ship a fix
within 14 days for high-severity issues. Coordinated disclosure
windows are honoured.

## Threat model summary

The full threat model is documented inline across the codebase;
this is the executive view.

**In scope** (we defend against these):

- Cross-site scripting (CSP, security headers, no innerHTML sinks)
- Cross-site request forgery (origin guard on state-changing APIs)
- Session hijacking (HttpOnly + Secure + SameSite cookies,
  rotating session secret, server-side session store)
- Credential stuffing (per-IP + per-username rate limits on
  `/api/login`)
- Sandbox escape (bash restricted env, symlink rejection, seccomp
  defaults applied via k8s/compose)
- Supply-chain attacks (pinned digest base image, SBOM, provenance,
  cosign-signed releases, gitleaks on every commit, weekly trivy)
- IMDS credential exfiltration (egress lockdown verified by
  `egress-check.yml`)

**Out of scope** (documented limitations the operator accepts):

- Physical access to the host
- Compromised developer laptops (mitigated by short-lived OIDC for
  cosign keyless signing)
- Side-channel attacks against the LLM providers themselves

## Hardening layers

The project's security posture is layered; a single layer failing
should not yield RCE or data exfiltration.

1. **Source** — TypeScript, Bun runtime, dependency-pinned via
   `bun.lock` and verified by `npm audit --audit-level=high` in CI.
2. **CI** — gitleaks, trivy (image + fs), SBOM + provenance,
   cosign sign on release, bcryptjs compat smoke test.
3. **Container** — read-only rootfs, drop-ALL caps,
   `no-new-privileges`, non-root user, tini PID-1. See
   `backend/Dockerfile` and HARDENING.md §1.
4. **Network** — egress lockdown (k8s NetworkPolicy or docker
   `--internal`); verified weekly by `egress-check.yml`.
5. **Operational** — short-lived admin password generated on first
   boot; manual rotation cadence documented in
   `docs/runbooks/rotate-secrets.md`.

## Vulnerability disclosures we publish

When we ship a fix for a security bug we publish:

- A GHSA advisory on the GitHub Security tab
- A new docker image tag (`helm-api:<date>-patch`) signed by
  cosign; the previous tag is moved to `:deprecated`
- A blurb in the next release notes

## Contact

- Security email: `security@helmlabs.example`
- PGP key: <https://helmlabs.example/.well-known/pgp-key.asc>
  (publish when the org is formed)
- For urgent, in-progress incidents: see
  `docs/runbooks/incident-response.md`
