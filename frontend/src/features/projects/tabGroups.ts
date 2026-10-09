import type { ProjectTab } from '../../stores/tabs';

/**
 * Group tabs so every member sits with its company (ADR 0015): the hierarchy is
 * legible in the strip, not just in the workspace. `groupKeyOf` returns the group a
 * tab belongs to (`c:<companyId>` for a company and its members, `s:<id>` for a
 * solo tab). Within a company group the company's own tab renders first even if a
 * member tab was opened before it; solo groups keep their relative order.
 */
export function groupTabs(tabs: ProjectTab[], groupKeyOf: (projectId: string) => string): ProjectTab[] {
  const groups = new Map<string, ProjectTab[]>();
  const order: string[] = [];
  for (const t of tabs) {
    const key = groupKeyOf(t.projectId);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(t);
  }
  const out: ProjectTab[] = [];
  for (const key of order) {
    const items = groups.get(key)!;
    const parentId = key.startsWith('c:') ? key.slice(2) : null;
    const parent = parentId ? items.find((t) => t.projectId === parentId) : undefined;
    if (parent) out.push(parent, ...items.filter((t) => t !== parent));
    else out.push(...items);
  }
  return out;
}

/** The strip's group key from the project list: a company's own tab and its members
 * share one group; everything else stands alone. */
export function groupKeyMaker(members: Map<string, string | null | undefined>): (projectId: string) => string {
  const companyIds = new Set<string>();
  for (const co of members.values()) {
    if (co) companyIds.add(co);
  }
  return (projectId: string) => {
    if (companyIds.has(projectId)) return `c:${projectId}`;
    const co = members.get(projectId);
    return co ? `c:${co}` : `s:${projectId}`;
  };
}
