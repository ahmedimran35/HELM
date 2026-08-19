# Sandbox Isolation Runbook

The HELM "sandbox" lets a user execute shell commands inside a
per-user working directory. Today (Phase 5+) we use:

> **Current state:** `bash -lc <command>` with a stripped `env`, a
> per-user `cwd` under `tmp/sandbox/<user_id>/`, a hard wall-clock
> timeout, a per-stream output cap, and audit logging of every exec
> call.

That's not a jail. A determined user can `curl`, `wget`, or read
arbitrary files on the host's filesystem (subject to the process's
own UID). It's documented in `backend/src/routes/sandbox.ts`:

```ts
//   * Memory cap is declared in the response but NOT yet enforced via
//     `ulimit`/`prlimit` (Bun.spawn doesn't expose a portable resource-
//     limit knob across macOS/Linux). This is documented in the response
//     so callers know to treat exec as best-effort isolation, not a
//     hardened jail. A future phase should plumb real limits via
//     `unshare`/`firecracker` if we ever ship multi-tenant exec.
//   * No network egress filtering today (the user can run `curl`,
//     `wget`, etc.). Documented limitation; same future work applies.
```

This runbook lays out the upgrade paths.

---

## Why we need stronger isolation

Even with the per-user `cwd`, the user shares:

- The host's UID (the bun process is one process, not per-user).
- The host's filesystem (anything outside `cwd` is readable unless
  POSIX permissions block it).
- The host's network namespace — `curl evil.com` from inside the
  sandbox hits the same egress allowlist as the API.
- The host's `/tmp`, `/proc`, `/sys`, etc.

A user who finds a Bun / kernel / shell escape gets the same
privileges as the bun process. On a single-tenant deployment that's
the operator (acceptable). On multi-tenant (any SaaS posture) it's
not.

---

## Path A: `unshare` (Linux-only, no kernel module required)

`unshare(1)` lets a process enter new namespaces: PID, mount, UTS,
IPC, network, cgroup. Bun can call it via `Bun.spawn({..., env:
{"LD_PRELOAD": ...}})` but a cleaner pattern is to wrap the exec in
a tiny launcher:

```c
// sandbox-launcher.c
#define _GNU_SOURCE
#include <sched.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    // New PID + mount + UTS + IPC + network namespaces.
    if (unshare(CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWUTS |
                CLONE_NEWIPC | CLONE_NEWNET) != 0) {
        perror("unshare");
        return 1;
    }
    // chroot into the per-user dir.
    if (chroot(argv[1]) != 0) {
        perror("chroot");
        return 1;
    }
    if (chdir("/") != 0) { perror("chdir"); return 1; }
    // Drop capabilities (root in the user namespace only).
    // ... setrlimit for CPU + memory ...
    execvp("/bin/bash", &argv[2]);
    perror("execvp");
    return 1;
}
```

Compile once at image build time:

```
gcc -O2 -o /usr/local/bin/sandbox-launcher sandbox-launcher.c
```

Wire it in `backend/src/routes/sandbox.ts`:

```ts
// Replace `bash -lc <cmd>` with `sandbox-launcher <cwd> bash -lc <cmd>`.
const proc = Bun.spawn(["/usr/local/bin/sandbox-launcher", sessionDir(userId, sessionId),
                        "bash", "-lc", cmd], { ... });
```

**Kernel requirements:** Linux ≥ 3.8 (unprivileged user namespaces
on most distros). RHEL-family disallows unprivileged user namespaces
by default; you'd run the launcher as a setuid binary or under a
dedicated service user.

**Image requirements:** the image must ship `/bin/bash` and the
`coreutils` the user expects. We ship a slim Debian base today.

**Migration:** ship the launcher, switch the spawn, keep the existing
audit / timeout / output cap. Phase 6: add cgroup-based memory cap.

---

## Path B: Firecracker (production-grade microVM)

Firecracker (https://github.com/firecracker-microvm/firecracker) gives
us a real hardware-virtualised microVM per exec — KVM-backed,
~125 ms cold start, ~5 MB RSS overhead. This is the bar for
production multi-tenant exec.

**Kernel requirements:** Linux ≥ 4.14 with KVM (`/dev/kvm`
readable/writable by the launcher user). KVM must be enabled in
the host kernel; cloud VMs (EC2, GCE) ship with it.

**Image requirements:** a minimal Linux rootfs (we use a stripped
Debian 12 image, ~50 MB). The image is loaded read-only; the
overlay per session is a separate ext4 disk image.

**Concrete steps:**

1. Provision a `firecracker` binary at `/usr/local/bin/firecracker`.
2. Provision a kernel at `/opt/fc/vmlinux`.
3. Provision the rootfs at `/opt/fc/rootfs.ext4`.
4. Per session:
   - `cp` the rootfs to a per-session file (overlay).
   - Spawn `firecracker --api-sock /tmp/fc-<sid>.sock`.
   - PUT a VM config to the API socket (1 vCPU, 256 MB RAM, block
     device = the overlay, network = a TAP with no route to the
     host's egress).
   - Wait for `InstanceStartEnd` event.
   - Send the user's `bash -lc <cmd>` over the guest's vsock or
     serial console.
   - Stream output back, apply the same timeout/output-cap as today.
   - Tear the VM down (`PUT /actions { action_type: "SendCtrlAltDel" }`).

**Migration:** Phase 7 work. We'd put `firecracker` behind a feature
flag (env: `HELM_SANDBOX_BACKEND=firecracker|bash`), default to `bash`
until the rollout is stable.

---

## Decision matrix

| Workload | Path | Why |
| --- | --- | --- |
| Single-tenant, trusted user | current (bash) | Simplicity wins. |
| Single-tenant, untrusted user | `unshare` | One-day work. Closes the obvious filesystem-share escape. |
| Multi-tenant SaaS | `firecracker` | Hard isolation, scales horizontally. |
| Compliance-bound (SOC2, HIPAA) | `firecracker` | Required by auditors. |

---

## What this runbook doesn't cover (yet)

- **CPU/memory quotas** via cgroups (works for both paths; not yet
  wired because Bun's `spawn` doesn't expose `prlimit` cleanly).
- **Egress filtering** from inside the sandbox. Even with `unshare`,
  the user can `curl`. The egress firewall runbook
  (`EGRESS-FIREWALL.md`) covers the network side.
- **Read-only mounts** of `/etc/passwd`, `/bin`, `/lib` etc. Today the
  user can overwrite `/bin/bash` inside the per-user `cwd` (which is
  already true; that's the per-user boundary). With `unshare` we'd
  mount `/usr` read-only inside the namespace.

Track these in `backend/src/routes/sandbox.ts` as known limitations
whenever they're not yet implemented.