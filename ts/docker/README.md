# Minimal hardened agent container — Stage 1

A small, locked-down container image for the TypeAgent TS workspace. This
**Stage 1** baseline image is intended for:

- Building the entire `ts/` workspace.
- Running `test:local` for non-shell, non-browser packages.

A future **Stage 2** image will extend this baseline with the runtime bits
needed for the Electron `agent-shell` and the Puppeteer `browser-typeagent`
agent (Chrome, GTK/X libs, `xvfb`, libsecret/gnome-keyring, electron binary).

## What's in / out

| Capability                                                 | Stage 1 (this image) | Stage 2 (future) |
| ---------------------------------------------------------- | -------------------- | ---------------- |
| `pnpm install --frozen-lockfile`                           | ✅                   | ✅               |
| `pnpm -r build` (all packages, including shell/browser TS) | ✅                   | ✅               |
| `test:local` for core/agent/memory packages                | ✅                   | ✅               |
| `test:local` for `agent-shell` (Electron)                  | ❌ filtered          | ✅               |
| `test:local` for `browser-typeagent` (Puppeteer)           | ❌ filtered          | ✅               |
| Chrome / Electron binaries downloaded                      | ❌ skipped via env   | ✅               |
| GTK/X libs, `xvfb`, `gnome-keyring`                        | ❌                   | ✅               |
| .NET projects under `dotnet/`                              | ❌                   | ❌               |

The TS sources for `agent-shell`, `browser-typeagent`, `desktop-automation`,
and `vscode-shell` _do_ compile in Stage 1. We just don't pull their heavy
runtime binaries and we filter them out at test time.

## Build

From the `ts/` directory:

```bash
docker build -f docker/Dockerfile.agent -t typeagent/agent:stage1 .
```

The build sets these env vars to keep the image small:

- `PUPPETEER_SKIP_DOWNLOAD=1`, `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1`
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1`
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`

These prevent ~270MB+ of browser/Electron binaries from being pulled during
`pnpm install`.

Native build dependencies installed in the builder stage:
`python3`, `make`, `g++`, `pkg-config`, `libsecret-1-dev`, `git`, `curl`,
`ca-certificates`. Nothing GUI/X-related.

## Run

`docker/run-agent.sh` provides hardened `docker run` wrappers:

```bash
./docker/run-agent.sh test     # default: run filtered test:local, --network=none
./docker/run-agent.sh shell    # interactive bash (locked down, no network)
./docker/run-agent.sh build    # rebuild inside container (network allowed)
./docker/run-agent.sh copilot  # interactive GitHub Copilot CLI in mounted workspace
```

### Hardening flags applied

| Flag                                           | Purpose                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `--read-only`                                  | Root filesystem is immutable; defeats persistence and most tampering. |
| `--tmpfs /tmp`, `~/.cache`, `/app/.pnpm-store` | Writable scratch with `nosuid,nodev`, size-capped.                    |
| `--cap-drop=ALL`                               | Drop all Linux capabilities. Node + pnpm don't need any.              |
| `--security-opt=no-new-privileges`             | Block setuid escalation.                                              |
| `--pids-limit=512`                             | Defeat fork bombs.                                                    |
| `--memory=4g`, `--cpus=4`                      | Resource ceilings.                                                    |
| `--user 1001:1001`                             | Non-root `agent` user (also baked into the image).                    |
| `--network=none` (test/shell modes)            | No egress while running tests.                                        |

The container also runs as the non-root `agent` user (UID 1001) by default
via the `USER` directive in the Dockerfile, independent of the `--user` flag.

### Test command

The default `CMD` is:

```
pnpm -r --no-bail --no-sort --stream --workspace-concurrency=1 \
    --filter '!agent-shell' \
    --filter '!browser-typeagent' \
    --filter '!desktop-automation' \
    --filter '!vscode-shell' \
    run test:local
```

Override at `docker run` time to scope down to a single package, e.g.:

```bash
docker run --rm --read-only ... typeagent/agent:stage1 \
    pnpm --filter @typeagent/cache run test:local
```

## Threat coverage at a glance

| Threat                                  | Mitigation in Stage 1                                               |
| --------------------------------------- | ------------------------------------------------------------------- |
| Container privilege escalation (T3)     | non-root user, `--cap-drop=ALL`, `--security-opt=no-new-privileges` |
| Filesystem tampering / persistence (T4) | `--read-only` rootfs + size-capped tmpfs                            |
| Secret/credential theft (T5)            | no secrets baked in; mount tokens read-only at run time             |
| Network exfiltration (T6)               | `--network=none` for tests; build-mode allows registry only         |
| Resource exhaustion / DoS (T8)          | `--pids-limit`, `--memory`, `--cpus`                                |
| Image attack surface / CVEs (T10)       | slim Debian base, no Chrome/GTK stack, no shell agent runtime       |

Threats _not_ addressed at this tier (host kernel escape T1, container runtime
escape T2): those require an isolation runtime such as **gVisor (`runsc`)**,
**Kata Containers**, or a microVM (Firecracker). The image works under any of
these as a drop-in; wiring them up is left to the host configuration and is
out of scope for Stage 1.

## Extending to Stage 2 (planned, not implemented yet)

Stage 2 will be a separate `Dockerfile.agent-shell` that:

- Inherits or shares the Stage 1 builder.
- Installs Chrome runtime libs, `xvfb`, `libsecret-1-0`, `gnome-keyring`.
- Re-runs `pnpm install` (or a targeted rebuild) **without** the
  `*_SKIP_DOWNLOAD` env vars so Electron/Chrome binaries are present.
- Wraps the test command in `xvfb-run`.
- Relaxes specific hardening flags only where Chrome's sandbox requires it.

## GitHub Copilot integration

The runtime image includes the **GitHub Copilot CLI** (`@github/copilot`) so
the same hardened container can host an interactive Copilot session.

### Option A — `run-agent.sh copilot`

```bash
./docker/run-agent.sh copilot
```

What it does on top of the standard hardening:

- Bind-mounts the **repo root** at `/workspace` (read-write) so Copilot can
  edit source. The image's baked-in `/app` copy is untouched.
- Mounts a **named docker volume** `typeagent-copilot-home` at
  `/home/agent/.copilot` so the device-flow login persists across runs.
- Allows network egress (Copilot needs `api.githubcopilot.com`,
  `api.github.com`, etc.). All other hardening flags remain in place.

First run will print a device-flow code; complete the login in a browser.
Subsequent runs reuse the volume.

If you want a stricter network posture, run behind an HTTP egress proxy with
an allowlist for the Copilot/GitHub endpoints and pass `HTTPS_PROXY` /
`HTTP_PROXY` via `--env`.

### Option B — VS Code Dev Containers

An alternate dev container config lives at
`.devcontainer/hardened/devcontainer.json`. It reuses the same
`Dockerfile.agent` and applies the same hardening flags. From VS Code:
**Dev Containers: Reopen in Container...** and pick the **hardened** option
(the default `.devcontainer/devcontainer.json` is the full dev environment
and remains unchanged).

What you get:

- Same hardened image, with `remoteUser=agent` (non-root).
- Cap-drop, no-new-privileges, pids-limit applied via `runArgs`.
- Named volumes for `~/.copilot` (auth) and `/app/.pnpm-store` (install cache).
- Copilot + Copilot Chat VS Code extensions auto-installed inside the
  container; auth flows through the host VS Code session, so the container
  itself doesn't need pre-staged tokens.

### Option C — GitHub Copilot Coding Agent (cloud)

The cloud-hosted Copilot Coding Agent (assign-to-issue / open-PR feature)
runs in **GitHub's** sandbox, not on your machine. To make it use this
hardened container instead of the full dev environment, point it at
`.devcontainer/hardened/devcontainer.json` (or copy that file over the
default `.devcontainer/devcontainer.json` for that branch).

### Threat notes for the Copilot mode

| Concern | Stance |
|---|---|
| Copilot can edit files | Bind mount is intentional and scoped to the repo. |
| Token/auth theft | Stored in a docker-managed named volume, not in the image. |
| Network exfiltration | Egress is on; restrict via host firewall or HTTP proxy if needed. |
| Privilege escalation | Same `--cap-drop=ALL` + non-root + no-new-privs as test mode. |
| Shell access | Copilot can spawn processes (it's an agent); they run as UID 1001 with no caps and resource limits. |
