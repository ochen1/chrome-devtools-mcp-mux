import {spawn, ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {
  JsonRpcMessage,
  JsonRpcRequest,
  LineReader,
  isResponse,
  writeMessage,
} from '../proto/jsonrpc.js';
import {USER_DATA_DIR} from '../paths.js';
import {log} from './logger.js';

const require = createRequire(import.meta.url);

export interface UpstreamOptions {
  customCmd?: string;
  customArgs?: string[];
  userDataDir?: string;
  executablePath?: string;
  headless?: boolean;
}

export class Upstream extends EventEmitter {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #reader = new LineReader(
    (m) => this.#onMessage(m),
    (err, line) => log('upstream.parse_error', {err: err.message, line: line.slice(0, 200)}),
  );
  #pending = new Map<
    string | number,
    (msg: JsonRpcMessage) => void
  >();
  #nextId = 1;
  #ready = false;
  #starting: Promise<void> | null = null;
  readonly opts: UpstreamOptions;

  constructor(opts: UpstreamOptions = {}) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    return this.#starting;
  }

  async #doStart(): Promise<void> {
    let cmd: string;
    let args: string[];
    if (this.opts.customCmd) {
      cmd = this.opts.customCmd;
      args = [...(this.opts.customArgs ?? [])];
    } else {
      const pkgPath = require.resolve('chrome-devtools-mcp/package.json');
      const binRel = JSON.parse(
        require('node:fs').readFileSync(pkgPath, 'utf8'),
      ).bin['chrome-devtools-mcp'] as string;
      const entry = path.resolve(path.dirname(pkgPath), binRel);
      cmd = process.execPath;
      args = [
        entry,
        '--experimentalPageIdRouting',
        '--userDataDir',
        this.opts.userDataDir ?? USER_DATA_DIR,
      ];
      if (this.opts.executablePath) {
        args.push('--executablePath', this.opts.executablePath);
      }
      if (this.opts.headless !== false) {
        args.push('--headless=true');
      }
    }

    log('upstream.spawn', {cmd, args});
    this.#proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.#proc.stdout.on('data', (c) => this.#reader.feed(c));
    this.#proc.stderr.on('data', (c) => {
      if (process.env.MCP_MUX_UPSTREAM_STDERR === '1') {
        process.stderr.write('[upstream] ' + c.toString());
      }
    });

    this.#proc.on('exit', (code, signal) => {
      log('upstream.exit', {code, signal});
      this.#ready = false;
      for (const [, cb] of this.#pending) {
        cb({
          jsonrpc: '2.0',
          id: 0,
          error: {code: -32603, message: 'upstream terminated'},
        });
      }
      this.#pending.clear();
      this.emit('exit', code, signal);
    });

    // MCP handshake: initialize
    const initResp = (await this.request({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {name: 'cdmcp-mux', version: '0.1.0'},
      },
    })) as {result?: unknown; error?: unknown};
    if ('error' in initResp && initResp.error) {
      throw new Error(`upstream init failed: ${JSON.stringify(initResp.error)}`);
    }
    // notifications/initialized
    writeMessage(this.#proc.stdin, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    this.#ready = true;
    log('upstream.ready');
  }

  isReady(): boolean {
    return this.#ready;
  }

  request(req: JsonRpcRequest): Promise<JsonRpcMessage> {
    if (!this.#proc) throw new Error('upstream not started');
    return new Promise((resolve) => {
      this.#pending.set(req.id as string | number, resolve);
      writeMessage(this.#proc!.stdin, req);
    });
  }

  nextId(): number {
    return this.#nextId++;
  }

  #onMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg) && msg.id != null) {
      const cb = this.#pending.get(msg.id as string | number);
      if (cb) {
        this.#pending.delete(msg.id as string | number);
        cb(msg);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#proc) return;
    const p = this.#proc;
    this.#proc = null;
    try {
      p.stdin.end();
    } catch {}
    await new Promise<void>((resolve) => {
      const to = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      p.on('exit', () => {
        clearTimeout(to);
        resolve();
      });
    });
  }
}
