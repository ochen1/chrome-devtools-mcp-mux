#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
LOG="$XDG_STATE_HOME/cdmcp-mux/mux.log"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
exec tail -n 0 -F "$LOG"
