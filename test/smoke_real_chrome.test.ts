import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Driver, textOf, pageIdsIn} from './harness/driver.js';
import http from 'node:http';

let driver: Driver;
let server: http.Server;
let serverUrl: string;

// A tiny local HTTP server so we don't depend on the network.
async function startLocalServer(): Promise<{
  server: http.Server;
  baseUrl: string;
}> {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? '/';
    res.setHeader('content-type', 'text/html');
    if (url.startsWith('/a')) {
      res.end(
        '<!doctype html><html><head><title>A</title></head><body><h1>A Page</h1><p id="marker">alpha-marker</p></body></html>',
      );
    } else if (url.startsWith('/b')) {
      res.end(
        '<!doctype html><html><head><title>B</title></head><body><h1>B Page</h1><p id="marker">bravo-marker</p></body></html>',
      );
    } else {
      res.end('<!doctype html><html><body>root</body></html>');
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('bad address');
  return {server: srv, baseUrl: `http://127.0.0.1:${addr.port}`};
}

beforeAll(async () => {
  const {server: srv, baseUrl} = await startLocalServer();
  server = srv;
  serverUrl = baseUrl;
  driver = new Driver();
  await driver.start({real: true});
}, 120_000);

afterAll(async () => {
  await driver?.stop();
  server?.close();
}, 60_000);

describe('Real Chromium smoke — end to end isolation', () => {
  it('two shims see isolated tabs, can navigate independently, and clean up', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();

    const aResp = (await a.call('new_page', {url: `${serverUrl}/a`})) as any;
    expect(aResp.error).toBeUndefined();
    const bResp = (await b.call('new_page', {url: `${serverUrl}/b`})) as any;
    expect(bResp.error).toBeUndefined();

    // Each sees exactly one page in its own list_pages output.
    const aList = (await a.call('list_pages', {})) as any;
    const bList = (await b.call('list_pages', {})) as any;
    const aText = textOf(aList.result);
    const bText = textOf(bList.result);
    expect(aText).toContain('/a');
    expect(aText).not.toContain('/b');
    expect(bText).toContain('/b');
    expect(bText).not.toContain('/a');

    // take_snapshot retrieves content for the right page in each ctx.
    const aSnap = (await a.call('take_snapshot', {})) as any;
    expect(aSnap.error).toBeUndefined();
    const aSnapText = textOf(aSnap.result);
    expect(aSnapText.toLowerCase()).toContain('a page');
    expect(aSnapText).not.toContain('bravo-marker');

    const bSnap = (await b.call('take_snapshot', {})) as any;
    expect(bSnap.error).toBeUndefined();
    const bSnapText = textOf(bSnap.result);
    expect(bSnapText.toLowerCase()).toContain('b page');
    expect(bSnapText).not.toContain('alpha-marker');

    // Disconnect A, verify B still works and A's tab is closed.
    a.close();
    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 1500));

    const bListAfter = (await b.call('list_pages', {})) as any;
    const bTextAfter = textOf(bListAfter.result);
    expect(bTextAfter).toContain('/b');

    // Stats: only B's ctx remains.
    const snap = driver.daemon.snapshot() as any;
    expect(snap.contexts).toHaveLength(1);
    expect(snap.upstreamReady).toBe(true);
  }, 60_000);
});
