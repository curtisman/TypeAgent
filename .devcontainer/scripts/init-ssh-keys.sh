#!/bin/bash
# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

#
# TypeAgent DevContainer — host-side SSH key staging
#
# Runs on the HOST (not inside the container) via `initializeCommand` in
# the SSH variant's devcontainer.json. Its job is to copy ONLY the
# *.pub files from the user's ~/.ssh into a scratch directory that the
# container will bind-mount read-only.
#
# The scratch directory is the only thing exposed to the container, so
# private keys, known_hosts, ssh config, and any other sensitive
# material in ~/.ssh stays on the host.
#
# Idempotent: safe to re-run on every container start.
#

set -u

# Resolve host home dir across Linux / macOS / WSL / Git Bash on Windows.
HOST_HOME="${HOME:-}"
if [[ -z "$HOST_HOME" && -n "${USERPROFILE:-}" ]]; then
    # Git Bash on Windows: convert C:\Users\foo to /c/Users/foo
    HOST_HOME="$(cygpath -u "$USERPROFILE" 2>/dev/null || echo "$USERPROFILE")"
fi

if [[ -z "$HOST_HOME" ]]; then
    echo "[typeagent-ssh] ERROR: cannot determine host home directory" >&2
    exit 1
fi

SRC_SSH_DIR="$HOST_HOME/.ssh"
STAGE_DIR="$HOST_HOME/.typeagent-devcontainer-ssh"

# Always create the staging dir — Docker bind-mounts require the source
# directory to exist on the host before the container starts. If we let
# this run only when keys are present, an empty ~/.ssh would cause the
# mount to fail silently and leave /tmp/host-ssh absent inside the
# container.
mkdir -p "$STAGE_DIR"
chmod 700 "$STAGE_DIR" 2>/dev/null || true

# Always start from a clean slate so removed keys don't linger.
rm -f "$STAGE_DIR"/*.pub 2>/dev/null || true

if [[ ! -d "$SRC_SSH_DIR" ]]; then
    echo "[typeagent-ssh] No $SRC_SSH_DIR found; container SSH will reject all logins."
    echo "[typeagent-ssh] Generate a key with: ssh-keygen -t ed25519"
    exit 0
fi

COUNT=0
shopt -s nullglob
for pub in "$SRC_SSH_DIR"/*.pub; do
    # Defense-in-depth: refuse anything that doesn't look like an OpenSSH
    # public key file. A misnamed private key (e.g. id_rsa.pub that's
    # actually private) would be caught here.
    first_line="$(head -n 1 "$pub" 2>/dev/null || true)"
    case "$first_line" in
        ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519@openssh.com\ *|sk-ecdsa-sha2-*@openssh.com\ *)
            cp "$pub" "$STAGE_DIR/"
            chmod 644 "$STAGE_DIR/$(basename "$pub")" 2>/dev/null || true
            COUNT=$((COUNT + 1))
            ;;
        *)
            echo "[typeagent-ssh] Skipping $pub (not a recognised public key file)"
            ;;
    esac
done
shopt -u nullglob

echo "[typeagent-ssh] Staged $COUNT public key file(s) into $STAGE_DIR"
echo "[typeagent-ssh] (Private keys, known_hosts, and ssh config are NOT shared with the container.)"
