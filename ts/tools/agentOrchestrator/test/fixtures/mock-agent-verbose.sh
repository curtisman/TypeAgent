#!/bin/bash
# mock-agent-verbose.sh: prints many lines to test ring buffer cap
for i in $(seq 1 200); do
    echo "Line $i of output"
done
echo "Session ID: verbose-session-789"
exit 0
