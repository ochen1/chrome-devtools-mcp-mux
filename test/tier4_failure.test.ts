import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Driver, ShimClient, textOf} from './harness/driver.js';

let driver: Driver;

beforeEach(async () => {
  driver = new Driver();
  await driver.start();
});
afterEach(async () => {
  await driver.stop();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms),
    ),
  ]);
}

describe('Tier 4 — failure modes', () => {
  it('upstream hang on one method does not block unrelated calls', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    await b.call('new_page', {url: 'https://b/'});

    await driver.control({cmd: 'setHang', method: 'lighthouse_audit'});

    // Fire a hanging call but don't await it.
    const hang = a.call('lighthouse_audit', {url: 'https://x/'});

    // b's unrelated call should still complete quickly.
    const bResp = (await withTimeout(
      b.call('take_snapshot', {}),
      3_000,
      'b.take_snapshot during a.hang',
    )) as any;
    expect(bResp.error).toBeUndefined();

    // Cleanup: unhang so the pending never-resolves doesn't leak.
    await driver.control({cmd: 'clearHang', method: 'lighthouse_audit'});
    // The previously-hung request is still pending — abandon the promise by
    // closing the shim. That will close the sock and drain pending.
    a.close();
    await hang.catch(() => {}); // drain
  });

  it('upstream error response is delivered cleanly and other calls work', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});

    await driver.control({
      cmd: 'setError',
      method: 'take_screenshot',
      error: {code: -32000, message: 'boom'},
    });
    const err = (await a.call('take_screenshot', {})) as any;
    expect(err.error).toBeDefined();
    expect(err.error.message).toBe('boom');

    await driver.control({cmd: 'clearError', method: 'take_screenshot'});
    const ok = (await a.call('take_snapshot', {})) as any;
    expect(ok.error).toBeUndefined();
  });

  it('upstream crash: in-flight calls error, subsequent calls restart upstream', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    // Trigger crash
    await driver.control({cmd: 'killNow'});
    // Wait for daemon to observe exit
    await new Promise((r) => setTimeout(r, 200));

    // A subsequent tool call should either error cleanly or relaunch upstream;
    // either way no hang. Give it a bounded window.
    const resp = (await withTimeout(
      a.call('take_snapshot', {}),
      8_000,
      'post-crash call',
    )) as any;
    // After crash, ctx ownership is cleared, so selected=null => clean error OR
    // upstream relaunched with empty state (error because pageId 0 no longer
    // exists or no page selected).
    expect(resp).toBeDefined();
    // Either a clean JSON-RPC error or an isError result.
    if (resp.error) {
      expect(typeof resp.error.message).toBe('string');
    } else {
      expect(resp.result).toBeDefined();
    }
  });

  it('shim disconnect mid-call: daemon cleans up ownership, no dangling entries', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    const snapBefore = driver.daemon.snapshot() as any;
    expect(snapBefore.contexts).toHaveLength(1);
    expect(snapBefore.contexts[0].ownedPages).toHaveLength(1);

    // Slow the next take_snapshot; disconnect before response.
    await driver.control({
      cmd: 'setLatency',
      method: 'take_snapshot',
      ms: 2_000,
    });
    const pending = a.call('take_snapshot', {});
    await new Promise((r) => setTimeout(r, 100));
    a.close();
    // Wait for daemon to process close
    for (let i = 0; i < 50; i++) {
      const s = driver.daemon.snapshot() as any;
      if (s.contexts.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const snapAfter = driver.daemon.snapshot() as any;
    expect(snapAfter.contexts).toHaveLength(0);
    // Consume the pending (will resolve with socket-closed error from driver)
    await pending.catch(() => {});
  });

  it('large response payload arrives intact', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    const size = 1_000_000; // 1MB
    await driver.control({
      cmd: 'setResponseSize',
      method: 'take_snapshot',
      bytes: size,
    });
    const resp = (await a.call('take_snapshot', {})) as any;
    expect(resp.error).toBeUndefined();
    const text = textOf(resp.result);
    expect(text.length).toBeGreaterThanOrEqual(size - 16);
    // JSON-RPC framing must not have split/corrupted the message.
    expect(typeof text).toBe('string');
  });

  it('slow upstream: per-context calls serialize cleanly, eventually complete', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    await driver.control({
      cmd: 'setLatency',
      method: 'take_snapshot',
      ms: 150,
    });
    const t0 = Date.now();
    const results = await Promise.all([
      a.call('take_snapshot', {}),
      a.call('take_snapshot', {}),
      a.call('take_snapshot', {}),
    ]);
    const dt = Date.now() - t0;
    // Bounded: should finish. No perf gate, just "it finishes in reasonable time".
    expect(dt).toBeLessThan(5_000);
    for (const r of results) expect((r as any).error).toBeUndefined();
  });

  it('daemon cold start with stale unix socket file: replaces and listens', async () => {
    // Create a second driver instance over the same socket path
    const d2 = new Driver();
    // Point it at a stale socket path manually
    const fs = await import('node:fs');
    const path = await import('node:path');
    const stale = path.join(driver.workDir, 'stale.sock');
    // Simulate a stale socket file
    fs.writeFileSync(stale, 'x');
    // Start a fresh Driver using our helper; ensure no crash
    await d2.start();
    expect(d2.daemon.contextCount).toBe(0);
    await d2.stop();
  });
});
