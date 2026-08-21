#!/usr/bin/env bash
# Launch DSH dev process with all env vars loaded.
cd /home/etsme/cy/agent/dsh-edge-agent || exit 1
source .env.sh > /tmp/envsh.out 2>&1
exec /home/etsme/.npm-global/bin/dsh --profile dsh-edge-agent
