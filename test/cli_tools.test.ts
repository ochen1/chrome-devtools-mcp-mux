import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Driver} from './harness/driver.js';
import net from 'node:net';
import {LineReader, writeMessage} from '../src/proto/jsonrpc.js';
import fs from 'node:fs';
import path from 'node:path';

let driver: Driver;

beforeEach(async () => {
  driver = new Driver();
  await driver.start();
});
afterEach(async () => {
  await driver.stop();
});

async function sendStatus(socketPath: string): Promise<any> {
  const s = net.createConnection(socketPath);
  await new Promise<void>((r, j) => {
    s.once('connect', () => r());
    s.once('error', j);
  });
  return new Promise((resolve) => {
    const reader = new LineReader((msg: any) => {
      if (msg.id === 'status') {
        s.end();
        resolve(msg.result);
      }
    });
    s.on('data', (c) => reader.feed(c));
    writeMessage(s, {
      jsonrpc: '2.0',
      id: 'status',
      method: 'mux/status',
      params: {},
    } as any);
  });
}

describe('CLI & debugging', () => {
  it('mux/status returns daemon + contexts snapshot', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://x/'});

    const snap = await sendStatus(driver.socketPath);
    expect(snap.pid).toBe(process.pid);
    expect(snap.socket).toBe(driver.socketPath);
    expect(snap.upstreamReady).toBe(true);
    expect(snap.toolCount).toBeGreaterThan(0);
    expect(snap.contexts).toHaveLength(1);
    expect(snap.contexts[0].ownedPages).toHaveLength(1);
    expect(typeof snap.contexts[0].id).toBe('string');
    expect(snap.contexts[0].isolatedContext.startsWith('ctx-')).toBe(true);
  });

  it('status socket is not a normal MCP client (doesn\'t get a new context)', async () => {
    await sendStatus(driver.socketPath); // counts as a context but brief
    // The status request opens and closes quickly — at steady state the ctx
    // count should return to 0.
    for (let i = 0; i < 40; i++) {
      if (driver.daemon.contextCount === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(driver.daemon.contextCount).toBe(0);
  });
});
