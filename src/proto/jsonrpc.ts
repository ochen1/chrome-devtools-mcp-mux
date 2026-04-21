import {Readable, Writable} from 'node:stream';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {code: number; message: string; data?: unknown};
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcSuccess | JsonRpcError {
  return 'id' in m && !('method' in m);
}

export class LineReader {
  #buffer = '';
  #onMessage: (msg: JsonRpcMessage) => void;
  #onError: (err: Error, line: string) => void;

  constructor(
    onMessage: (msg: JsonRpcMessage) => void,
    onError: (err: Error, line: string) => void = () => {},
  ) {
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  feed(chunk: Buffer | string): void {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, idx).trim();
      this.#buffer = this.#buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.#onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (err) {
        this.#onError(err as Error, line);
      }
    }
  }

  attach(stream: Readable): void {
    stream.on('data', (c) => this.feed(c));
  }
}

export function writeMessage(stream: Writable, msg: JsonRpcMessage): boolean {
  return stream.write(JSON.stringify(msg) + '\n');
}
