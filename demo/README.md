# Demo — two clients, one Chrome

This folder contains everything needed to reproduce the end-to-end demonstration
of the multiplexer: two fully independent MCP clients attach to one
`cdmcp-mux` daemon, each sees only its own tab via `list_pages`, and both tabs
are visible side by side in one Chromium instance with one `user-data-dir`.

Three recordings are shipped in [`artifacts/`](artifacts/):

- [`mux-demo.gif`](artifacts/mux-demo.gif) — 720p, 12 fps, 465 KB. The inline
  loop above and on the top-level README. Auto-plays in any markdown renderer.
- [`mux-demo-condensed.mp4`](artifacts/mux-demo-condensed.mp4) — 1280×800, 9 s,
  270 KB. Same pacing as the gif but full resolution. Idle waits squeezed to
  0.5 s each.
- [`mux-demo.mp4`](artifacts/mux-demo.mp4) — 1280×800, 2:26, 2.5 MB. The raw
  capture at 1:1 speed. Use this if you want to read every log line as it
  streams.

A still of the final composed frame is at
[`artifacts/final-frame.png`](artifacts/final-frame.png).

<p align="center">
  <img src="artifacts/mux-demo.gif" alt="Final composed state: four xterms and two Chrome windows showing per-client isolation" width="100%">
</p>

### How the condensed version was made

The condenser lives in [`analysis/`](../demo/analysis/). It's a three-step
pipeline driven by ffmpeg + Python:

1. `analyze.py` — extracts per-frame `lavfi.scene_score` via
   `ffmpeg -vf "select='gte(scene,0)',metadata=print"`, buckets them into a
   log-scale histogram, and reports the bimodal split (in this video: ~80% of
   frames effectively zero, compression noise below 1e-4, real motion above).
2. `plan.py` — picks a still-vs-active threshold (1e-4 here), glues runs
   separated by ≤3-frame flickers (cursor blinks etc.), and emits
   [`plan.json`](analysis/plan.json): a list of `keep`/`squeeze` segments.
   Each `squeeze` idle run ≥0.5 s gets compressed to exactly 0.5 s.
3. `build_filter.py` — writes [`filter.txt`](analysis/filter.txt), an ffmpeg
   `-filter_complex_script` that splits the input into segments, `setpts`'s
   each by its speed factor, and concats.

To re-run it against your own capture:

```bash
ffmpeg -i in.mp4 -vf "select='gte(scene,0)',metadata=print:file=/tmp/scores.txt" -an -f null -
# adjust the IDLE_THRESH in plan.py if your video's histogram is shaped differently
python3 demo/analysis/plan.py
python3 demo/analysis/build_filter.py
ffmpeg -i in.mp4 -filter_complex_script /tmp/motion/filter.txt -map "[outv]" -r 15 \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p out.mp4
```

## What the demo proves, at a glance

- **TL** — `cdmcp-mux status` compact view: the daemon has **2 contexts**, one
  owning `pageId 2 /alpha`, the other owning `pageId 3 /bravo`.
- **TR** — live tail of the mux log: both `ctx.connect` and `ctx.new_page`
  events are recorded for two distinct context UUIDs.
- **BL** — Client A's own `list_pages` shows **only** its page.
- **BR** — Client B's own `list_pages` shows **only** its page.
- **ALPHA** — a real Chromium window rendering `/alpha`, driven by Client A.
- **BRAVO** — a second real Chromium window rendering `/bravo`, driven by
  Client B. Both windows belong to the same Chromium process and the same
  profile, but to different Puppeteer `BrowserContext`s.

## Requirements

- Node ≥ 20, a built repo (`npm install && npm run build` from the repo root).
- An X display. The reference setup uses VNC on `:1` with TigerVNC + fluxbox.
- `xterm`, `xdotool`, and `chromium` on `PATH`. For recording, `ffmpeg` too.
- If your chromium needs `--no-sandbox` (most containers do), the wrapper in
  `scripts/chromium-wrap.sh` handles it.

## Reproducing the demo

From the repo root:

```bash
npm install && npm run build

# starts HTTP server + 4 labelled xterms on :1
demo/scripts/run.sh
```

The script prints what to type in each xterm. Quick reference:

| xterm        | command  | what it does                                      |
|--------------|----------|---------------------------------------------------|
| `TR-log`     | `./t.sh` | `tail -F` the mux log                             |
| `BL-clientA` | `./a.sh` | Client A: spawn mux shim, open `/alpha`, list pages |
| `BR-clientB` | `./b.sh` | Client B: same, for `/bravo`                      |
| `TL-status`  | `./c.sh` | compact snapshot of the daemon                    |

After the two Chromium windows open (a few seconds each), tidy them up:

```bash
demo/scripts/arrange.sh    # places ALPHA + BRAVO side-by-side below the xterms
```

To also record the screen:

```bash
demo/scripts/run.sh --record /tmp/my-demo.mp4
# ... drive the demo ...
demo/scripts/teardown.sh   # sends SIGINT to ffmpeg so the mp4 finalizes cleanly
```

All scripts resolve paths relative to themselves and write scratch state to
`$DEMO_WORK` (default `/tmp/cdmcp-mux-demo`). Override `DEMO_WORK`,
`DEMO_DISPLAY`, `DEMO_CHROMIUM`, or `CDMCP_MUX_CHROMIUM` to change defaults.

## Scripts

| file                 | role                                                     |
|----------------------|----------------------------------------------------------|
| `run.sh`             | orchestrator — starts server and xterms                  |
| `teardown.sh`        | stops everything; finalizes any running recording first  |
| `arrange.sh`         | windows-management for Chrome placement                  |
| `env.sh`             | sourced by every script — sets `CDMCP_MUX_*` + paths     |
| `server.mjs`         | local HTTP server with `/alpha` + `/bravo`               |
| `client.mjs`         | MCP-over-stdio client that drives `cdmcp-mux`            |
| `a.sh` / `b.sh`      | shortcuts: run `client.mjs A /alpha` / `B /bravo`        |
| `s.sh`               | raw `cdmcp-mux status` output                            |
| `c.sh`               | compact status — human-readable, fits in small xterm     |
| `t.sh`               | tails the mux log                                        |
| `chromium-wrap.sh`   | wraps `/usr/bin/chromium` with `--no-sandbox` flags      |

---

## How the mux was developed and tested, with agents

This project was built end-to-end by Claude (Opus 4.7 in Claude Code) in one
working session, with the user driving requirements via conversation. The
agentic workflow had four distinct phases.

### 1. Requirements discovery — upstream research before design

The user began by asking whether upstream `chrome-devtools-mcp` already
supports multi-agent scenarios. Instead of guessing, the agent used `gh` to
search upstream issues and pull-request discussions, then read the key
threads:

- [#926](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926) — multi-session / BrowserContext isolation (closed as completed)
- [#1019](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1019) — `pageId` routing for multi-agent workflows (closed, shipped as `--experimentalPageIdRouting`)
- [#1034](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1034) — tab context isolation (duplicate of #1019)
- [#1245](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1245) — make `pageId` routing default (open)

That reading is what established the design constraint that the mux could
simply **wrap** upstream with the experimental flag, rather than fork it.

### 2. Architecture discussion — interactive, 1:1-replica constraint locked in

Each design choice was negotiated before code was written. The key points the
user pushed back on:

- "No — multiple MCP clients, one Chrome, not one client with N contexts."
  → Architecture simplified: each client socket is a fresh context, no labels.
- "`cdmcp-mux` needs to have exact 1:1 replica of the tools chrome-devtools-mcp
  exposes."
  → Stripping `pageId` / `isolatedContext` from advertised schemas, injecting
  them only on `tools/call`. No mux-specific tools. Debug via out-of-band CLI.
- "No performance backpressure until functionality backpressure is complete."
  → Reframed the entire test plan to remove p50/p99 / memory / fd gates.

Only after the shape was agreed did coding start.

### 3. Implementation — TDD with a tiered test plan

The agent scaffolded the repo (see `src/`), then built correctness tests in
five tiers:

| Tier | Layer                               | Harness used          |
|------|-------------------------------------|------------------------|
| 1    | Rewrite correctness (unit)          | pure functions         |
| 2    | Ownership & isolation               | `FakeUpstream` (stub)  |
| 3    | Concurrency correctness             | `FakeUpstream`         |
| 4    | Failure modes (hang/crash/slow/etc) | `FakeUpstream`         |
| 5    | Cleanup correctness                 | `FakeUpstream`         |
| smoke | Real Chromium end-to-end           | real `chrome-devtools-mcp` + headless Chromium |
| e2e  | Compiled binary, two shim processes | spawned binaries       |

`FakeUpstream` is a programmable stdio stub that speaks the MCP protocol and
records a "rewrite tape" — that's how concurrency correctness is asserted
without needing real Chrome for every test. Each test scenario was chosen to
catch a specific failure mode, not for coverage metrics.

Final suite: **58 tests, ~19 s wall time, all passing.** See
[`../DEMO.md`](../DEMO.md) for the PRD-to-test mapping.

### 4. Visual demonstration via VNC automation

After unit/integration passes, the user asked for a screen recording showing
the mux working with real Chromium. The agent drove the VNC directly using
an MCP-controlled VNC input tool (`vnc_click`, `vnc_type_text`). Two rough
drafts were produced before the final take:

1. **First take (rejected)** — four xterms only, no Chrome. Demonstrated the
   wrong thing, and shift-key characters (`|`, `&`, `"`) came through garbled
   via the VNC typing tool.

2. **Second take (rejected)** — right scenario, but ffmpeg ran with a fixed
   `-t 42` and cut off before the final `cdmcp-mux status` frame was ready.

3. **Third take (this one)** — commands were pre-baked as shell scripts
   (`./a.sh`, `./b.sh`, `./c.sh`, `./t.sh`) so only shift-free characters
   needed to be typed over VNC. Chromium was made visible with
   `CDMCP_MUX_HEADLESS=false` plus a wrapper adding `--no-sandbox`. ffmpeg was
   started in the background with no duration limit and `SIGINT`'d once the
   composed frame was held. Chrome windows were placed side-by-side via
   `xdotool`.

Every frame before proceeding was checked via `vnc_screenshot`. The video
length came out as 2:26 — driven by the actual flow, not a preset timer.

### Task tracking

Every major milestone (scaffold, shim, daemon, rewrite layer, FakeUpstream,
five test tiers, smoke, binary e2e, CLI, PRD demo) was tracked via Claude
Code's `TaskCreate` / `TaskUpdate` so progress was auditable and the agent
never "lost the thread" across a long session.
