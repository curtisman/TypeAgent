# SSH variant devcontainer — VS Code Agents window support

> ⚠️ **Local development only** — requires a local Windows host with Docker Desktop.
> Do not use with GitHub Codespaces (the SSH public key bind mount won't work there).
> For Codespaces, use the default `.devcontainer/devcontainer.json`.

This devcontainer variant adds an OpenSSH server to the standard TypeAgent
development container so the VS Code Agents window can connect via
**Remote → SSH** (loopback, port 2222, key-only auth).

Use it the same way as the `vnc` variant — pick it when VS Code asks which
configuration to use.

## One-time host setup

### 1. Generate an SSH key pair (if you haven't already)

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\typeagent_devcontainer -C "typeagent-devcontainer"
```

Set a passphrase when prompted.

### 2. Drop your public key into the ssh variant folder

```powershell
Copy-Item $env:USERPROFILE\.ssh\typeagent_devcontainer.pub .devcontainer\ssh\authorized_keys
```

This file is gitignored — it won't be committed.

### 3. Add an SSH config entry
In `%USERPROFILE%\.ssh\config`:
```
Host typeagent-devcontainer
    HostName 127.0.0.1
    Port 2222
    User codespace
    IdentityFile ~/.ssh/typeagent_devcontainer
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
```

## Build the container

In VS Code: **Command Palette → Dev Containers: Reopen in Container**
-> select **"TypeAgent Development (SSH)"** (this folder's config).

## Verify SSH works

```powershell
ssh typeagent-devcontainer
# Should connect as codespace with no password prompt (passphrase is fine)
```

## Connect from the Agents window

**New Session -> Remote -> SSH -> `typeagent-devcontainer` -> `/workspaces/TypeAgent`**

## What's in this folder

| File                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `devcontainer.json`  | Full devcontainer config -- shared features + sshd + port 2222 |
| `post-create-ssh.sh` | Installs your public key + hardens sshd at container creation  |
| `README.md`          | This file                                                      |

## Security notes

- Password authentication is **disabled** -- key-only.
- Root login is **disabled**.
- Port 2222 forwards to `127.0.0.1` only (not exposed to LAN).
- The public key is bind-mounted read-only from `%USERPROFILE%\.ssh\typeagent_devcontainer.pub`.
  The private key never enters the container.
