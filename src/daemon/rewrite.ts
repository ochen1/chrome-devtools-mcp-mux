import {MuxContext} from './context.js';

export interface ToolDesc {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// Parameters we hide from the advertised tool schemas. We still inject pageId
// on every page-scoped call internally; we do NOT inject isolatedContext any
// more — it stays as a user-facing optional knob on new_page (matching vanilla
// chrome-devtools-mcp), so callers who want a fresh incognito-style context
// can opt in by passing it, while the default case shares the user's profile.
const INJECTED_PARAMS = ['pageId'];
const NEW_PAGE_TOOL = 'new_page';
const LIST_PAGES_TOOL = 'list_pages';
const CLOSE_PAGE_TOOL = 'close_page';
const SELECT_PAGE_TOOL = 'select_page';

export function stripToolSchema(tool: ToolDesc): ToolDesc {
  const schema = tool.inputSchema;
  if (!schema || !schema.properties) return tool;
  const props = {...schema.properties};
  const required = schema.required;
  const requiredSet = new Set(required ?? []);
  let changed = false;
  for (const key of INJECTED_PARAMS) {
    // Only strip when the field is *optional*. Required pageId is native to
    // `select_page` / `close_page` (it identifies the target page); if we
    // removed it the caller would have no way to specify which tab to act on
    // — which is what actually happened in practice: an agent saw select_page
    // with only `bringToFront` left, guessed `pageIdx` by analogy with other
    // tools, and the mux rejected the call.
    if (key in props && !requiredSet.has(key)) {
      delete props[key];
      changed = true;
    }
  }
  if (!changed) return tool;
  const out: ToolDesc = {
    ...tool,
    inputSchema: {...schema, properties: props},
  };
  if (required) out.inputSchema!.required = required;
  else if (out.inputSchema) delete out.inputSchema.required;
  return out;
}

export function stripToolList(tools: ToolDesc[]): ToolDesc[] {
  return tools.map(stripToolSchema);
}

export interface ToolSpec {
  name: string;
  acceptsPageId: boolean;
  acceptsIsolatedContext: boolean;
}

export function indexToolSpecs(rawTools: ToolDesc[]): Map<string, ToolSpec> {
  const out = new Map<string, ToolSpec>();
  for (const t of rawTools) {
    const props = t.inputSchema?.properties ?? {};
    out.set(t.name, {
      name: t.name,
      acceptsPageId: 'pageId' in props,
      acceptsIsolatedContext: 'isolatedContext' in props,
    });
  }
  return out;
}

export interface RewriteResult {
  /** Rewritten params to send upstream. */
  params: Record<string, unknown>;
  /** If set, short-circuit with this JSON-RPC error (do not call upstream). */
  shortCircuitError?: {code: number; message: string};
  /** If true, after a successful response, treat as select_page for ctx. */
  markSelectPageId?: number;
}

export function rewriteToolCall(
  toolName: string,
  incoming: Record<string, unknown> | undefined,
  ctx: MuxContext,
  specs: Map<string, ToolSpec>,
): RewriteResult {
  const params: Record<string, unknown> = {...(incoming ?? {})};
  const spec = specs.get(toolName);

  // new_page: pass through. Ownership of the resulting pageId is recorded
  // from the upstream response (see extractNewPageId). The caller's
  // optional `isolatedContext` is preserved verbatim — we don't force
  // isolation, so the user's profile cookies remain available by default,
  // and they can still opt into a fresh context by passing the field.
  if (toolName === NEW_PAGE_TOOL) {
    return {params};
  }

  // close_page: require ownership
  if (toolName === CLOSE_PAGE_TOOL) {
    const requested = (params.pageId ?? ctx.selectedPageId) as number | null;
    if (requested == null) {
      return {
        params,
        shortCircuitError: {code: -32602, message: 'no page selected in this context'},
      };
    }
    if (!ctx.owns(requested)) {
      return {
        params,
        shortCircuitError: {
          code: -32602,
          message: `pageId ${requested} not owned by this context`,
        },
      };
    }
    params.pageId = requested;
    return {params};
  }

  // select_page: track selection per-ctx; forward with pageId so upstream doesn't
  // clobber its global selection for others.
  if (toolName === SELECT_PAGE_TOOL) {
    const requested = params.pageId as number | undefined;
    if (requested == null) {
      return {
        params,
        shortCircuitError: {code: -32602, message: 'pageId required'},
      };
    }
    if (!ctx.owns(requested)) {
      return {
        params,
        shortCircuitError: {
          code: -32602,
          message: `pageId ${requested} not owned by this context`,
        },
      };
    }
    return {params, markSelectPageId: requested};
  }

  // list_pages: no pageId injection, response filtering happens elsewhere.
  if (toolName === LIST_PAGES_TOOL) {
    return {params};
  }

  // Other page-scoped tools: inject pageId from ctx selection if not provided.
  if (spec?.acceptsPageId) {
    const requested = params.pageId as number | undefined;
    if (requested == null) {
      if (ctx.selectedPageId == null) {
        return {
          params,
          shortCircuitError: {
            code: -32602,
            message: 'no page selected in this context',
          },
        };
      }
      params.pageId = ctx.selectedPageId;
    } else if (!ctx.owns(requested)) {
      return {
        params,
        shortCircuitError: {
          code: -32602,
          message: `pageId ${requested} not owned by this context`,
        },
      };
    }
    return {params};
  }

  // Global tool (no pageId concept): pass through.
  return {params};
}

/**
 * Parse a CDMCP list_pages / new_page style content block looking for page lines:
 * "Page idx: <pageId>: <url> [selected]"
 * Returns all pageIds found plus the one marked [selected] if any.
 */
export interface ParsedPages {
  ids: number[];
  byId: Map<number, {url?: string; selected: boolean}>;
}
export function parsePageLines(text: string): ParsedPages {
  const ids: number[] = [];
  const byId = new Map<number, {url?: string; selected: boolean}>();
  // Match each line independently. chrome-devtools-mcp outputs lines like:
  //   "Page idx 0: about:blank [selected]"
  // We also accept a bare "0: <url>" form.
  const lineRe = /^(?:Page\s+(?:idx\s+)?)?(\d+)\s*:\s*(.+?)(?:\s*\[selected\])?\s*$/;
  for (const line of text.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const id = Number(m[1]);
    if (Number.isNaN(id)) continue;
    const selected = /\[selected\]\s*$/.test(line);
    ids.push(id);
    byId.set(id, {url: m[2].trim(), selected});
  }
  return {ids, byId};
}

/**
 * Rewrites a list_pages response to include only the context's owned pages.
 * chrome-devtools-mcp returns content as an array of text blocks. We regenerate
 * the "# Pages" section filtered to owned pageIds.
 */
export function filterListPagesResult(
  result: {content?: Array<{type: string; text?: string}>} | null | undefined,
  ctx: MuxContext,
): unknown {
  if (!result || !Array.isArray(result.content)) return result;
  const newContent = result.content.map((block) => {
    if (block.type !== 'text' || !block.text) return block;
    return {...block, text: filterPagesSection(block.text, ctx)};
  });
  return {...result, content: newContent};
}

export function filterPagesSection(text: string, ctx: MuxContext): string {
  // Split by line. Rewrite any line that matches a "pageId: url" pattern to
  // omit rows not in the ctx ownership set. Preserve non-matching lines.
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)(?:Page\s+(?:idx\s+)?)?(\d+)\s*:\s*/);
    if (m) {
      const id = Number(m[2]);
      if (ctx.owns(id)) out.push(line);
      // else: drop
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Parses the `new_page` response to discover the pageId assigned to the new tab.
 * In chrome-devtools-mcp, after new_page the response lists all pages with the
 * new one selected. We take the [selected] one.
 */
export function extractNewPageId(
  result: {content?: Array<{type: string; text?: string}>} | null | undefined,
): {pageId: number; url?: string} | null {
  if (!result || !Array.isArray(result.content)) return null;
  for (const block of result.content) {
    if (block.type !== 'text' || !block.text) continue;
    const parsed = parsePageLines(block.text);
    for (const [id, info] of parsed.byId) {
      if (info.selected) return {pageId: id, url: info.url};
    }
    // Fallback: last page in the list
    if (parsed.ids.length > 0) {
      const id = parsed.ids[parsed.ids.length - 1];
      return {pageId: id, url: parsed.byId.get(id)?.url};
    }
  }
  return null;
}
