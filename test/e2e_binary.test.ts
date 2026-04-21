/**
 * Final end-to-end test: spawns the actual compiled cdmcp-mux binary twice,
 * speaks MCP over each binary's stdio (exactly as a real MCP client would),
 * and verifies per-client tab isolation through the full auto-spawned daemon
 * path.
 */
import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {spawn, ChildProcess} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {LineReader, writeMessage, isResponse} from '../src/proto/jsonrpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(__dirname, '../dist/bin/cdmcp-mux.js');

class McpClient {
  #proc: ChildProcess;
  #pending = new Map<number, (v: any) => void>();
  #nextId = 1;
  constructor(proc: ChildProcess) {
    this.#proc = proc;
    const reader = new LineReader((msg) => {
      if (isResponse(msg) && msg.id != null) {
        const cb = this.#pending.get(msg.id as number);
        if (cb) {
          this.#pending.delete(msg.id as number);
          cb(msg);
        }
      }
    });
    proc.stdout!.on('data', (c) => reader.feed(c));
    proc.stderr!.on('data', (c) => {
      if (process.env.DUMP_BIN_STDERR === '1') {
        process.stderr.write('[bin] ' + c);
      }
    });
  }
  async request(method: string, params?: unknown): Promise<any> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      writeMessage(this.#proc.stdin!, {jsonrpc: '2.0', id, method, params});
    });
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    return this.request('tools/call', {name, arguments: args});
  }
  async init() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'e2e', version: '0'},
    });
    if (r.error) throw new Error(JSON.stringify(r.error));
    writeMessage(this.#proc.stdin!, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }
  close() {
    try {
      this.#proc.stdin!.end();
    } catch {}
    try {
      this.#proc.kill('SIGTERM');
    } catch {}
  }
}

function envForIsolatedRun(workDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CDMCP_MUX_SOCKET: path.join(workDir, 'mux.sock'),
    CDMCP_MUX_USER_DATA_DIR: path.join(workDir, 'chrome-profile'),
    XDG_STATE_HOME: path.join(workDir, 'state'),
  };
}

let workDir: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  workDir = path.join(os.tmpdir(), `mux-e2e-${Date.now()}`);
  fs.mkdirSync(workDir, {recursive: true});

  if (!fs.existsSync(binPath)) {
    throw new Error(`missing compiled binary: ${binPath}. Run npm run build.`);
  }

  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    res.setHeader('content-type', 'text/html');
    if (url.startsWith('/e2e-a')) {
      res.end('<!doctype html><html><head><title>eA</title></head><body>alpha-e2e</body></html>');
    } else if (url.startsWith('/e2e-b')) {
      res.end('<!doctype html><html><head><title>eB</title></head><body>bravo-e2e</body></html>');
    } else {
      res.end('<!doctype html><html><body>root</body></html>');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad addr');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 30_000);

afterAll(async () => {
  server?.close();
  try {
    fs.rmSync(workDir, {recursive: true, force: true});
  } catch {}
}, 30_000);

describe('E2E — compiled cdmcp-mux binary, real Chromium, auto-spawn daemon', () => {
  it('two independent shim binaries isolate tabs end-to-end', async () => {
    const env = envForIsolatedRun(workDir);
    // Point the auto-spawned daemon at a local chromium via env var. Prefer an
    // outer-set CDMCP_MUX_CHROMIUM (CI wraps google-chrome with --no-sandbox);
    // fall back to /usr/bin/chromium for local dev.
    env.CDMCP_MUX_CHROMIUM =
      process.env.CDMCP_MUX_CHROMIUM ?? '/usr/bin/chromium';
    // The test suite runs on headless CI boxes without an X display, so force
    // headless for the subprocess path (Driver sets it directly).
    env.CDMCP_MUX_HEADLESS = 'true';

    // Spawn first shim; it'll auto-spawn the daemon.
    const procA = spawn(process.execPath, [binPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const a = new McpClient(procA);
    await a.init();

    // Second shim attaches to the already-running daemon.
    const procB = spawn(process.execPath, [binPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const b = new McpClient(procB);
    await b.init();

    try {
      const aResp = await a.call('new_page', {url: `${baseUrl}/e2e-a`});
      expect(aResp.error).toBeUndefined();
      const bResp = await b.call('new_page', {url: `${baseUrl}/e2e-b`});
      expect(bResp.error).toBeUndefined();

      const aList = await a.call('list_pages', {});
      const bList = await b.call('list_pages', {});
      const aText = (aList.result.content as any[]).map((c) => c.text).join('\n');
      const bText = (bList.result.content as any[]).map((c) => c.text).join('\n');

      expect(aText).toContain('/e2e-a');
      expect(aText).not.toContain('/e2e-b');
      expect(bText).toContain('/e2e-b');
      expect(bText).not.toContain('/e2e-a');

      // tools/list surface check: optional pageId (injected internally) is
      // hidden, required pageId on select_page / close_page stays visible.
      const tl = await a.request('tools/list', {});
      const nativeRequiresPageId = new Set(['select_page', 'close_page']);
      for (const t of tl.result.tools) {
        if (!t.inputSchema?.properties) continue;
        if (nativeRequiresPageId.has(t.name)) {
          expect(t.inputSchema.properties).toHaveProperty('pageId');
        } else {
          expect(t.inputSchema.properties).not.toHaveProperty('pageId');
        }
      }
      const newPage = tl.result.tools.find((t: any) => t.name === 'new_page');
      expect(newPage?.inputSchema?.properties).toHaveProperty('isolatedContext');
    } finally {
      a.close();
      b.close();
      // Kill the auto-spawned daemon by PID file
      const pidFile = path.join(workDir, 'state', 'cdmcp-mux', 'daemon.pid');
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      // Give processes a moment to exit cleanly
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 60_000);
});
