import net from 'node:net';
import {SOCKET_PATH} from '../paths.js';
import {LineReader, writeMessage} from '../proto/jsonrpc.js';

export async function runStatus(): Promise<void> {
  const sock = net.createConnection(SOCKET_PATH);
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  const reader = new LineReader((msg) => {
    if ('id' in msg && 'result' in msg) {
      console.log(JSON.stringify(msg.result, null, 2));
      sock.end();
      process.exit(0);
    }
  });
  sock.on('data', (c) => reader.feed(c));
  sock.on('close', () => process.exit(0));
  writeMessage(sock, {
    jsonrpc: '2.0',
    id: 1,
    method: 'mux/status',
    params: {},
  });
}
