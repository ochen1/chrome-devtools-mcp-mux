/**
 * Test driver: launches a Daemon pointed at a FakeUpstream subprocess, opens N
 * shim connections directly over the daemon socket, and exposes helpers to
 * call tools + drain the upstream tape.
 *
 * Each "Shim" is just a JSON-RPC client over a unix-socket connection to the
 * daemon. This avoids spawning the cdmcp-mux bin for every test — faster and
 * deterministic.
 */
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  LineReader,
  writeMessage,
  JsonRpcMessage,
  isResponse,
  JsonRpcRequest,
} from '../../src/proto/jsonrpc.js';
import {Daemon} from '../../src/daemon/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DriverOpts {
  /** Use FakeUpstream (default) or real chrome-devtools-mcp. */
  real?: boolean;
  /** For real mode: pass through extra env. */
  env?: Record<string, string>;
}

export class ShimClient {
  #sock: net.Socket;
  #pending = new Map<number, (msg: JsonRpcMessage) => void>();
  #nextId = 1;
  #notifications: Array<{method: string; params: unknown}> = [];
  #closed = false;
  #closeListeners: Array<() => void> = [];

  constructor(sock: net.Socket) {
    this.#sock = sock;
    const reader = new LineReader((msg) => {
      if (isResponse(msg) && msg.id != null) {
        const cb = this.#pending.get(msg.id as number);
        if (cb) {
          this.#pending.delete(msg.id as number);
          cb(msg);
        }
      } else if ('method' in msg) {
        this.#notifications.push({
          method: (msg as any).method,
          params: (msg as any).params,
        });
      }
    });
    sock.on('data', (c) => reader.feed(c));
    sock.on('close', () => {
      this.#closed = true;
      for (const cb of this.#closeListeners) cb();
      for (const [, cb] of this.#pending) {
        cb({
          jsonrpc: '2.0',
          id: 0,
          error: {code: -32603, message: 'socket closed'},
        });
      }
      this.#pending.clear();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  onClose(cb: () => void): void {
    if (this.#closed) cb();
    else this.#closeListeners.push(cb);
  }

  nextId(): number {
    return this.#nextId++;
  }

  async request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId();
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      const req: JsonRpcRequest = {jsonrpc: '2.0', id, method, params};
      writeMessage(this.#sock, req);
    });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.request('tools/call', {name, arguments: args});
  }

  notifications(): Array<{method: string; params: unknown}> {
    return this.#notifications.slice();
  }

  async initialize(): Promise<void> {
    const r = (await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {name: 'test-shim', version: '0.0.1'},
    })) as any;
    if (r.error) throw new Error(`init failed: ${JSON.stringify(r.error)}`);
    writeMessage(this.#sock, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  }

  close(): void {
    try {
      this.#sock.end();
      this.#sock.destroy();
    } catch {}
  }
}

export class Driver {
  daemon!: Daemon;
  socketPath!: string;
  controlPath!: string;
  workDir!: string;
  #controlSock?: net.Socket;
  #controlReader?: LineReader;
  #ctrlPending = new Map<number, (v: any) => void>();
  #ctrlNextId = 1;

  async start(opts: DriverOpts = {}): Promise<void> {
    const id = `mux-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.workDir = path.join(os.tmpdir(), id);
    fs.mkdirSync(this.workDir, {recursive: true});
    this.socketPath = path.join(this.workDir, 'mux.sock');
    this.controlPath = path.join(this.workDir, 'fake-control.sock');

    let upstream;
    if (opts.real) {
      upstream = {
        executablePath: process.env.CDMCP_MUX_CHROMIUM ?? '/usr/bin/chromium',
        userDataDir: path.join(this.workDir, 'chrome-profile'),
        headless: true,
      };
    } else {
      const fakeEntry = path.resolve(__dirname, 'FakeUpstream.ts');
      upstream = {
        customCmd: process.execPath,
        customArgs: [
          '--import',
          'tsx',
          fakeEntry,
          this.controlPath,
        ],
      };
    }

    this.daemon = new Daemon({
      socketPath: this.socketPath,
      upstream,
    });
    await this.daemon.start();

    if (!opts.real) {
      // Connect control socket after upstream starts
      await this.#connectControl();
    }
  }

  async #connectControl(): Promise<void> {
    // Wait for the control socket to appear
    const start = Date.now();
    while (!fs.existsSync(this.controlPath)) {
      if (Date.now() - start > 5000) {
        throw new Error(
          `fake-upstream control socket never appeared at ${this.controlPath}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const s = net.createConnection(this.controlPath);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('error', reject);
    });
    this.#controlSock = s;
    this.#controlReader = new LineReader((msg: any) => {
      const id = msg.id;
      const cb = this.#ctrlPending.get(id);
      if (cb) {
        this.#ctrlPending.delete(id);
        cb(msg.result);
      }
    });
    s.on('data', (c) => this.#controlReader!.feed(c));
  }

  async control(cmd: Record<string, unknown>): Promise<any> {
    if (!this.#controlSock) throw new Error('control socket not connected');
    const id = this.#ctrlNextId++;
    return new Promise((resolve) => {
      this.#ctrlPending.set(id, resolve);
      writeMessage(this.#controlSock!, {
        jsonrpc: '2.0',
        id,
        method: 'ctrl',
        ...cmd,
      } as any);
    });
  }

  async drainTape(): Promise<Array<{id: any; name: string; arguments: any}>> {
    const r = await this.control({cmd: 'drainTape'});
    return r.tape ?? [];
  }

  async pageState(): Promise<any> {
    return this.control({cmd: 'pageState'});
  }

  connectShim(): Promise<ShimClient> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.socketPath);
      s.once('connect', () => resolve(new ShimClient(s)));
      s.once('error', reject);
    });
  }

  async newShim(): Promise<ShimClient> {
    const s = await this.connectShim();
    await s.initialize();
    return s;
  }

  async stop(): Promise<void> {
    try {
      this.#controlSock?.end();
      this.#controlSock?.destroy();
    } catch {}
    await this.daemon.stop();
    try {
      fs.rmSync(this.workDir, {recursive: true, force: true});
    } catch {}
  }
}

export function textOf(result: any): string {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map((c: any) => c.text ?? '').join('\n');
}

export function pageIdsIn(text: string): number[] {
  const out: number[] = [];
  const re = /Page\s+idx\s+(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}
