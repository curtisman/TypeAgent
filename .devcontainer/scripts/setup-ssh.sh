#!/bin/bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

#
# TypeAgent DevContainer SSH Setup Script
#
# Used by the SSH variant (.devcontainer/ssh/devcontainer.json).
#
# Responsibilities:
#   1. Import the host user's public SSH keys into authorized_keys so that
#      VS Code Remote-SSH and external agent tools can connect key-based.
#   2. Ensure sshd (installed by the sshd devcontainer feature) is running
#      and listening on the expected port (2222).
#   3. Print connection instructions.
#
# Pass `--start-only` to skip key import (used by postStartCommand on every
# container start; keys only need to be imported once at create time).
#

set -u

START_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --start-only) START_ONLY=1 ;;
    esac
done

USER_NAME="${_REMOTE_USER:-codespace}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
SSH_DIR="$USER_HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
HOST_SSH_DIR="/tmp/host-ssh"
SSH_PORT=2222
HARDENING_CONF="/etc/ssh/sshd_config.d/00-typeagent-hardening.conf"

echo ""
echo "── SSH setup ────────────────────────────────────────────────"

if [[ "$START_ONLY" -eq 0 ]]; then
    if [[ ! -d "$HOST_SSH_DIR" ]]; then
        echo ""
        echo "  ╔══════════════════════════════════════════════════════════════╗"
        echo "  ║  SSH SETUP FAILED — bind mount missing                       ║"
        echo "  ║                                                              ║"
        echo "  ║  /tmp/host-ssh is not present in the container.             ║"
        echo "  ║  This usually means ~/.typeagent-devcontainer-ssh/ did not  ║"
        echo "  ║  exist on the host when Docker created the container.       ║"
        echo "  ║                                                              ║"
        echo "  ║  Fix:                                                        ║"
        echo "  ║  1. On your HOST, run:                                       ║"
        echo "  ║       cat .devcontainer/scripts/init-ssh-keys.sh | tr -d '\\r' | bash"
        echo "  ║  2. Rebuild the container:                                   ║"
        echo "  ║       Dev Containers: Rebuild Container                      ║"
        echo "  ║                                                              ║"
        echo "  ║  Or copy a key in manually right now (host terminal):        ║"
        echo "  ║    cat ~/.ssh/id_ed25519.pub | docker exec -u $USER_NAME -i \$(hostname) \\"
        echo "  ║      bash -c 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'"
        echo "  ╚══════════════════════════════════════════════════════════════╝"
        echo ""
        echo "  sshd will NOT be started."
        return 0
    fi

    # ── 1. Import host public keys ──────────────────────────────
    sudo mkdir -p "$SSH_DIR"
    sudo chown "$USER_NAME":"$USER_NAME" "$SSH_DIR"
    sudo chmod 700 "$SSH_DIR"

    IMPORTED=0
    if [[ -d "$HOST_SSH_DIR" ]]; then
        TMP_KEYS="$(mktemp)"
        # shellcheck disable=SC2044
        for pub in $(find "$HOST_SSH_DIR" -maxdepth 1 -type f -name '*.pub' 2>/dev/null); do
            # Sanity-check each line looks like an OpenSSH public key
            while IFS= read -r line; do
                case "$line" in
                    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519@openssh.com\ *|sk-ecdsa-sha2-*@openssh.com\ *)
                        echo "$line" >> "$TMP_KEYS"
                        IMPORTED=$((IMPORTED + 1))
                        ;;
                esac
            done < "$pub"
        done

        if [[ "$IMPORTED" -gt 0 ]]; then
            if [[ -f "$AUTH_KEYS" ]]; then
                sudo cat "$AUTH_KEYS" >> "$TMP_KEYS"
            fi
            sort -u "$TMP_KEYS" | sudo tee "$AUTH_KEYS" >/dev/null
            sudo chown "$USER_NAME":"$USER_NAME" "$AUTH_KEYS"
            sudo chmod 600 "$AUTH_KEYS"
            echo "  Imported $IMPORTED public key(s) from host into authorized_keys"
        fi
        rm -f "$TMP_KEYS"
    fi

    # ── 2. Refuse to start sshd with no authorized keys ─────────
    if [[ ! -s "$AUTH_KEYS" ]]; then
        echo ""
        echo "  ╔══════════════════════════════════════════════════════════════╗"
        echo "  ║  SSH SETUP FAILED — no authorized keys                       ║"
        echo "  ║                                                              ║"
        echo "  ║  No *.pub files were found in /tmp/host-ssh.                ║"
        echo "  ║  Password auth is disabled, so sshd would reject every      ║"
        echo "  ║  connection. sshd will NOT be started.                      ║"
        echo "  ║                                                              ║"
        echo "  ║  Fix:                                                        ║"
        echo "  ║  1. Ensure ~/.ssh/id_ed25519.pub (or similar) exists on     ║"
        echo "  ║     your host. Generate one with:                            ║"
        echo "  ║       ssh-keygen -t ed25519                                  ║"
        echo "  ║  2. On your HOST terminal, re-run the staging script:        ║"
        echo "  ║       cat .devcontainer/scripts/init-ssh-keys.sh | tr -d '\\r' | bash"
        echo "  ║  3. Rebuild the container.                                   ║"
        echo "  ║                                                              ║"
        echo "  ║  Or copy a key in manually right now (host terminal):        ║"
        echo "  ║    cat ~/.ssh/id_ed25519.pub | docker exec -u $USER_NAME -i <container> \\"
        echo "  ║      bash -c 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'"
        echo "  ║  Then re-run: cat .devcontainer/scripts/setup-ssh.sh | tr -d '\\r' | bash"
        echo "  ╚══════════════════════════════════════════════════════════════╝"
        echo ""
        return 0
    fi

    # ── 3. Lock down sshd via a drop-in config ──────────────────
    # OpenSSH reads /etc/ssh/sshd_config.d/*.conf in lexical order; the
    # first occurrence of a directive wins, so a 00- prefix overrides the
    # feature's defaults.
    sudo tee "$HARDENING_CONF" >/dev/null <<EOF
# TypeAgent devcontainer SSH hardening — generated by setup-ssh.sh
# Do not edit by hand; changes are overwritten on container start.

# Listen only on the loopback interface inside the container. Docker /
# VS Code port forwarding tunnels localhost:2222 on the host to this
# socket, so there is no need to accept traffic on the container's
# external interface.
ListenAddress 127.0.0.1
Port $SSH_PORT

# Authentication — keys only, no passwords, no root.
PermitRootLogin no
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
UsePAM yes
AllowUsers $USER_NAME

# Brute-force / DoS limits.
MaxAuthTries 3
MaxSessions 10
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2

# Disable rarely-needed features that expand attack surface.
X11Forwarding no
PermitUserEnvironment no
GatewayPorts no
PermitTunnel no

# Keep agent + TCP forwarding enabled — VS Code Remote-SSH and many AI
# agent tools rely on them for port forwarding and git auth.
AllowAgentForwarding yes
AllowTcpForwarding yes

# Modern crypto only (OpenSSH 8+ defaults, made explicit).
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,sntrup761x25519-sha512@openssh.com,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com
HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ecdsa-sha2-nistp256

# Logging.
LogLevel VERBOSE
PrintMotd no
EOF
    sudo chmod 644 "$HARDENING_CONF"

    # Validate the config before letting sshd (re)start with it.
    if ! sudo /usr/sbin/sshd -t 2>/tmp/sshd-config-check.log; then
        echo "  ERROR: sshd config validation failed:"
        sed 's/^/    /' /tmp/sshd-config-check.log
        echo "  Removing hardening drop-in to avoid breaking SSH."
        sudo rm -f "$HARDENING_CONF"
    else
        echo "  Applied hardened sshd config: $HARDENING_CONF"
    fi
fi

# ── 4. Ensure sshd is running ───────────────────────────────────
# Restart so any config changes from above take effect.
if pgrep -x sshd >/dev/null 2>&1; then
    sudo pkill -HUP -x sshd 2>/dev/null || true
fi
if ! pgrep -x sshd >/dev/null 2>&1; then
    if [[ -x /usr/local/share/ssh-init.sh ]]; then
        sudo /usr/local/share/ssh-init.sh >/dev/null 2>&1 || true
    else
        sudo service ssh start >/dev/null 2>&1 || sudo /usr/sbin/sshd >/dev/null 2>&1 || true
    fi
fi

if pgrep -x sshd >/dev/null 2>&1; then
    echo "  sshd running on 127.0.0.1:$SSH_PORT (key auth only, user '$USER_NAME')"
else
    echo "  WARNING: sshd does not appear to be running"
fi

echo ""
echo "Connect from your host (port forwarded to localhost):"
echo "    ssh -p $SSH_PORT $USER_NAME@localhost"
echo ""
echo "VS Code Remote-SSH (~/.ssh/config):"
echo "    Host typeagent-devcontainer"
echo "        HostName localhost"
echo "        Port $SSH_PORT"
echo "        User $USER_NAME"
echo ""
echo "Then: 'Remote-SSH: Connect to Host…' → typeagent-devcontainer"
echo "─────────────────────────────────────────────────────────────"
echo ""
