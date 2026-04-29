#!/bin/bash
# mock-agent.sh: prints lines, optionally waits, exits with code
# Usage: mock-agent.sh [exit_code] [delay_seconds]
echo "Starting mock agent"
echo "Working on task..."
echo "Session ID: mock-session-123"
if [[ -n "$2" ]]; then
    sleep "$2"
fi
exit "${1:-0}"
