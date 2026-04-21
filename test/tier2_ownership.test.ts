import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {Driver, ShimClient, textOf, pageIdsIn} from './harness/driver.js';

let driver: Driver;

beforeEach(async () => {
  driver = new Driver();
  await driver.start();
});

afterEach(async () => {
  await driver.stop();
});

async function newPage(shim: ShimClient, url: string) {
  const resp = (await shim.call('new_page', {url})) as any;
  if (resp.error) throw new Error(JSON.stringify(resp.error));
  return resp.result;
}

async function listPages(shim: ShimClient): Promise<number[]> {
  const r = (await shim.call('list_pages', {})) as any;
  return pageIdsIn(textOf(r.result));
}

describe('Tier 2 — ownership & isolation', () => {
  it('tools/list strips pageId and isolatedContext', async () => {
    const shim = await driver.newShim();
    const resp = (await shim.request('tools/list', {})) as any;
    const tools = resp.result.tools as Array<any>;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      if (t.inputSchema?.properties) {
        expect(t.inputSchema.properties).not.toHaveProperty('pageId');
        expect(t.inputSchema.properties).not.toHaveProperty('isolatedContext');
      }
    }
    shim.close();
  });

  it('new_page in ctx A is not visible to ctx B via list_pages', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await newPage(a, 'https://a.test/');
    await newPage(b, 'https://b.test/');

    const idsA = await listPages(a);
    const idsB = await listPages(b);
    expect(idsA.length).toBe(1);
    expect(idsB.length).toBe(1);
    // Each ctx sees one tab; never the other's id
    expect(idsA).not.toEqual(idsB);

    const state = await driver.pageState();
    expect(state.pages.length).toBe(2);
  });

  it('isolatedContext is always injected on new_page upstream', async () => {
    const a = await driver.newShim();
    await newPage(a, 'https://foo/');
    const tape = await driver.drainTape();
    const np = tape.find((e) => e.name === 'new_page');
    expect(np).toBeDefined();
    expect(typeof np!.arguments.isolatedContext).toBe('string');
    expect((np!.arguments.isolatedContext as string).startsWith('ctx-')).toBe(
      true,
    );
  });

  it('caller-supplied isolatedContext is overridden', async () => {
    const a = await driver.newShim();
    await a.call('new_page', {
      url: 'https://foo/',
      isolatedContext: 'attacker-foo',
    });
    const tape = await driver.drainTape();
    const np = tape.find((e) => e.name === 'new_page');
    expect(np!.arguments.isolatedContext).not.toBe('attacker-foo');
    expect((np!.arguments.isolatedContext as string).startsWith('ctx-')).toBe(
      true,
    );
  });

  it('page-scoped tool call without pageId injects ctx-selected pageId', async () => {
    const a = await driver.newShim();
    await newPage(a, 'https://foo/');
    await a.call('navigate_page', {url: 'https://foo/next'});
    const tape = await driver.drainTape();
    const navCalls = tape.filter((e) => e.name === 'navigate_page');
    expect(navCalls).toHaveLength(1);
    expect(typeof navCalls[0].arguments.pageId).toBe('number');
  });

  it('close_page on unowned pageId is rejected before upstream', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await newPage(a, 'https://a/');
    await newPage(b, 'https://b/');
    await driver.drainTape(); // clear

    const snap = driver.daemon.snapshot() as any;
    const [ctxA, ctxB] = snap.contexts;
    const bPageId = ctxB.ownedPages[0].pageId;
    expect(ctxA.ownedPages.map((p: any) => p.pageId)).not.toContain(bPageId);

    const resp = (await a.call('close_page', {pageId: bPageId})) as any;
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/not owned/);
    const tape = await driver.drainTape();
    expect(tape.find((e) => e.name === 'close_page')).toBeUndefined();
  });

  it('page-scoped tool with explicit unowned pageId is rejected', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await newPage(a, 'https://a/');
    await newPage(b, 'https://b/');
    await driver.drainTape();
    const snap = driver.daemon.snapshot() as any;
    const ctxA = snap.contexts[0];
    const ctxB = snap.contexts[1];
    const bPageId = ctxB.ownedPages[0].pageId;
    const resp = (await a.call('navigate_page', {
      pageId: bPageId,
      url: 'https://x/',
    })) as any;
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/not owned/);
    const tape = await driver.drainTape();
    expect(tape.find((e) => e.name === 'navigate_page')).toBeUndefined();
  });

  it('per-context selected page does not affect other contexts', async () => {
    const a = await driver.newShim();
    await newPage(a, 'https://a1/');
    await newPage(a, 'https://a2/');
    // a now owns two pages, selected = first (0)
    const snap = driver.daemon.snapshot() as any;
    const aCtx = snap.contexts[0];
    expect(aCtx.ownedPages).toHaveLength(2);
    const second = aCtx.ownedPages[1].pageId;
    const resp = (await a.call('select_page', {pageId: second})) as any;
    expect(resp.error).toBeUndefined();
    const snap2 = driver.daemon.snapshot() as any;
    expect(snap2.contexts[0].selectedPageId).toBe(second);
  });

  it('list_pages filter removes other-context rows', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await newPage(a, 'https://a/');
    await newPage(b, 'https://b/');
    const aResp = (await a.call('list_pages', {})) as any;
    const text = textOf(aResp.result);
    expect(text).toContain('a/');
    expect(text).not.toContain('b/');
  });

  it('global tool (lighthouse_audit) passes through unchanged', async () => {
    const a = await driver.newShim();
    await newPage(a, 'https://foo/');
    await driver.drainTape();
    const resp = (await a.call('lighthouse_audit', {
      url: 'https://foo/',
    })) as any;
    expect(resp.error).toBeUndefined();
    const tape = await driver.drainTape();
    const la = tape.find((e) => e.name === 'lighthouse_audit');
    expect(la).toBeDefined();
    expect(la!.arguments).not.toHaveProperty('pageId');
    expect(la!.arguments).not.toHaveProperty('isolatedContext');
  });

  it('page-scoped tool with no page selected returns clean error', async () => {
    const a = await driver.newShim();
    const resp = (await a.call('take_screenshot', {})) as any;
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/no page selected/);
  });
});
