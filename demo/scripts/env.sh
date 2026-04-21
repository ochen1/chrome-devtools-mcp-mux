# Sourced by demo scripts. Sets every path/env the mux & clients need.
# Override DEMO_WORK to change the scratch dir.
: "${DEMO_WORK:=/tmp/cdmcp-mux-demo}"
: "${DEMO_CHROMIUM:=/usr/bin/chromium}"
: "${DEMO_DISPLAY:=:1}"

export DEMO_WORK DEMO_CHROMIUM DEMO_DISPLAY

mkdir -p "$DEMO_WORK/state/cdmcp-mux"
: > "$DEMO_WORK/state/cdmcp-mux/mux.log" 2>/dev/null || true

# Resolve repo root from this file (demo/scripts/env.sh → two up)
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_SCRIPT_DIR/../.." && pwd)"
MUX_BIN="$REPO_ROOT/dist/bin/cdmcp-mux.js"
export REPO_ROOT MUX_BIN

# Mux runtime configuration
export CDMCP_MUX_SOCKET="$DEMO_WORK/mux.sock"
export CDMCP_MUX_USER_DATA_DIR="$DEMO_WORK/chrome-profile"
export XDG_STATE_HOME="$DEMO_WORK/state"

# Use a chromium wrapper that passes --no-sandbox (needed in most CI/container
# environments). Skip if the user provided a custom binary.
if [ -z "${CDMCP_MUX_CHROMIUM:-}" ]; then
  export CDMCP_MUX_CHROMIUM="$_SCRIPT_DIR/chromium-wrap.sh"
fi

# Headful is the default now (matching vanilla chrome-devtools-mcp), but set
# it explicitly so the demo is robust against future default changes.
export CDMCP_MUX_HEADLESS=false

# Convenience display
export DISPLAY="$DEMO_DISPLAY"
