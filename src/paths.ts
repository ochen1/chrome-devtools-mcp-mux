import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const runtimeDir =
  process.env.XDG_RUNTIME_DIR ?? path.join(os.tmpdir(), `mux-${process.getuid?.() ?? 0}`);
const stateDir =
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');

export const SOCKET_PATH =
  process.env.CDMCP_MUX_SOCKET ?? path.join(runtimeDir, 'cdmcp-mux.sock');

export const STATE_DIR = path.join(stateDir, 'cdmcp-mux');
export const LOG_PATH = path.join(STATE_DIR, 'mux.log');
export const PID_PATH = path.join(STATE_DIR, 'daemon.pid');
export const USER_DATA_DIR =
  process.env.CDMCP_MUX_USER_DATA_DIR ?? path.join(STATE_DIR, 'chrome-user-data');

export function ensureDirs(): void {
  fs.mkdirSync(path.dirname(SOCKET_PATH), {recursive: true});
  fs.mkdirSync(STATE_DIR, {recursive: true});
  fs.mkdirSync(USER_DATA_DIR, {recursive: true});
}
