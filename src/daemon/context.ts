import {randomUUID} from 'node:crypto';

export interface OwnedPage {
  pageId: number;
  url?: string;
}

export type CtxRole = 'mcp' | 'control';

export class MuxContext {
  readonly id: string;
  readonly isolatedContext: string;
  readonly connectedAt = Date.now();
  readonly ownedPages = new Map<number, OwnedPage>();
  selectedPageId: number | null = null;
  shimPid?: number;
  role: CtxRole = 'mcp';

  constructor(idPrefix = 'ctx') {
    this.id = `${idPrefix}-${randomUUID().slice(0, 8)}`;
    this.isolatedContext = this.id;
  }

  addPage(pageId: number, url?: string): void {
    this.ownedPages.set(pageId, {pageId, url});
    if (this.selectedPageId == null) this.selectedPageId = pageId;
  }

  removePage(pageId: number): void {
    this.ownedPages.delete(pageId);
    if (this.selectedPageId === pageId) {
      const next = this.ownedPages.keys().next();
      this.selectedPageId = next.done ? null : next.value;
    }
  }

  owns(pageId: number | undefined): boolean {
    return pageId != null && this.ownedPages.has(pageId);
  }
}
