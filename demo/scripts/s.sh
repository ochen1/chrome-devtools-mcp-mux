#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
exec node "$MUX_BIN" status
