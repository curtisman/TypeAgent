#!/usr/bin/env bash
#
# Example hardened `docker run` wrappers for the Stage 1 agent image.
#
# Build the image first, from the `ts/` directory:
#   docker build -f docker/Dockerfile.agent -t typeagent/agent:stage1 .
#
# Usage:
#   ./docker/run-agent.sh test       # run filtered test:local (network off)
#   ./docker/run-agent.sh shell      # interactive bash for debugging (network off)
#   ./docker/run-agent.sh build      # rebuild workspace inside container (network on)
#   ./docker/run-agent.sh copilot    # interactive GitHub Copilot CLI in workspace
#
set -euo pipefail

IMAGE="${IMAGE:-typeagent/agent:stage1}"
MODE="${1:-test}"

# Hardening flags shared by all modes.
COMMON_FLAGS=(
    --rm
    --read-only
    --tmpfs /tmp:rw,nosuid,nodev,size=512m
    --tmpfs /home/agent/.cache:rw,nosuid,nodev,size=256m
    --tmpfs /app/.pnpm-store:rw,nosuid,nodev,size=1g
    --cap-drop=ALL
    --security-opt=no-new-privileges
    --pids-limit=512
    --memory=4g
    --cpus=4
    --user 1001:1001
)

case "${MODE}" in
    test)
        # Tests should not need the network. Block egress entirely.
        exec docker run "${COMMON_FLAGS[@]}" \
            --network=none \
            "${IMAGE}"
        ;;
    shell)
        # Interactive debugging shell. Still locked down, no network.
        exec docker run -it "${COMMON_FLAGS[@]}" \
            --network=none \
            --entrypoint /bin/bash \
            "${IMAGE}"
        ;;
    build)
        # Rebuilding inside the container needs the registry. Allow network
        # but keep all other hardening. Mount the source read-only.
        exec docker run "${COMMON_FLAGS[@]}" \
            "${IMAGE}" \
            pnpm -r build
        ;;
    copilot)
        # Run the GitHub Copilot CLI agent inside the hardened container.
        #
        # Requirements that differ from `test`:
        #   * Network is required (api.githubcopilot.com, api.github.com, ...).
        #   * The workspace must be writable so Copilot can edit files.
        #     We bind-mount the host repo at /workspace.
        #   * Auth state ($HOME/.copilot) must persist across runs.
        #     We use a named docker volume `typeagent-copilot-home`.
        #
        # The image is still --read-only with cap-drop=ALL etc; only the
        # specific mounts below are writable.
        REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
        exec docker run -it "${COMMON_FLAGS[@]}" \
            -v typeagent-copilot-home:/home/agent/.copilot \
            -v "${REPO_ROOT}":/workspace \
            -w /workspace/ts \
            --entrypoint copilot \
            "${IMAGE}"
        ;;
    *)
        echo "Unknown mode: ${MODE}" >&2
        echo "Usage: $0 {test|shell|build|copilot}" >&2
        exit 2
        ;;
esac
