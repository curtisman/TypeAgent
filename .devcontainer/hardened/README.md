# Hardened agent dev container

This is an **alternate** dev container configuration that uses the locked-down
`ts/docker/Dockerfile.agent` image (Stage 1 baseline).

The default `.devcontainer/devcontainer.json` at the parent level remains the
full development environment (universal base, Node + Python + .NET + Azure
CLI, Claude Code, etc.). This one is minimal and hardened.

## What you get

- Same image documented in `ts/docker/README.md` (Node 22 slim + pnpm,
  no Chrome/Electron/GTK).
- Non-root `agent` user (UID 1001).
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--pids-limit=1024`.
- Named volumes for:
  - `~/.copilot` (Copilot CLI auth persistence)
  - `/app/.pnpm-store` (install cache)
- VS Code extensions: GitHub Copilot, Copilot Chat, ESLint, Prettier.
- Workspace bind-mounted at `/workspaces/TypeAgent` (read-write, as Dev
  Containers requires for editing).

## How to use

In VS Code: **Dev Containers: Reopen in Container...** then pick the
**hardened** configuration when prompted (VS Code shows both
`devcontainer.json` files and lets you choose).

To use it from the GitHub Copilot Coding Agent (cloud sandbox) pin this as
the chosen configuration in the agent's repo settings, or copy this file
over the default `devcontainer.json`.

## What's intentionally NOT here

- No Chrome, Electron, GTK/X libs, xvfb, gnome-keyring, libsecret.
  → Cannot run `agent-shell` or `browser-typeagent` tests.
- No .NET SDK, Python tooling, Azure CLI.
- No `forwardPorts` / port-attribute UI sugar — add as needed.

For shell + browser test support, switch to the parent
`.devcontainer/devcontainer.json` or wait for the planned Stage 2 image.
