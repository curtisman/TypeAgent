# TypeAgent DevContainer — SSH Variant

This variant of the TypeAgent devcontainer runs an OpenSSH server inside the
container so external tools can attach to it over SSH, in addition to (or
instead of) the VS Code Dev Containers extension.

- Config: [`devcontainer.json`](./devcontainer.json)
- Setup script: [`../scripts/setup-ssh.sh`](../scripts/setup-ssh.sh)
- Parent docs: [`../README.md`](../README.md)

## When to use this variant

Pick this variant when you want to:

- Open a **second VS Code window** against the same container via
  **Remote-SSH** (independent of the Dev Containers extension — useful
  when you want to keep the original window attached as a Dev Container
  while another window connects via plain SSH).
- Attach **AI agent tools / "agent windows"** that operate over SSH:
  Copilot CLI, Claude Code, Cursor, JetBrains Gateway, `tmux` / `mosh`,
  `ssh -t`, etc. Each agent gets its own login session inside the same
  running container.
- Use plain **`ssh` / `scp` / `rsync`** from the host for ad-hoc shell
  access or file transfer.

If none of the above apply, use the standard
[`../devcontainer.json`](../devcontainer.json) instead — it's simpler and
has a smaller attack surface.

## Quick start

1. Open the repo in VS Code.
2. Command Palette → **Dev Containers: Reopen in Container**.
3. When prompted, pick **TypeAgent Development (SSH)**.
   (VS Code lists every `devcontainer.json` under `.devcontainer/*/`.)
4. Wait for the container to build. The first start runs
   `setup-ssh.sh`, which imports your host SSH public keys and writes a
   hardened sshd config.
5. From the host:

   ```bash
   ssh -p 2222 codespace@localhost
   ```

### VS Code Remote-SSH

Add to `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`):

```sshconfig
Host typeagent-devcontainer
    HostName localhost
    Port 2222
    User codespace
```

Then run **Remote-SSH: Connect to Host…** → `typeagent-devcontainer`.
Open the workspace folder at `/workspaces/TypeAgent` (or the worktree
path used by your container).

### Other agent tools

Anything that speaks SSH works the same way. A few examples:

```bash
# Copilot CLI inside the container
ssh -p 2222 codespace@localhost -t "cd /workspaces/TypeAgent && copilot"

# Claude Code remote
ssh -p 2222 codespace@localhost -t "cd /workspaces/TypeAgent && claude"

# Persistent tmux session you can reattach to from any agent window
ssh -p 2222 codespace@localhost -t "tmux new -As typeagent"
```

## Prerequisites

Before launching, you need at least one SSH **public** key on the host:

```bash
ssh-keygen -t ed25519 -C "$(whoami)@$(hostname)"   # if you don't already have one
```

The variant **never** bind-mounts your host `~/.ssh` directly. Instead, a
host-side script ([`../scripts/init-ssh-keys.sh`](../scripts/init-ssh-keys.sh))
runs automatically via `initializeCommand` and copies **only** the
`*.pub` files into a scratch directory at `~/.typeagent-devcontainer-ssh/`.
That scratch directory is the only thing the container ever sees.

This means your **private keys, `known_hosts`, `config`, and any other
files in `~/.ssh` stay on the host** — nothing inside the container
(including AI agents and any code they execute) can read them.

### Windows note

`initializeCommand` invokes `bash`, which on Windows means **Git Bash**
or **WSL** must be on the host PATH. Both are extremely common for
devcontainer users. If you have neither, populate the staging directory
yourself once:

```powershell
mkdir $env:USERPROFILE\.typeagent-devcontainer-ssh
copy $env:USERPROFILE\.ssh\*.pub $env:USERPROFILE\.typeagent-devcontainer-ssh\
```

## What `setup-ssh.sh` does

On container **create** (and again on each **start**, in `--start-only`
mode for the parts that should re-run):

1. **Imports public keys.** Every `*.pub` file under `/tmp/host-ssh`
   (the staging directory bind-mounted from
   `~/.typeagent-devcontainer-ssh/` on the host) is parsed; only lines
   beginning with a recognised OpenSSH key type (`ssh-ed25519`,
   `ssh-rsa`, `ecdsa-sha2-*`, `sk-ssh-ed25519@openssh.com`,
   `sk-ecdsa-sha2-*@openssh.com`) are appended to
   `/home/codespace/.ssh/authorized_keys`. Existing entries are
   preserved and deduplicated.
2. **Writes a hardened sshd drop-in** at
   `/etc/ssh/sshd_config.d/00-typeagent-hardening.conf` (the `00-`
   prefix ensures it overrides the upstream feature defaults, since
   OpenSSH honours the first occurrence of a directive).
3. **Validates the config** with `sshd -t` before reloading. If
   validation fails, the drop-in is removed so SSH stays usable.
4. **Reloads / starts sshd** and prints the connection instructions.

## Security posture

The drop-in pins sshd to a strict configuration:

| Setting                                           | Value                                                 |
| ------------------------------------------------- | ----------------------------------------------------- |
| `ListenAddress`                                   | `127.0.0.1` (loopback inside container)               |
| `Port`                                            | `2222`                                                |
| `PasswordAuthentication`                          | `no`                                                  |
| `KbdInteractiveAuthentication`                    | `no`                                                  |
| `ChallengeResponseAuthentication`                 | `no`                                                  |
| `PermitEmptyPasswords`                            | `no`                                                  |
| `PermitRootLogin`                                 | `no`                                                  |
| `AuthenticationMethods`                           | `publickey`                                           |
| `AllowUsers`                                      | `codespace` only                                      |
| `MaxAuthTries`                                    | `3`                                                   |
| `LoginGraceTime`                                  | `30s`                                                 |
| `ClientAliveInterval` / `ClientAliveCountMax`     | `300` / `2`                                           |
| `X11Forwarding` / `GatewayPorts` / `PermitTunnel` | `no`                                                  |
| `PermitUserEnvironment`                           | `no`                                                  |
| `AllowAgentForwarding` / `AllowTcpForwarding`     | `yes` (Remote-SSH and most agent tools rely on these) |
| `KexAlgorithms`                                   | curve25519, sntrup761x25519, DH group16/18 (SHA-512)  |
| `Ciphers`                                         | ChaCha20-Poly1305, AES-GCM, AES-CTR                   |
| `MACs`                                            | ETM HMAC-SHA2-512/256, UMAC-128-ETM                   |
| `HostKeyAlgorithms`                               | Ed25519, RSA-SHA2-512/256, ECDSA NIST-P256            |
| `LogLevel`                                        | `VERBOSE`                                             |

### Why these choices

- **Key-only auth.** The upstream `sshd` devcontainer feature ships a
  default password for the `codespace` user. With
  `PasswordAuthentication no` and `AuthenticationMethods publickey` that
  password is unreachable — even if the forwarded port were ever exposed
  beyond loopback, no password attempt would succeed.
- **Loopback-only listen.** sshd binds to `127.0.0.1` _inside_ the
  container, so the only way in is via Docker / VS Code port forwarding
  to host loopback. The port is never reachable from the container's
  external network interface or from sibling containers on the same
  Docker network.
- **Fail-closed.** If no `*.pub` keys are imported, sshd still starts
  but every connection is rejected. There is no automatic fallback to
  password auth.
- **Reduced surface.** Tunnels, X11, gateway ports, and user-supplied
  environment overrides are disabled. Agent + TCP forwarding stay
  enabled because Remote-SSH and many agent tools depend on them.
- **Modern crypto only.** Legacy KEX / ciphers / MACs / host-key
  algorithms (DSA, RSA-SHA1, CBC, plain HMAC, etc.) are explicitly
  excluded.
- **Verbose logging** for auditability — visible in the container logs
  via `docker logs <container>` or VS Code's "Dev Containers" output.

### Threat model

This config is hardened for the **local Docker Desktop + host loopback
forwarding** scenario, which is the supported use case. Specifically:

- ✅ Safe: a malicious process on the host that scans `localhost` cannot
  log in without one of your private keys.
- ✅ Safe: another container on the same Docker network cannot reach
  sshd (it listens on `127.0.0.1` _inside_ the container).
- ✅ Safe: code running inside the container — including AI agents,
  npm/pnpm postinstall scripts, and any compromised dependency —
  **cannot read your host private keys, `known_hosts`, or `ssh config`**.
  Only the staged `*.pub` files are visible at `/tmp/host-ssh`.
- ⚠️ If you change `ListenAddress` or publish port `2222` on a public
  interface, you are responsible for any additional network-level
  controls (firewall, VPN, fail2ban, etc.). The defaults assume the
  port is reachable only via host loopback.
- ⚠️ Anyone with `docker exec` access on the host can already become
  `root` in the container; SSH hardening does not (and cannot) defend
  against that.
- ⚠️ The host staging directory `~/.typeagent-devcontainer-ssh/`
  contains only public keys, but if you want to remove it entirely
  (e.g. when you're done with the variant), it's safe to `rm -rf`.

## Recovering / customising

### "Permission denied (publickey)"

1. Confirm a public key was imported:
   ```bash
   docker exec -u codespace -it <container> cat /home/codespace/.ssh/authorized_keys
   ```
2. If empty, copy a key in manually:
   ```bash
   cat ~/.ssh/id_ed25519.pub | \
       docker exec -u codespace -i <container> \
           bash -c 'cat >> /home/codespace/.ssh/authorized_keys && chmod 600 /home/codespace/.ssh/authorized_keys'
   ```
3. Or rebuild after fixing the host `~/.ssh` mount:
   **Dev Containers: Rebuild Container**.

### Inspecting / changing the hardened config

The drop-in is regenerated by `setup-ssh.sh` on every container start,
so editing it in-place is not persistent. To change the policy, modify
the heredoc in
[`../scripts/setup-ssh.sh`](../scripts/setup-ssh.sh) and rebuild.

To inspect the live, fully-merged config:

```bash
sudo sshd -T | sort
```

### Disabling the variant temporarily

Just reopen the folder with the standard devcontainer
(`../devcontainer.json`) — the SSH variant has no persistent host-side
state beyond the imported public keys (which live inside the container's
home directory volume).

## Forwarded ports (this variant)

| Port | Service            |
| ---- | ------------------ |
| 2222 | SSH server         |
| 3000 | API Server (HTTP)  |
| 3443 | API Server (HTTPS) |
| 8081 | Browser Agent (WS) |
| 8082 | Code Agent (WS)    |
| 8999 | Agent Server (WS)  |

## See also

- [`../README.md`](../README.md) — overview of all devcontainer variants
- [`devcontainers/features/sshd`](https://github.com/devcontainers/features/tree/main/src/sshd) — upstream feature this variant builds on
- [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh) — official docs
