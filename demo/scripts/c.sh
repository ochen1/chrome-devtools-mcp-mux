#!/bin/bash
# Compact daemon snapshot: prints "pid / contexts / upstream" and for each
# context a list of (pageId, url) pairs. Squeezes the status JSON into
# something that fits in a small xterm.
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/env.sh"
node "$MUX_BIN" status | node -e '
let s = ""; process.stdin.on("data", c => s += c);
process.stdin.on("end", () => {
  const d = JSON.parse(s);
  console.log("=== MUX DAEMON SNAPSHOT ===");
  console.log("pid:", d.pid, "  contexts:", d.contexts.length, "  upstream:", d.upstreamReady ? "ready" : "down");
  for (const c of d.contexts) {
    console.log("");
    console.log("  " + c.id + "  (isolatedContext=" + c.isolatedContext + ")");
    for (const p of c.ownedPages) {
      const url = String(p.url).split(" ")[0];
      console.log("    pageId " + p.pageId + ": " + url);
    }
  }
});
'
