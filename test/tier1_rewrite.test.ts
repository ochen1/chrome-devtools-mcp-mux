import {describe, expect, it} from 'vitest';
import {
  stripToolList,
  stripToolSchema,
  indexToolSpecs,
  rewriteToolCall,
  parsePageLines,
  filterPagesSection,
  extractNewPageId,
  ToolDesc,
} from '../src/daemon/rewrite.js';
import {MuxContext} from '../src/daemon/context.js';

const toolsWithInjection: ToolDesc[] = [
  {
    name: 'new_page',
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
    name: 'navigate_page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {type: 'string'},
        pageId: {type: 'number'},
      },
      required: [],
    },
  },
  {
    name: 'close_page',
    inputSchema: {
      type: 'object',
      properties: {pageId: {type: 'number'}},
      required: ['pageId'],
    },
  },
  {
    name: 'select_page',
    inputSchema: {
      type: 'object',
      properties: {pageId: {type: 'number'}},
      required: ['pageId'],
    },
  },
  {
    name: 'lighthouse_audit',
    inputSchema: {
      type: 'object',
      properties: {url: {type: 'string'}},
      required: ['url'],
    },
  },
];

describe('Tier 1 — schema stripping', () => {
  it('strips pageId from page-scoped tool schemas', () => {
    const stripped = stripToolSchema(toolsWithInjection[1]);
    expect(stripped.inputSchema?.properties).toBeDefined();
    expect(stripped.inputSchema!.properties).not.toHaveProperty('pageId');
    expect(stripped.inputSchema!.properties).toHaveProperty('url');
  });

  it('keeps isolatedContext on new_page schema (user-facing opt-in knob)', () => {
    const stripped = stripToolSchema(toolsWithInjection[0]);
    // new_page exposes `isolatedContext` identically to vanilla upstream —
    // the mux no longer force-injects it, so it must remain visible to the
    // caller as an optional parameter.
    expect(stripped.inputSchema!.properties).toHaveProperty('isolatedContext');
    expect(stripped.inputSchema!.properties).toHaveProperty('url');
    expect(stripped.inputSchema!.required).toEqual(['url']);
  });

  it('removes pageId from required list', () => {
    const stripped = stripToolSchema(toolsWithInjection[2]);
    expect(stripped.inputSchema!.required).toEqual([]);
  });

  it('leaves non-affected schemas unchanged', () => {
    const t = toolsWithInjection[4];
    expect(stripToolSchema(t)).toEqual(t);
  });

  it('stripToolList preserves tool count and names', () => {
    const stripped = stripToolList(toolsWithInjection);
    expect(stripped).toHaveLength(toolsWithInjection.length);
    expect(stripped.map((t) => t.name)).toEqual(
      toolsWithInjection.map((t) => t.name),
    );
  });

  it('strips fields even when absent from required', () => {
    const t: ToolDesc = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: {type: 'number'},
          foo: {type: 'string'},
        },
      },
    };
    const s = stripToolSchema(t);
    expect(s.inputSchema!.properties).not.toHaveProperty('pageId');
    expect(s.inputSchema!.properties).toHaveProperty('foo');
  });
});

describe('Tier 1 — tool-call rewrite', () => {
  const specs = indexToolSpecs(toolsWithInjection);

  it('new_page: does NOT inject isolatedContext by default (shares user profile)', () => {
    const ctx = new MuxContext();
    const r = rewriteToolCall(
      'new_page',
      {url: 'https://example.com'},
      ctx,
      specs,
    );
    expect(r.params.url).toBe('https://example.com');
    expect(r.params).not.toHaveProperty('isolatedContext');
  });

  it('new_page: passes through caller-supplied isolatedContext verbatim', () => {
    const ctx = new MuxContext();
    const r = rewriteToolCall(
      'new_page',
      {url: 'u', isolatedContext: 'my-isolated-workspace'},
      ctx,
      specs,
    );
    expect(r.params.isolatedContext).toBe('my-isolated-workspace');
  });

  it('navigate_page: injects selected pageId when missing', () => {
    const ctx = new MuxContext();
    ctx.addPage(7);
    expect(ctx.selectedPageId).toBe(7);
    const r = rewriteToolCall('navigate_page', {url: 'x'}, ctx, specs);
    expect(r.params.pageId).toBe(7);
    expect(r.shortCircuitError).toBeUndefined();
  });

  it('navigate_page: rejects unowned explicit pageId', () => {
    const ctx = new MuxContext();
    ctx.addPage(7);
    const r = rewriteToolCall('navigate_page', {pageId: 99}, ctx, specs);
    expect(r.shortCircuitError).toBeDefined();
    expect(r.shortCircuitError!.message).toMatch(/not owned/);
  });

  it('navigate_page: accepts owned explicit pageId', () => {
    const ctx = new MuxContext();
    ctx.addPage(7);
    ctx.addPage(8);
    const r = rewriteToolCall('navigate_page', {pageId: 8}, ctx, specs);
    expect(r.params.pageId).toBe(8);
    expect(r.shortCircuitError).toBeUndefined();
  });

  it('navigate_page: errors when no page is selected', () => {
    const ctx = new MuxContext();
    const r = rewriteToolCall('navigate_page', {}, ctx, specs);
    expect(r.shortCircuitError).toBeDefined();
    expect(r.shortCircuitError!.message).toMatch(/no page selected/);
  });

  it('close_page: requires ownership', () => {
    const ctx = new MuxContext();
    ctx.addPage(1);
    const r1 = rewriteToolCall('close_page', {pageId: 1}, ctx, specs);
    expect(r1.params.pageId).toBe(1);
    const r2 = rewriteToolCall('close_page', {pageId: 2}, ctx, specs);
    expect(r2.shortCircuitError).toBeDefined();
  });

  it('select_page: requires ownership + marks selection', () => {
    const ctx = new MuxContext();
    ctx.addPage(4);
    const ok = rewriteToolCall('select_page', {pageId: 4}, ctx, specs);
    expect(ok.markSelectPageId).toBe(4);
    const bad = rewriteToolCall('select_page', {pageId: 999}, ctx, specs);
    expect(bad.shortCircuitError).toBeDefined();
  });

  it('list_pages: passes through without injection', () => {
    const ctx = new MuxContext();
    const r = rewriteToolCall('list_pages', {}, ctx, specs);
    expect(r.params).toEqual({});
    expect(r.shortCircuitError).toBeUndefined();
  });

  it('lighthouse_audit (global): no pageId injection', () => {
    const ctx = new MuxContext();
    ctx.addPage(1);
    const r = rewriteToolCall(
      'lighthouse_audit',
      {url: 'https://x'},
      ctx,
      specs,
    );
    expect(r.params).not.toHaveProperty('pageId');
    expect(r.shortCircuitError).toBeUndefined();
  });
});

describe('Tier 1 — ownership table', () => {
  it('addPage auto-selects the first page', () => {
    const ctx = new MuxContext();
    ctx.addPage(10);
    expect(ctx.selectedPageId).toBe(10);
    ctx.addPage(11);
    expect(ctx.selectedPageId).toBe(10); // doesn't bump
  });

  it('removePage falls back to another owned page', () => {
    const ctx = new MuxContext();
    ctx.addPage(10);
    ctx.addPage(11);
    ctx.removePage(10);
    expect(ctx.selectedPageId).toBe(11);
    ctx.removePage(11);
    expect(ctx.selectedPageId).toBeNull();
  });

  it('owns() checks correctly', () => {
    const ctx = new MuxContext();
    expect(ctx.owns(0)).toBe(false);
    ctx.addPage(5);
    expect(ctx.owns(5)).toBe(true);
    expect(ctx.owns(6)).toBe(false);
    expect(ctx.owns(undefined)).toBe(false);
  });

  it('generates distinct context ids', () => {
    const a = new MuxContext();
    const b = new MuxContext();
    expect(a.id).not.toBe(b.id);
    expect(a.isolatedContext).not.toBe(b.isolatedContext);
  });
});

describe('Tier 1 — page-listing parse & filter', () => {
  const sample = `# Pages
Page idx 0: about:blank [selected]
Page idx 1: https://example.com
Page idx 2: https://other.com
`;

  it('parses page lines', () => {
    const parsed = parsePageLines(sample);
    expect(parsed.ids).toEqual([0, 1, 2]);
    expect(parsed.byId.get(0)?.selected).toBe(true);
    expect(parsed.byId.get(1)?.url).toBe('https://example.com');
  });

  it('filters to owned pages only', () => {
    const ctx = new MuxContext();
    ctx.addPage(1);
    const filtered = filterPagesSection(sample, ctx);
    expect(filtered).toContain('Page idx 1: https://example.com');
    expect(filtered).not.toContain('Page idx 0');
    expect(filtered).not.toContain('Page idx 2');
  });

  it('extractNewPageId returns the [selected] page', () => {
    const result = {
      content: [{type: 'text', text: sample}],
    };
    const info = extractNewPageId(result);
    expect(info).toEqual({pageId: 0, url: 'about:blank'});
  });

  it('extractNewPageId falls back to last page if nothing is selected', () => {
    const text = `# Pages
Page idx 3: a
Page idx 7: b
`;
    const info = extractNewPageId({content: [{type: 'text', text}]});
    expect(info?.pageId).toBe(7);
  });
});
