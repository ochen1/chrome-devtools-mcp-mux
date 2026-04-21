import net from 'node:net';
import fs from 'node:fs';
import {
  JsonRpcMessage,
  JsonRpcRequest,
  LineReader,
  isRequest,
  isNotification,
  isResponse,
  writeMessage,
} from '../proto/jsonrpc.js';
import {SOCKET_PATH, ensureDirs, PID_PATH} from '../paths.js';
import {Upstream, UpstreamOptions} from './upstream.js';
import {MuxContext} from './context.js';
import {
  stripToolList,
  indexToolSpecs,
  rewriteToolCall,
  filterListPagesResult,
  extractNewPageId,
  ToolDesc,
  ToolSpec,
} from './rewrite.js';
import {log} from './logger.js';

export interface DaemonOptions {
  socketPath?: string;
  upstream?: UpstreamOptions;
  idleShutdownMs?: number;
}

const SERVER_INFO = {name: 'chrome-devtools-mcp-mux', version: '0.1.0'};
const PROTOCOL_VERSION = '2025-06-18';

export class Daemon {
  #server: net.Server | null = null;
  #upstream: Upstream;
  #tools: ToolDesc[] = [];
  #toolSpecs = new Map<string, ToolSpec>();
  #rawToolsRegistry: Map<string, ToolDesc> = new Map();
  #contexts = new Map<net.Socket, MuxContext>();
  #socketPath: string;
  #idleTimer: NodeJS.Timeout | null = null;
  #idleShutdownMs: number;
  #stopping = false;

  constructor(opts: DaemonOptions = {}) {
    this.#socketPath = opts.socketPath ?? SOCKET_PATH;
    // Env-driven upstream defaults so the compiled binary can find a local
    // Chromium without code changes.
    const envUpstream: UpstreamOptions = {};
    if (process.env.CDMCP_MUX_CHROMIUM) {
      envUpstream.executablePath = process.env.CDMCP_MUX_CHROMIUM;
    }
    if (process.env.CDMCP_MUX_HEADLESS === 'false') {
      envUpstream.headless = false;
    }
    this.#upstream = new Upstream({...envUpstream, ...opts.upstream});
    this.#idleShutdownMs = opts.idleShutdownMs ?? 0; // 0 disables idle shutdown
  }

  async start(): Promise<void> {
    ensureDirs();
    // Remove stale socket
    try {
      fs.unlinkSync(this.#socketPath);
    } catch {}

    await this.#upstream.start();
    // Cache tool list from upstream
    const resp = (await this.#upstream.request({
      jsonrpc: '2.0',
      id: this.#upstream.nextId(),
      method: 'tools/list',
      params: {},
    })) as {result?: {tools?: ToolDesc[]}; error?: unknown};
    if ('error' in resp && resp.error) {
      throw new Error(`upstream tools/list failed: ${JSON.stringify(resp.error)}`);
    }
    this.#tools = resp.result?.tools ?? [];
    this.#toolSpecs = indexToolSpecs(this.#tools);
    for (const t of this.#tools) this.#rawToolsRegistry.set(t.name, t);
    log('daemon.tools_loaded', {count: this.#tools.length});

    // Upstream crash handling: clear contexts and restart on next op
    this.#upstream.on('exit', () => {
      if (this.#stopping) return;
      log('daemon.upstream_lost');
      for (const [sock, ctx] of this.#contexts) {
        try {
          writeMessage(sock, {
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: {
              level: 'error',
              data: 'upstream chrome-devtools-mcp terminated; context reset',
            },
          });
        } catch {}
        ctx.ownedPages.clear();
        ctx.selectedPageId = null;
      }
    });

    this.#server = net.createServer((sock) => this.#onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.#socketPath, () => {
        try {
          fs.chmodSync(this.#socketPath, 0o600);
        } catch {}
        log('daemon.listening', {socket: this.#socketPath});
        resolve();
      });
    });

    // Write PID file
    try {
      fs.writeFileSync(PID_PATH, String(process.pid));
    } catch {}

    this.#armIdleTimer();
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  get contextCount(): number {
    let n = 0;
    for (const c of this.#contexts.values()) if (c.role !== 'control') n++;
    return n;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    for (const sock of this.#contexts.keys()) {
      try {
        sock.end();
      } catch {}
    }
    await new Promise<void>((r) =>
      this.#server ? this.#server.close(() => r()) : r(),
    );
    try {
      fs.unlinkSync(this.#socketPath);
    } catch {}
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    await this.#upstream.stop();
  }

  snapshot(): object {
    return {
      pid: process.pid,
      socket: this.#socketPath,
      upstreamReady: this.#upstream.isReady(),
      toolCount: this.#tools.length,
      contexts: [...this.#contexts.values()]
        .filter((c) => c.role !== 'control')
        .map((c) => ({
          id: c.id,
          connectedAt: c.connectedAt,
          isolatedContext: c.isolatedContext,
          ownedPages: [...c.ownedPages.values()],
          selectedPageId: c.selectedPageId,
        })),
    };
  }

  #armIdleTimer(): void {
    if (!this.#idleShutdownMs) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#contexts.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#contexts.size === 0 && !this.#stopping) {
        log('daemon.idle_shutdown');
        this.stop().catch(() => {});
      }
    }, this.#idleShutdownMs);
  }

  #onConnection(sock: net.Socket): void {
    const ctx = new MuxContext();
    this.#contexts.set(sock, ctx);
    log('ctx.connect', {ctx: ctx.id, isolatedContext: ctx.isolatedContext});

    const reader = new LineReader(
      (msg) => this.#onClientMessage(sock, ctx, msg).catch((err) => {
        log('ctx.error', {ctx: ctx.id, err: (err as Error).message});
      }),
      (err, line) => log('ctx.parse_error', {ctx: ctx.id, err: err.message, line: line.slice(0, 200)}),
    );
    sock.on('data', (c) => reader.feed(c));

    const cleanup = () => {
      if (!this.#contexts.has(sock)) return;
      this.#contexts.delete(sock);
      log('ctx.disconnect', {
        ctx: ctx.id,
        ownedPages: [...ctx.ownedPages.keys()],
      });
      void this.#cleanupContext(ctx);
      this.#armIdleTimer();
    };
    sock.on('close', cleanup);
    sock.on('error', (err) => {
      log('ctx.socket_error', {ctx: ctx.id, err: err.message});
      cleanup();
    });

    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  async #cleanupContext(ctx: MuxContext): Promise<void> {
    if (!this.#upstream.isReady()) return;
    // Close all owned pages.
    const ids = [...ctx.ownedPages.keys()];
    for (const pageId of ids) {
      try {
        await this.#upstream.request({
          jsonrpc: '2.0',
          id: this.#upstream.nextId(),
          method: 'tools/call',
          params: {
            name: 'close_page',
            arguments: {pageId},
          },
        });
      } catch (err) {
        log('ctx.cleanup_close_error', {
          ctx: ctx.id,
          pageId,
          err: (err as Error).message,
        });
      }
    }
    ctx.ownedPages.clear();
  }

  async #onClientMessage(
    sock: net.Socket,
    ctx: MuxContext,
    msg: JsonRpcMessage,
  ): Promise<void> {
    if (isRequest(msg)) {
      await this.#handleRequest(sock, ctx, msg);
    } else if (isNotification(msg)) {
      // Client notifications (e.g. notifications/initialized) — swallow
      log('ctx.notification', {ctx: ctx.id, method: (msg as any).method});
    } else if (isResponse(msg)) {
      // We don't send requests to shims; ignore unexpected responses.
      log('ctx.unexpected_response', {ctx: ctx.id});
    }
  }

  async #handleRequest(
    sock: net.Socket,
    ctx: MuxContext,
    req: JsonRpcRequest,
  ): Promise<void> {
    const method = req.method;
    try {
      switch (method) {
        case 'mux/status': {
          ctx.role = 'control';
          writeMessage(sock, {
            jsonrpc: '2.0',
            id: req.id,
            result: this.snapshot(),
          });
          return;
        }
        case 'initialize': {
          writeMessage(sock, {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {tools: {}},
              serverInfo: SERVER_INFO,
            },
          });
          return;
        }
        case 'tools/list': {
          writeMessage(sock, {
            jsonrpc: '2.0',
            id: req.id,
            result: {tools: stripToolList(this.#tools)},
          });
          return;
        }
        case 'tools/call': {
          const params = (req.params ?? {}) as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          const name = params.name ?? '';
          const rewrite = rewriteToolCall(
            name,
            params.arguments,
            ctx,
            this.#toolSpecs,
          );
          if (process.env.MCP_MUX_DEBUG === '1') {
            log('tool.rewrite', {
              ctx: ctx.id,
              tool: name,
              in: params.arguments,
              out: rewrite.params,
            });
          }
          if (rewrite.shortCircuitError) {
            writeMessage(sock, {
              jsonrpc: '2.0',
              id: req.id,
              error: rewrite.shortCircuitError,
            });
            return;
          }
          if (!this.#upstream.isReady()) {
            // Lazy restart
            try {
              await this.#upstream.start();
            } catch (err) {
              writeMessage(sock, {
                jsonrpc: '2.0',
                id: req.id,
                error: {
                  code: -32603,
                  message: `upstream unavailable: ${(err as Error).message}`,
                },
              });
              return;
            }
          }
          const upstreamId = this.#upstream.nextId();
          const resp = (await this.#upstream.request({
            jsonrpc: '2.0',
            id: upstreamId,
            method: 'tools/call',
            params: {name, arguments: rewrite.params},
          })) as {result?: any; error?: any; id?: unknown};

          if (resp.error) {
            writeMessage(sock, {
              jsonrpc: '2.0',
              id: req.id,
              error: resp.error,
            });
            return;
          }

          // Post-call ownership updates
          let result = resp.result;
          if (name === 'new_page') {
            const info = extractNewPageId(result);
            if (info) {
              ctx.addPage(info.pageId, info.url);
              log('ctx.new_page', {
                ctx: ctx.id,
                pageId: info.pageId,
                url: info.url,
              });
            }
            // Filter list of pages in response
            result = filterListPagesResult(result, ctx);
          } else if (name === 'list_pages') {
            result = filterListPagesResult(result, ctx);
          } else if (name === 'close_page') {
            const pageId = rewrite.params.pageId as number;
            ctx.removePage(pageId);
          } else if (name === 'select_page' && rewrite.markSelectPageId != null) {
            ctx.selectedPageId = rewrite.markSelectPageId;
          }

          // Any tool that returns a pages listing in its response should also be filtered.
          if (
            result &&
            typeof result === 'object' &&
            Array.isArray((result as any).content)
          ) {
            result = filterListPagesResult(result, ctx);
          }

          writeMessage(sock, {jsonrpc: '2.0', id: req.id, result});
          return;
        }
        default: {
          // Forward unknown methods transparently (best-effort).
          if (!this.#upstream.isReady()) {
            writeMessage(sock, {
              jsonrpc: '2.0',
              id: req.id,
              error: {code: -32601, message: `method not found: ${method}`},
            });
            return;
          }
          const resp = (await this.#upstream.request({
            jsonrpc: '2.0',
            id: this.#upstream.nextId(),
            method,
            params: req.params,
          })) as {result?: unknown; error?: unknown};
          writeMessage(sock, {
            jsonrpc: '2.0',
            id: req.id,
            ...(resp.error ? {error: resp.error} : {result: resp.result}),
          } as JsonRpcMessage);
        }
      }
    } catch (err) {
      writeMessage(sock, {
        jsonrpc: '2.0',
        id: req.id,
        error: {code: -32603, message: (err as Error).message},
      });
    }
  }
}

export async function runDaemon(): Promise<void> {
  const daemon = new Daemon();
  await daemon.start();
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
