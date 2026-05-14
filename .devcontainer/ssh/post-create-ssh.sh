#!/bin/bash
# SSH variant post-create script: SSH key install + sshd hardening.
# Runs after the shared post-create.sh during container creation.
#
# The host public key is bind-mounted at /tmp/host_authorized_key.pub.
# The mount may land as root-owned, so we use sudo to read it.

echo ""
echo "--- SSH variant setup ---"

KEY_FILE=/tmp/host_authorized_key.pub

if sudo test -f "$KEY_FILE"; then
    mkdir -p /home/codespace/.ssh
    chmod 700 /home/codespace/.ssh
    # Use sudo to read the file in case it is root-owned from the bind mount
    sudo cat "$KEY_FILE" > /home/codespace/.ssh/authorized_keys
    chmod 600 /home/codespace/.ssh/authorized_keys
    chown -R codespace:codespace /home/codespace/.ssh
    echo "  [OK] Installed host public key into authorized_keys"
else
    echo "  [!] $KEY_FILE not found or not readable."
    echo "      Check that ~/.ssh/typeagent_devcontainer.pub exists on the host"
    echo "      and the bind mount in .devcontainer/ssh/devcontainer.json is correct."
fi

# Harden sshd: keys only, no root login, no password auth
if [[ -f /etc/ssh/sshd_config ]]; then
    sudo sed -i \
        -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
        -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
        -e 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
        -e 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' \
        /etc/ssh/sshd_config
    sudo service ssh restart 2>/dev/null || sudo systemctl restart ssh 2>/dev/null || true
    echo "  [OK] sshd hardened (password + root login disabled)"
fi

echo "--- SSH variant setup complete ---"
echo ""
