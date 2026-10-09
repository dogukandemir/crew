import { describe, expect, it } from 'vitest';
import { groupKeyMaker, groupTabs } from './tabGroups';
import { tabKey, type ProjectTab } from '../../stores/tabs';

function tab(projectId: string): ProjectTab {
  return {
    id: tabKey(projectId),
    projectId,
    viewKey: 'main',
    internalTab: 'office',
    filters: {},
    scroll: 0,
    badge: 0,
  };
}

const ids = (tabs: ProjectTab[]) => tabs.map((t) => t.projectId);

describe('groupTabs', () => {
  it('pulls a company’s members next to each other', () => {
    const members = new Map<string, string | null>([
      ['atlas', 'nw'], // member of nw
      ['solo', null],
      ['nimbus', 'nw'], // member of nw, opened later
    ]);
    const key = groupKeyMaker(members);
    const out = groupTabs([tab('atlas'), tab('solo'), tab('nimbus')], key);
    expect(ids(out)).toEqual(['atlas', 'nimbus', 'solo']);
  });

  it('renders the company tab first even when a member opened before it', () => {
    const members = new Map<string, string | null>([
      ['atlas', 'nw'],
      ['nw', null], // the company itself — groupKeyMaker recognises it via membership
    ]);
    const key = groupKeyMaker(members);
    const out = groupTabs([tab('atlas'), tab('nw')], key);
    expect(ids(out)).toEqual(['nw', 'atlas']);
  });

  it('keeps solo tabs in their original relative order', () => {
    const key = groupKeyMaker(new Map());
    const out = groupTabs([tab('a'), tab('b'), tab('c')], key);
    expect(ids(out)).toEqual(['a', 'b', 'c']);
  });
});

describe('groupKeyMaker', () => {
  it('keys a member under its company and the company under itself', () => {
    const key = groupKeyMaker(new Map([['atlas', 'nw']]));
    expect(key('atlas')).toBe('c:nw');
    expect(key('nw')).toBe('c:nw');
    expect(key('orphan')).toBe('s:orphan');
  });
});
