import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Driver, ShimClient} from './harness/driver.js';

let driver: Driver;

beforeEach(async () => {
  driver = new Driver();
  await driver.start();
});
afterEach(async () => {
  await driver.stop();
});

async function waitFor<T>(
  check: () => T | undefined | false,
  timeoutMs = 3000,
  stepMs = 50,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = check();
    if (r) return r as T;
    await new Promise((r2) => setTimeout(r2, stepMs));
  }
  throw new Error('waitFor timed out');
}

describe('Tier 5 — cleanup correctness', () => {
  it('shim disconnect closes all of its owned pages in upstream', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a1/'});
    await a.call('new_page', {url: 'https://a2/'});
    await a.call('new_page', {url: 'https://a3/'});
    const beforeState = await driver.pageState();
    expect(beforeState.pages).toHaveLength(3);

    a.close();
    await waitFor(() => driver.daemon.contextCount === 0, 5000);

    // All pages owned by the closed ctx should be closed in upstream.
    const after = await driver.pageState();
    expect(after.pages).toHaveLength(0);
  });

  it('killing shim A leaves context B entirely intact', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    await b.call('new_page', {url: 'https://b/'});
    expect((await driver.pageState()).pages).toHaveLength(2);

    a.close();
    await waitFor(() => driver.daemon.contextCount === 1, 5000);

    const state = await driver.pageState();
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0].url).toBe('https://b/');

    // Ctx B is still operational
    const resp = (await b.call('take_snapshot', {})) as any;
    expect(resp.error).toBeUndefined();
  });

  it('socket destroy (simulating SIGKILL on shim) triggers cleanup', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    expect(driver.daemon.contextCount).toBe(1);

    // Force-destroy the underlying socket (no graceful end)
    (a as any).close();
    await waitFor(() => driver.daemon.contextCount === 0, 5000);

    expect(driver.daemon.contextCount).toBe(0);
    const state = await driver.pageState();
    expect(state.pages).toHaveLength(0);
  });

  it('daemon.stop() gracefully shuts down: closes sockets, unlinks files', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    const socketPath = driver.socketPath;

    // Set up a close listener on the shim BEFORE stopping.
    const closedPromise = new Promise<void>((resolve) => a.onClose(resolve));

    await driver.daemon.stop();
    await closedPromise;

    const fs = await import('node:fs');
    expect(fs.existsSync(socketPath)).toBe(false);

    // Re-create driver so afterEach's stop doesn't double-stop.
    driver = new Driver();
    await driver.start();
  });

  it('independent cleanup order: B disconnects first, then A', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a1/'});
    await a.call('new_page', {url: 'https://a2/'});
    await b.call('new_page', {url: 'https://b1/'});
    expect((await driver.pageState()).pages).toHaveLength(3);

    b.close();
    await waitFor(() => driver.daemon.contextCount === 1, 5000);
    expect((await driver.pageState()).pages).toHaveLength(2);

    a.close();
    await waitFor(() => driver.daemon.contextCount === 0, 5000);
    expect((await driver.pageState()).pages).toHaveLength(0);
  });

  it('reconnect after disconnect gets a fresh context (no page carryover)', async () => {
    const a1 = await driver.newShim();
    await a1.call('new_page', {url: 'https://first/'});
    a1.close();
    await waitFor(() => driver.daemon.contextCount === 0, 5000);
    expect((await driver.pageState()).pages).toHaveLength(0);

    const a2 = await driver.newShim();
    // list_pages for the new ctx must be empty
    const resp = (await a2.call('list_pages', {})) as any;
    expect(resp.error).toBeUndefined();
    const text = resp.result.content.map((c: any) => c.text ?? '').join('\n');
    expect(text).not.toContain('first/');
  });

  it('rapid connect/disconnect churn does not leak contexts', async () => {
    for (let i = 0; i < 10; i++) {
      const s = await driver.newShim();
      await s.call('new_page', {url: `https://loop/${i}`});
      s.close();
      await waitFor(() => driver.daemon.contextCount === 0, 5000);
    }
    expect(driver.daemon.contextCount).toBe(0);
    expect((await driver.pageState()).pages).toHaveLength(0);
  });
});
