# PRD → Test mapping

The PRD the user specified in conversation, with each requirement cross-referenced to
one or more passing tests. Run `CDMCP_MUX_CHROMIUM=/usr/bin/chromium npm test` to
verify.

## 1. Multiple independent MCP clients share one Chrome

> "Allow multiple Claude Code instances to connect to one chrome instance via simple MCP configuration."

Every `.mcp.json` entry spawns its own `cdmcp-mux` stdio shim, which connects
to a single shared daemon holding one `chrome-devtools-mcp` subprocess that in
turn controls one Chrome process with one fixed `--userDataDir`.

Tests:
- `tier2_ownership.test.ts > new_page in ctx A is not visible to ctx B` — two
  shims, two contexts, one upstream subprocess, pages don't leak.
- `smoke_real_chrome.test.ts` — real headless Chromium, two shims, independent
  pages, verified on-page content differs per context.

## 2. Per-client tab ownership ("seamless switching")

> "Handles switching tabs owned by each context seamlessly."

Each client connection → fresh `ctx-<uuid>` → own Puppeteer `BrowserContext` →
own `pageId` set. The daemon tracks ownership and rejects any call targeting a
non-owned pageId before forwarding upstream.

Tests:
- `tier2_ownership.test.ts > close_page on unowned pageId is rejected before upstream`
- `tier2_ownership.test.ts > page-scoped tool with explicit unowned pageId is rejected`
- `tier2_ownership.test.ts > per-context selected page does not affect other contexts`
- `tier2_ownership.test.ts > list_pages filter removes other-context rows`

## 3. 1:1 replica of `chrome-devtools-mcp` tool surface

> "cdmcp-mux needs to have exact 1:1 replica of the tools chrome devtools mcp exposes."

Outbound `tools/list` has `pageId` and `isolatedContext` stripped from every
schema. Clients see the same tools they would see talking directly to vanilla
`chrome-devtools-mcp`. The mux re-injects the fields behind the scenes on each
`tools/call`.

Tests:
- `tier1_rewrite.test.ts > Tier 1 — schema stripping` — 6 unit tests covering
  every shape: fields in `properties`, fields in `required`, tools that should
  be untouched.
- `tier2_ownership.test.ts > tools/list strips pageId and isolatedContext` —
  integration check: actual response over the socket has clean schemas.
- `tier2_ownership.test.ts > isolatedContext is always injected on new_page upstream`
  — verifies the re-injection via the rewrite tape.
- `tier2_ownership.test.ts > caller-supplied isolatedContext is overridden` —
  prevents clients from escaping their sandbox by setting their own isolation
  name.
- `tier2_ownership.test.ts > global tool (lighthouse_audit) passes through unchanged`
  — tools with no `pageId` concept stay untouched.

## 4. Identification via socket connection

> "How would mux daemon id the 2 claude codes" → by the socket connection
> itself.

Each `connect()` call from a shim to the unix socket is assigned a fresh
UUID-based context. No env vars, no labels, no cross-client correlation.

Tests:
- `tier1_rewrite.test.ts > generates distinct context ids`
- `tier2_ownership.test.ts > new_page in ctx A is not visible to ctx B` — relies
  on per-connection context allocation.

## 5. Concurrency correctness — no race between contexts

> "Multiple agents working on the same chrome without collision."

Every page-scoped call carries its context's `pageId` as it goes upstream, so
interleaved calls never corrupt each other's target page.

Tests:
- `tier3_concurrency.test.ts > interleaved calls route to correct context` —
  6-way parallel burst across two contexts, rewrite tape verified.
- `tier3_concurrency.test.ts > concurrent new_page: each context receives only its own assigned pageId`
- `tier3_concurrency.test.ts > concurrent list_pages bleed-through check` — 40
  parallel list_pages calls across 2 contexts with 5 tabs total, zero
  bleed-through.
- `tier3_concurrency.test.ts > JSON-RPC id space is per-connection`
- `tier3_concurrency.test.ts > flood from one context does not drop responses from another`

## 6. Failure-mode correctness

Functional correctness under upstream hang/crash/error, disconnect mid-call,
large payloads, slow upstream, and daemon cold start.

Tests (all in `tier4_failure.test.ts`):
- `upstream hang on one method does not block unrelated calls`
- `upstream error response is delivered cleanly and other calls work`
- `upstream crash: in-flight calls error, subsequent calls restart upstream`
- `shim disconnect mid-call: daemon cleans up ownership, no dangling entries`
- `large response payload arrives intact` (1 MB)
- `slow upstream: per-context calls serialize cleanly, eventually complete`
- `daemon cold start with stale unix socket file: replaces and listens`

## 7. Cleanup correctness

Owned pages are closed in upstream when a shim disconnects, regardless of
whether the disconnect was graceful or forced. Independent contexts are not
affected.

Tests (all in `tier5_cleanup.test.ts`):
- `shim disconnect closes all of its owned pages in upstream`
- `killing shim A leaves context B entirely intact`
- `socket destroy (simulating SIGKILL on shim) triggers cleanup`
- `daemon.stop() gracefully shuts down: closes sockets, unlinks files`
- `independent cleanup order: B disconnects first, then A`
- `reconnect after disconnect gets a fresh context (no page carryover)`
- `rapid connect/disconnect churn does not leak contexts`

## 8. Debugging surface

`cdmcp-mux status`, `cdmcp-mux tail`, and `MCP_MUX_DEBUG=1` — all out-of-band,
nothing exposed as MCP tools to keep the 1:1 surface clean.

Tests:
- `cli_tools.test.ts > mux/status returns daemon + contexts snapshot`
- `cli_tools.test.ts > status socket doesn't get counted as a normal context`

## Non-goals asserted not present

Per the testing conversation, performance / latency / fd / memory gates are
explicitly deferred:

- No p50/p99 latency assertions in any test.
- No memory plateau gates.
- No fd-count leak assertions (only functional "context count returns to 0"
  correctness).
- No fairness / head-of-line independence with timing thresholds.

These land in a future perf pass once the functional foundation is proven (it
now is).

## 9. Compiled binary end-to-end

Beyond the unit/integration tests, one more test spawns the actual compiled
`cdmcp-mux` binary twice (as a real MCP client would via `.mcp.json`),
auto-spawning the daemon through the normal discovery path, and verifies
isolation over real Chromium. This proves the packaging + auto-spawn + stdio
pipe all work as shipped.

- `e2e_binary.test.ts > two independent shim binaries isolate tabs end-to-end`

## Full run

```
$ CDMCP_MUX_CHROMIUM=/usr/bin/chromium npm test
 ✓ test/tier1_rewrite.test.ts      (24 tests)   ~14 ms
 ✓ test/tier2_ownership.test.ts    (11 tests)   ~1.9 s
 ✓ test/tier3_concurrency.test.ts   (5 tests)   ~0.9 s
 ✓ test/tier4_failure.test.ts       (7 tests)   ~4.9 s
 ✓ test/tier5_cleanup.test.ts       (7 tests)   ~2.2 s
 ✓ test/cli_tools.test.ts           (2 tests)   ~0.4 s
 ✓ test/smoke_real_chrome.test.ts   (1 test)    ~6.3 s
 ✓ test/e2e_binary.test.ts          (1 test)    ~2.5 s

 Test Files  8 passed (8)
      Tests  58 passed (58)
   Duration  ~19 s
```
