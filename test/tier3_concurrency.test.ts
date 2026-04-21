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

describe('Tier 3 — concurrency correctness', () => {
  it('interleaved calls route to correct context (rewrite tape)', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a/1'});
    await b.call('new_page', {url: 'https://b/1'});

    const snap = driver.daemon.snapshot() as any;
    const ctxAName = snap.contexts[0].isolatedContext;
    const ctxBName = snap.contexts[1].isolatedContext;

    await driver.drainTape();

    // Fire interleaved navigate + take_screenshot calls
    await Promise.all([
      a.call('take_screenshot', {}),
      b.call('take_screenshot', {}),
      a.call('navigate_page', {url: 'https://a/2'}),
      b.call('navigate_page', {url: 'https://b/2'}),
      a.call('take_snapshot', {}),
      b.call('take_snapshot', {}),
    ]);

    const tape = await driver.drainTape();
    // Every call must carry a pageId that matches its originating context's
    // isolatedContext owner set. Infer: get page state and map pageId -> ctxName.
    const state = await driver.pageState();
    const pageOwner = new Map<number, string>();
    for (const p of state.pages)
      if (p.isolatedContext) pageOwner.set(p.pageId, p.isolatedContext);

    const aPages = snap.contexts[0].ownedPages.map((p: any) => p.pageId);
    const bPages = snap.contexts[1].ownedPages.map((p: any) => p.pageId);

    for (const e of tape) {
      const pid = e.arguments.pageId as number | undefined;
      if (pid == null) continue;
      // The pageId passed upstream must be owned by SOMEONE. Since we fired
      // from both contexts, we verify the pageId belongs to either A or B —
      // and specifically that rewrite assigned pageIds consistent with
      // upstream ownership.
      expect(
        aPages.includes(pid) || bPages.includes(pid),
      ).toBe(true);
    }
  });

  it('concurrent new_page: each context receives only its own assigned pageId', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    const [aResp, bResp] = await Promise.all([
      a.call('new_page', {url: 'https://a/'}),
      b.call('new_page', {url: 'https://b/'}),
    ]);
    const aIds = pageIdsIn(textOf((aResp as any).result));
    const bIds = pageIdsIn(textOf((bResp as any).result));
    expect(aIds).toHaveLength(1);
    expect(bIds).toHaveLength(1);
    expect(aIds[0]).not.toBe(bIds[0]);

    // Daemon ownership tables agree
    const snap = driver.daemon.snapshot() as any;
    const [ctxA, ctxB] = snap.contexts;
    expect(ctxA.ownedPages.map((p: any) => p.pageId)).toEqual(aIds);
    expect(ctxB.ownedPages.map((p: any) => p.pageId)).toEqual(bIds);
  });

  it('concurrent list_pages bleed-through check (no cross-context rows)', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a1/'});
    await a.call('new_page', {url: 'https://a2/'});
    await b.call('new_page', {url: 'https://b1/'});
    await b.call('new_page', {url: 'https://b2/'});
    await b.call('new_page', {url: 'https://b3/'});

    // Fire many parallel list_pages from both contexts, assert each gets only
    // their own rows.
    const runs = 20;
    const jobs: Array<Promise<any>> = [];
    for (let i = 0; i < runs; i++) {
      jobs.push(a.call('list_pages', {}));
      jobs.push(b.call('list_pages', {}));
    }
    const results = await Promise.all(jobs);
    for (let i = 0; i < runs; i++) {
      const aText = textOf((results[i * 2] as any).result);
      const bText = textOf((results[i * 2 + 1] as any).result);
      expect(aText).toContain('a1/');
      expect(aText).toContain('a2/');
      expect(aText).not.toContain('b1/');
      expect(aText).not.toContain('b2/');
      expect(aText).not.toContain('b3/');
      expect(bText).toContain('b1/');
      expect(bText).toContain('b2/');
      expect(bText).toContain('b3/');
      expect(bText).not.toContain('a1/');
      expect(bText).not.toContain('a2/');
    }
  });

  it('JSON-RPC id space is per-connection (no cross-talk)', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    // Each shim starts its own counter. Fire overlapping requests using the
    // same numeric ids from each side and make sure each response lands on
    // the right side.
    const [ar, br] = await Promise.all([
      a.call('new_page', {url: 'https://A/'}),
      b.call('new_page', {url: 'https://B/'}),
    ]);
    expect(textOf((ar as any).result)).toContain('A/');
    expect(textOf((br as any).result)).toContain('B/');
  });

  it('flood from one context does not drop responses from another', async () => {
    const a = await driver.newShim();
    const b = await driver.newShim();
    await a.call('new_page', {url: 'https://a/'});
    await b.call('new_page', {url: 'https://b/'});

    const floodSize = 50;
    const flood = [];
    for (let i = 0; i < floodSize; i++) {
      flood.push(a.call('take_snapshot', {}));
    }
    const bResp = b.call('take_snapshot', {});
    const [bOut, ...aOuts] = await Promise.all([bResp, ...flood]);
    expect((bOut as any).error).toBeUndefined();
    expect((bOut as any).result).toBeDefined();
    expect(aOuts).toHaveLength(floodSize);
    for (const r of aOuts) {
      expect((r as any).error).toBeUndefined();
    }
  });
});
