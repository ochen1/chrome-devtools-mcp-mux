#!/bin/bash
# Tear down all demo-related processes and clean the scratch dir.
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
set +e

# Politely stop any recording first so the mp4 finalizes cleanly
for pid in $(pgrep -f "ffmpeg.*x11grab.*$DEMO_DISPLAY" 2>/dev/null); do
  kill -INT "$pid" 2>/dev/null
done
sleep 0.5

# Close clients / daemon / upstream / Chrome / server
pgrep -f "node $DIR/client.mjs"       | xargs -r kill 2>/dev/null
pgrep -f "cdmcp-mux.js daemon"        | xargs -r kill 2>/dev/null
pgrep -f "chrome-devtools-mcp"        | xargs -r kill 2>/dev/null
pgrep -f "$DEMO_WORK/chrome-profile"  | xargs -r kill 2>/dev/null
pgrep -f "node $DIR/server.mjs"       | xargs -r kill 2>/dev/null

# Close demo xterms (only ours — matched by title prefix)
for t in TL-status TR-log BL-clientA BR-clientB; do
  for wid in $(DISPLAY="$DEMO_DISPLAY" xdotool search --name "^$t$" 2>/dev/null); do
    DISPLAY="$DEMO_DISPLAY" xdotool windowkill "$wid" 2>/dev/null
  done
done

sleep 0.5
rm -rf "$DEMO_WORK/mux.sock" "$DEMO_WORK/state" "$DEMO_WORK/port.txt" "$DEMO_WORK/chrome-profile" 2>/dev/null
echo "demo torn down; scratch dir $DEMO_WORK retained (logs kept)"
exit 0
