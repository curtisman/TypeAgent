#!/bin/bash
# mock-agent-echo.sh: reads one line from stdin, echoes it, then exits
echo "Waiting for input..."
read -r line
echo "Got: $line"
echo "Session ID: echo-session-456"
exit 0
