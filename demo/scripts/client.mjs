// Minimal MCP client for the demo. Spawns `cdmcp-mux` as a stdio subprocess
// (the same way Claude Code would spawn the shim from a `.mcp.json` entry),
// performs initialize + new_page + list_pages, and prints what THIS client
// sees. Stays connected so two clients can coexist and be compared.
//
// Usage: node client.mjs <label> <path>
//   e.g. node client.mjs A /alpha
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const work = process.env.DEMO_WORK || '/tmp/cdmcp-mux-demo';
const bin = process.env.MUX_BIN;
if (!bin || !fs.existsSync(bin)) {
  console.error('MUX_BIN not set or missing. Run `npm run build` in the repo root, then source env.sh.');
  process.exit(2);
}

const label = process.argv[2] || 'X';
const urlPath = process.argv[3] || '/';
const port = fs.readFileSync(path.join(work, 'port.txt'), 'utf8').trim();
const url = `http://127.0.0.1:${port}${urlPath}`;

const child = spawn(process.execPath, [bin], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: process.env,
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  return new Promise((r) => pending.set(id, r));
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n');
}

function color(s) {
  const c = label === 'A' ? '\x1b[36m' : '\x1b[33m';
  return c + s + '\x1b[0m';
}

async function main() {
  console.log(color(`\n=== CLIENT ${label} ===`));
  console.log(color(`(one MCP client; its own mux shim is pid ${child.pid})`));
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: `demo-${label}`, version: '0.1'},
  });
  notify('notifications/initialized', {});

  console.log(color(`\nopening ${url}`));
  const np = await send('tools/call', {name: 'new_page', arguments: {url}});
  if (np.error) {
    console.log(color('ERROR:'), np.error);
    process.exit(1);
  }

  const lp = await send('tools/call', {name: 'list_pages', arguments: {}});
  const text = lp.result.content.map((c) => c.text || '').join('\n').trim();
  console.log(color(`\nlist_pages as seen by CLIENT ${label}:`));
  console.log(text);
  console.log(color(`\n[CLIENT ${label}] staying connected. Ctrl+C to disconnect.`));
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log(color(`\n[CLIENT ${label}] disconnecting…`));
  child.stdin.end();
  setTimeout(() => process.exit(0), 500);
});
