/**
 * FakeUpstream: a stdio MCP server stub that simulates chrome-devtools-mcp
 * with programmable latency / hang / error / kill behavior and records every
 * tool/call it receives (a "rewrite tape" for correctness assertions).
 *
 * It is launched as a subprocess by the mux's Upstream via
 * `opts.customCmd = process.execPath` and `opts.customArgs = [<this-file>,
 * <controlSocketPath>]`. It speaks newline-delimited JSON-RPC on stdio
 * exactly like chrome-devtools-mcp.
 *
 * A control socket on the side (unix socket, also newline-JSON) is used by
 * tests to configure behavior and drain the call tape.
 */
import net from 'node:net';
import fs from 'node:fs';
import {LineReader, writeMessage} from '../../src/proto/jsonrpc.js';

interface TapeEntry {
  id: string | number | null;
  name: string;
  arguments: Record<string, unknown>;
  ts: number;
}

const args = process.argv.slice(2);
const controlSockPath = args[0];

const tape: TapeEntry[] = [];
const pages = new Map<
  number,
  {pageId: number; url: string; isolatedContext?: string; selected: boolean}
>();
let nextPageId = 0;
let selectedPageId: number | null = null;

interface Behavior {
  latencyMs: Record<string, number>;
  hang: Set<string>;
  error: Record<string, {code: number; message: string}>;
  responseSize: Record<string, number>;
  killOnMethod?: string;
  /** If true, next call instantly terminates the process. */
  killOnce: boolean;
}
const beh: Behavior = {
  latencyMs: {},
  hang: new Set(),
  error: {},
  responseSize: {},
  killOnce: false,
};

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type?: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function tools(): ToolSpec[] {
  // Minimal imitation of chrome-devtools-mcp tools we care about.
  const pageIdProp = {
    pageId: {type: 'number', description: 'Page id'},
  };
  // Tools where `pageId` is added OPTIONAL by --experimentalPageIdRouting.
  // The mux strips these.
  const pageScopedOptional = [
    'navigate_page',
    'click',
    'fill',
    'take_screenshot',
    'take_snapshot',
    'evaluate_script',
  ];
  // Tools where `pageId` is NATIVELY REQUIRED (matches real upstream). The
  // mux must NOT strip these — otherwise the caller has no way to target
  // a tab.
  const pageScopedRequired = ['select_page', 'close_page'];
  const specs: ToolSpec[] = [
    {
      name: 'new_page',
      description: 'Open a new tab',
      inputSchema: {
        type: 'object',
        properties: {
          url: {type: 'string'},
          isolatedContext: {type: 'string'},
        },
        required: ['url'],
      },
    },
    {
      name: 'list_pages',
      description: 'List pages',
      inputSchema: {type: 'object', properties: {}},
    },
    {
      name: 'lighthouse_audit',
      description: 'Global tool with no pageId',
      inputSchema: {
        type: 'object',
        properties: {url: {type: 'string'}},
        required: ['url'],
      },
    },
  ];
  for (const name of pageScopedOptional) {
    specs.push({
      name,
      description: `Page-scoped tool ${name}`,
      inputSchema: {
        type: 'object',
        properties: {...pageIdProp},
      },
    });
  }
  for (const name of pageScopedRequired) {
    specs.push({
      name,
      description: `Page-scoped tool ${name} (native required pageId)`,
      inputSchema: {
        type: 'object',
        properties: {...pageIdProp},
        required: ['pageId'],
      },
    });
  }
  return specs;
}

function pagesListText(): string {
  const lines = ['# Pages'];
  const ids = [...pages.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const p = pages.get(id)!;
    const sel = p.selected ? ' [selected]' : '';
    lines.push(`Page idx ${id}: ${p.url}${sel}`);
  }
  return lines.join('\n');
}

function setSelected(id: number): void {
  for (const p of pages.values()) p.selected = false;
  const p = pages.get(id);
  if (p) {
    p.selected = true;
    selectedPageId = id;
  }
}

async function handleToolCall(
  name: string,
  toolArgs: Record<string, unknown>,
): Promise<{result?: unknown; error?: unknown}> {
  if (beh.error[name]) return {error: beh.error[name]};

  if (name === 'new_page') {
    const id = nextPageId++;
    pages.set(id, {
      pageId: id,
      url: String(toolArgs.url ?? ''),
      isolatedContext:
        typeof toolArgs.isolatedContext === 'string'
          ? (toolArgs.isolatedContext as string)
          : undefined,
      selected: false,
    });
    setSelected(id);
    let text = pagesListText();
    const pad = Number(beh.responseSize[name] ?? 0);
    if (pad > text.length) text += '\n' + 'x'.repeat(pad - text.length - 1);
    return {
      result: {
        content: [{type: 'text', text}],
        isError: false,
      },
    };
  }
  if (name === 'list_pages') {
    let text = pagesListText();
    const pad = Number(beh.responseSize[name] ?? 0);
    if (pad > text.length) text += '\n' + 'x'.repeat(pad - text.length - 1);
    return {result: {content: [{type: 'text', text}], isError: false}};
  }
  if (name === 'close_page') {
    const id = Number(toolArgs.pageId);
    pages.delete(id);
    if (selectedPageId === id) selectedPageId = null;
    return {result: {content: [{type: 'text', text: pagesListText()}]}};
  }
  if (name === 'select_page') {
    const id = Number(toolArgs.pageId);
    if (!pages.has(id)) {
      return {error: {code: -32602, message: `no page ${id}`}};
    }
    setSelected(id);
    return {result: {content: [{type: 'text', text: pagesListText()}]}};
  }
  if (name === 'navigate_page') {
    const id = Number(toolArgs.pageId ?? selectedPageId);
    const p = pages.get(id);
    if (!p) return {error: {code: -32602, message: `no page ${id}`}};
    p.url = String(toolArgs.url ?? p.url);
    return {
      result: {
        content: [{type: 'text', text: pagesListText()}],
      },
    };
  }
  if (name === 'take_screenshot') {
    const id = Number(toolArgs.pageId ?? selectedPageId);
    return {
      result: {
        content: [{type: 'text', text: `screenshot for page ${id}`}],
      },
    };
  }
  if (name === 'take_snapshot' || name === 'evaluate_script' || name === 'click' || name === 'fill') {
    const id = Number(toolArgs.pageId ?? selectedPageId);
    let text = `${name} for page ${id}`;
    const pad = Number(beh.responseSize[name] ?? 0);
    if (pad > text.length) text += ' ' + 'x'.repeat(pad - text.length - 1);
    return {result: {content: [{type: 'text', text}]}};
  }
  if (name === 'lighthouse_audit') {
    return {result: {content: [{type: 'text', text: `audit ${toolArgs.url}`}]}};
  }
  return {error: {code: -32601, message: `unknown tool: ${name}`}};
}

async function respond(id: string | number | null, payload: {result?: unknown; error?: unknown}) {
  const msg =
    'error' in payload && payload.error
      ? {jsonrpc: '2.0' as const, id, error: payload.error as any}
      : {jsonrpc: '2.0' as const, id, result: payload.result};
  writeMessage(process.stdout, msg as any);
}

function dispatchMcp(msg: any): void {
  if (!msg || typeof msg !== 'object') return;
  if (!('method' in msg)) return;
  const method = msg.method as string;
  const id = 'id' in msg ? (msg.id as number | string) : null;

  if (method === 'initialize') {
    respond(id, {
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {tools: {}},
        serverInfo: {name: 'fake-upstream', version: '0.1.0'},
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    respond(id, {result: {tools: tools()}});
    return;
  }
  if (method === 'tools/call') {
    const params = msg.params ?? {};
    const name = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    tape.push({id, name, arguments: toolArgs, ts: Date.now()});

    if (beh.killOnce || (beh.killOnMethod && beh.killOnMethod === name)) {
      setTimeout(() => process.exit(1), 10);
      return;
    }
    if (beh.hang.has(name)) {
      // Never respond.
      return;
    }
    const latency = beh.latencyMs[name] ?? 0;
    const doCall = async () => {
      const res = await handleToolCall(name, toolArgs);
      respond(id, res);
    };
    if (latency > 0) {
      setTimeout(doCall, latency);
    } else {
      // Make it actually async so concurrent responses are testable
      setImmediate(doCall);
    }
    return;
  }

  // Unknown method
  respond(id, {error: {code: -32601, message: `method not found: ${method}`}});
}

const reader = new LineReader((msg) => dispatchMcp(msg));
process.stdin.on('data', (c) => reader.feed(c));
process.stdin.on('end', () => process.exit(0));

// Control socket
if (controlSockPath) {
  try {
    fs.unlinkSync(controlSockPath);
  } catch {}
  const ctrl = net.createServer((sock) => {
    const r = new LineReader((cmd: any) => {
      const resp = handleControl(cmd);
      writeMessage(sock, {jsonrpc: '2.0', id: cmd.id ?? null, result: resp} as any);
    });
    sock.on('data', (c) => r.feed(c));
  });
  ctrl.listen(controlSockPath);
}

function handleControl(cmd: any): unknown {
  switch (cmd.cmd) {
    case 'setLatency':
      beh.latencyMs[cmd.method] = cmd.ms;
      return {ok: true};
    case 'setHang':
      beh.hang.add(cmd.method);
      return {ok: true};
    case 'clearHang':
      beh.hang.delete(cmd.method);
      return {ok: true};
    case 'setError':
      beh.error[cmd.method] = cmd.error;
      return {ok: true};
    case 'clearError':
      delete beh.error[cmd.method];
      return {ok: true};
    case 'setResponseSize':
      beh.responseSize[cmd.method] = cmd.bytes;
      return {ok: true};
    case 'killOnMethod':
      beh.killOnMethod = cmd.method;
      return {ok: true};
    case 'killNow':
      setTimeout(() => process.exit(1), 5);
      return {ok: true};
    case 'drainTape': {
      const out = tape.slice();
      tape.length = 0;
      return {tape: out};
    }
    case 'pageState':
      return {
        pages: [...pages.values()],
        selectedPageId,
      };
    default:
      return {error: 'unknown command'};
  }
}
