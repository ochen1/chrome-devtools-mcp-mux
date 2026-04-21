import net from 'node:net';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {SOCKET_PATH, ensureDirs, PID_PATH} from '../paths.js';

const DEBUG = process.env.MCP_MUX_DEBUG === '1';

function dbg(...args: unknown[]): void {
  if (DEBUG) console.error('[mux-shim]', ...args);
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.createConnection(path);
        s.once('connect', () => {
          s.end();
          resolve();
        });
        s.once('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`daemon socket not ready after ${timeoutMs}ms`);
}

function isDaemonAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return fs.existsSync(SOCKET_PATH);
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  ensureDirs();
  if (isDaemonAlive()) {
    dbg('daemon already running');
    return;
  }
  dbg('autospawning daemon');
  const selfUrl = new URL('../bin/cdmcp-mux.js', import.meta.url);
  const entry = selfUrl.pathname;
  const child = spawn(process.execPath, [entry, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  await waitForSocket(SOCKET_PATH, 10_000);
}

export async function runShim(): Promise<void> {
  await ensureDaemon();

  const sock = net.createConnection(SOCKET_PATH);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  dbg('connected to daemon');

  // Dumb byte pipe. No parsing.
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);

  const exit = (code: number): never => {
    try {
      sock.end();
    } catch {}
    process.exit(code);
  };

  sock.on('error', (err) => {
    dbg('socket error', err);
    exit(1);
  });
  sock.on('close', () => {
    dbg('socket closed');
    exit(0);
  });
  process.stdin.on('end', () => {
    dbg('stdin ended');
    try {
      sock.end();
    } catch {}
  });
  process.on('SIGTERM', () => exit(0));
  process.on('SIGINT', () => exit(0));
}
