# chrome-devtools-mcp-mux

[![CI](https://github.com/ochen1/chrome-devtools-mcp-mux/actions/workflows/ci.yml/badge.svg)](https://github.com/ochen1/chrome-devtools-mcp-mux/actions/workflows/ci.yml)

Share one Chrome instance across many MCP clients. Each client — a separate
Claude Code session, for example — gets its own isolated set of tabs, while
they all run against the same single browser and profile.

<p align="center">
  <img src="demo/artifacts/mux-demo.gif" alt="Two MCP clients, one Chrome, each seeing only its own tab" width="100%">
</p>

<p align="center"><em>Idle waits auto-compressed to 0.5 s each. Full-resolution mp4s in <a href="demo/artifacts/">demo/artifacts/</a>: <a href="demo/artifacts/mux-demo-condensed.mp4">condensed (9 s)</a> · <a href="demo/artifacts/mux-demo.mp4">full 2:26</a>. Reproducer in <a href="demo/">demo/</a>.</em></p>

## What problem does this solve

`chrome-devtools-mcp` exposes Chrome DevTools to an MCP client. It works
perfectly for one client, but if two clients connect at once (two Claude Code
windows, a Claude Code plus a Gemini CLI, etc.) they step on each other's
tabs — `list_pages` shows everything, `select_page` races, `new_page` lands
in the wrong window.

`cdmcp-mux` sits between clients and `chrome-devtools-mcp` and gives each
connection its own isolated tab set, while keeping a single Chrome running.

## Install and configure (one-time)

```bash
git clone <this-repo> chrome-devtools-mcp-mux
cd chrome-devtools-mcp-mux
npm install
npm run build
npm link           # exposes `cdmcp-mux` on PATH
```

Then, in every MCP client's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "chrome": { "command": "cdmcp-mux" }
  }
}
```

That's it. The first client to connect auto-spawns a shared daemon; subsequent
clients attach to the same daemon.

## How to verify it's working

Start two MCP clients with the config above. In each, ask the model to:

1. Open a different URL via `new_page`.
2. Run `list_pages`.

Each client should see only its own page. On the host, run `cdmcp-mux status`
to see both contexts side-by-side in the daemon.

For a full scripted demo with a recorded video, see [`demo/`](demo/).

## Environment variables (optional)

| Variable                     | Purpose                                            |
|------------------------------|----------------------------------------------------|
| `CDMCP_MUX_CHROMIUM`         | Chromium binary (defaults to bundled Puppeteer)    |
| `CDMCP_MUX_USER_DATA_DIR`    | Override Chrome profile directory                  |
| `CDMCP_MUX_SOCKET`           | Override unix socket path for the daemon           |
| `CDMCP_MUX_HEADLESS`         | `false` makes Chrome visible (default: headless)   |
| `MCP_MUX_DEBUG`              | `1` logs every rewrite diff                        |

## Debugging

All out-of-band; the mux never exposes debug tools to MCP clients.

| Command                  | What it does                                       |
|--------------------------|----------------------------------------------------|
| `cdmcp-mux status`       | daemon pid, upstream state, contexts, owned pages  |
| `cdmcp-mux tail [-f]`    | stream the structured mux log                      |

The log lives at `~/.local/state/cdmcp-mux/mux.log`.

## How it works

```mermaid
flowchart TB
    subgraph clients["one process per MCP client"]
      direction LR
      C1["Claude Code #1"] -- "stdio (MCP)" --> S1["cdmcp-mux shim"]
      C2["Claude Code #2"] -- "stdio (MCP)" --> S2["cdmcp-mux shim"]
    end

    subgraph shared["shared — auto-spawned on first connect"]
      direction TB
      D["mux daemon<br/><i>per-connection context table</i><br/>(socket fd → ctxId → owned pageIds)"]
      U["chrome-devtools-mcp subprocess<br/><code>--experimentalPageIdRouting</code><br/><code>--userDataDir &lt;fixed&gt;</code>"]
      B["Chromium<br/><i>one instance, one profile</i>"]
      D -- "stdio (MCP)<br/>rewrite + filter" --> U
      U -- "CDP" --> B
    end

    S1 -- "unix socket" --> D
    S2 -- "unix socket" --> D

    classDef client fill:#e3f2fd,stroke:#1976d2
    classDef shim fill:#fff3e0,stroke:#f57c00
    classDef core fill:#f3e5f5,stroke:#7b1fa2
    classDef browser fill:#e8f5e9,stroke:#388e3c
    class C1,C2 client
    class S1,S2 shim
    class D,U core
    class B browser
```

Each MCP client spawns its own `cdmcp-mux` shim (that's how `.mcp.json` works —
one child per client). The shim is a pure byte pipe between the client's stdio
and a unix socket; the first shim to connect auto-spawns the shared daemon,
later shims attach to it. The daemon owns **one** `chrome-devtools-mcp`
subprocess driving **one** Chromium with **one** `--userDataDir`.

Every unix-socket connection = one fresh `BrowserContext` (isolated cookies,
localStorage, WebSockets). The daemon advertises exactly the same tool schemas
as vanilla `chrome-devtools-mcp` — `pageId` and `isolatedContext` are stripped
from what the client sees, and re-injected on every `tools/call` from the
daemon's per-connection ownership table. Atomicity uses upstream's
`--experimentalPageIdRouting`, so concurrent calls from different contexts
can't clobber each other. When a client disconnects, its tabs are closed and
its browser context destroyed.

## Development notes

This project was written end-to-end by a Claude-Code agent in a single
working session, driven by live conversational requirements. The full test
plan is tiered for functional correctness (58 tests, ~19 s, all passing),
and the multiplexer was then visually demonstrated via a VNC-automated
reproducer.

For the PRD-to-test mapping see [`DEMO.md`](DEMO.md). For the full agentic
development log — requirements discovery, architecture iteration, test
tiering, and the three takes of the video demo — see
[`demo/README.md`](demo/README.md).

## Testing

```bash
# requires a Chromium binary; the smoke/e2e tests need it
CDMCP_MUX_CHROMIUM=/usr/bin/chromium npm test
```

Expected: `8 files, 58 tests, all passing`.

## Releasing

CI runs on every push and PR against `main` using Node 22 and 24, building,
typechecking, and executing the full 58-test suite (including the real-Chromium
smoke and binary-e2e tests).

Publishing is automated via `.github/workflows/publish.yml`, which runs on a
GitHub release being published:

1. Bump `version` in `package.json`, commit, tag as `v<version>`.
2. `gh release create v<version> --generate-notes`.
3. The workflow builds, tests, and runs `npm publish` with
   [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
   (signed via GitHub OIDC, the workflow has `id-token: write`).

`NPM_TOKEN` is the only required repo secret. The package is published with
`publishConfig.provenance: true`, so the `--provenance` flag is implicit.
Once this repo is registered as a **trusted publisher** at npmjs.com, the
`NPM_TOKEN` secret can be removed entirely.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). Same as upstream `chrome-devtools-mcp`.
