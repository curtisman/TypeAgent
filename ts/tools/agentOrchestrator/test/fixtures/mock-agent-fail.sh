#!/bin/bash
# mock-agent-fail.sh: prints lines and exits with code 1
echo "Starting failing agent"
echo "Attempting task..."
echo "Error: something went wrong"
echo "Session ID: fail-session-001"
exit 1
