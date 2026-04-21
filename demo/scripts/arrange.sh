#!/bin/bash
# Place the two Chromium windows (ALPHA, BRAVO) side by side below the xterms,
# and minimise the default about:blank window chrome-devtools-mcp opens on
# startup. Requires xdotool.
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
set +e

for wid in $(DISPLAY="$DEMO_DISPLAY" xdotool search --name "^ALPHA" 2>/dev/null); do
  DISPLAY="$DEMO_DISPLAY" xdotool windowsize "$wid" 620 480
  DISPLAY="$DEMO_DISPLAY" xdotool windowmove "$wid" 10 220
  DISPLAY="$DEMO_DISPLAY" xdotool windowraise "$wid"
done
for wid in $(DISPLAY="$DEMO_DISPLAY" xdotool search --name "^BRAVO" 2>/dev/null); do
  DISPLAY="$DEMO_DISPLAY" xdotool windowsize "$wid" 620 480
  DISPLAY="$DEMO_DISPLAY" xdotool windowmove "$wid" 650 220
  DISPLAY="$DEMO_DISPLAY" xdotool windowraise "$wid"
done
for wid in $(DISPLAY="$DEMO_DISPLAY" xdotool search --name "about:blank" 2>/dev/null); do
  DISPLAY="$DEMO_DISPLAY" xdotool windowminimize "$wid"
done
# Keep xterms on top of any stray Chrome window
for t in TL-status TR-log BL-clientA BR-clientB; do
  for wid in $(DISPLAY="$DEMO_DISPLAY" xdotool search --name "^$t$" 2>/dev/null); do
    DISPLAY="$DEMO_DISPLAY" xdotool windowraise "$wid"
  done
done
exit 0
