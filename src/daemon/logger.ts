import fs from 'node:fs';
import {LOG_PATH, ensureDirs} from '../paths.js';

let stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (stream) return stream;
  ensureDirs();
  stream = fs.createWriteStream(LOG_PATH, {flags: 'a'});
  return stream;
}

export function log(event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ts: Date.now(), event, ...data}) + '\n';
  try {
    ensureStream().write(line);
  } catch {}
  if (process.env.MCP_MUX_LOG_STDERR === '1') {
    process.stderr.write('[mux] ' + line);
  }
}
