#!/bin/bash
# Orchestrator: prepares a clean scratch dir, starts the HTTP server, and
# launches 4 labelled xterms in the top row of a 1280x800 VNC display. Each
# xterm lands in /tmp/cdmcp-mux-demo with the demo env pre-sourced, so the
# operator can just type ./a.sh, ./b.sh, ./t.sh, ./c.sh inside them.
#
# Expects an X display (VNC :1 in the reference setup) and `xterm` installed.
#
# Usage:
#   ./run.sh                  # launch everything, print next-steps
#   ./run.sh --record OUTFILE # also start ffmpeg screen-recording
#   ./run.sh --teardown       # kill everything and clean scratch
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--teardown" ]; then
  exec "$DIR/teardown.sh"
fi

source "$DIR/env.sh"

# --- server -----------------------------------------------------------------
if ! pgrep -f "node $DIR/server.mjs" >/dev/null 2>&1; then
  DISPLAY="$DEMO_DISPLAY" setsid node "$DIR/server.mjs" \
    > "$DEMO_WORK/server.log" 2>&1 < /dev/null &
  disown
  for i in $(seq 1 50); do
    [ -s "$DEMO_WORK/port.txt" ] && break
    sleep 0.05
  done
fi
PORT=$(cat "$DEMO_WORK/port.txt")
echo "demo HTTP server on :$PORT"

# --- recording (optional) ---------------------------------------------------
RECORD_FILE=""
if [ "${1:-}" = "--record" ]; then
  RECORD_FILE="${2:-$DEMO_WORK/demo-recording.mp4}"
  DISPLAY="$DEMO_DISPLAY" ffmpeg -y -f x11grab -framerate 15 -video_size 1280x800 \
    -i "$DEMO_DISPLAY" -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    "$RECORD_FILE" > "$DEMO_WORK/ffmpeg.log" 2>&1 &
  echo "recording → $RECORD_FILE (pid $!). SIGINT this script or run teardown to stop."
fi

# --- xterms -----------------------------------------------------------------
XTERM_ARGS=(-fa Monospace -fs 9 -bg '#1e2030')
launch() {
  local title=$1 geom=$2 fg=$3
  DISPLAY="$DEMO_DISPLAY" setsid xterm -title "$title" -geometry "$geom" \
    "${XTERM_ARGS[@]}" -fg "$fg" \
    -e bash -c "source '$DIR/env.sh'; cd '$DIR'; exec bash --norc -i" \
    </dev/null >/dev/null 2>&1 &
  disown
}

launch TL-status   50x10+5+20    '#cdd6f4'
sleep 0.2
launch TR-log      50x10+325+20  '#a6e3a1'
sleep 0.2
launch BL-clientA  50x10+645+20  '#89dceb'
sleep 0.2
launch BR-clientB  50x10+965+20  '#f9e2af'
sleep 1

cat <<EOF

Four xterms launched on $DEMO_DISPLAY. Next steps (type in each):

  TR-log      ->   ./t.sh
  BL-clientA  ->   ./a.sh            # Client A opens /alpha in its own context
  BR-clientB  ->   ./b.sh            # Client B opens /bravo in its own context
  TL-status   ->   ./c.sh            # compact snapshot of the mux daemon

After the Chrome windows open you can run:

  $DIR/arrange.sh                    # move Chromes side-by-side below the xterms

To tear down:

  $DIR/teardown.sh
EOF
