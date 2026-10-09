import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  agentsFromOrg,
  insertMention,
  mentionContext,
  modeOf,
  type RosterAgent,
} from './commandsModel';
import type { OrgTree } from '../../api/types';

const ROSTER: RosterAgent[] = [
  { id: 'a1', name: 'Ada Lovelace', role: 'analyst' },
  { id: 'a2', name: 'Bo Chen', role: 'engineer' },
  { id: 'a3', name: 'Zoe', role: 'producer' },
];

describe('agentsFromOrg', () => {
  it('collects agents from the whole tree', () => {
    const tree = {
      root: {
        id: 'p1', kind: 'project', name: 'p',
        children: [
          {
            id: 'd1', kind: 'department', name: 'Research',
            children: [
              { id: 'a1', kind: 'agent', name: 'Ada', role: 'analyst' },
              { id: 's1', kind: 'squad', name: 'Squad', children: [{ id: 'a2', kind: 'agent', name: 'Bo' }] },
            ],
          },
        ],
      },
    } as unknown as OrgTree;
    expect(agentsFromOrg(tree).map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('is empty for a missing tree', () => {
    expect(agentsFromOrg(undefined)).toEqual([]);
  });
});

describe('mentionContext', () => {
  it('opens on @ and matches by prefix or word', () => {
    const ctx = mentionContext('hey @ad', 7, ROSTER);
    expect(ctx).not.toBeNull();
    expect(ctx!.fragment).toBe('ad');
    expect(ctx!.matches.map((a) => a.id)).toEqual(['a1']);
  });

  it('closes once the fragment has a space', () => {
    expect(mentionContext('hey @ada ', 9, ROSTER)).toBeNull();
    expect(mentionContext('no mention here', 5, ROSTER)).toBeNull();
  });

  it('with an empty fragment lists the roster', () => {
    const ctx = mentionContext('@', 1, ROSTER);
    expect(ctx!.matches).toHaveLength(3);
  });
});

describe('insertMention', () => {
  it('replaces the typed fragment with the first name and a space', () => {
    const text = 'hey @ad can you';
    const ctx = mentionContext(text, 7, ROSTER)!;
    const out = insertMention(text, ctx, ROSTER[0]);
    expect(out.text).toBe('hey @Ada  can you');
    expect(out.caret).toBe('hey @Ada '.length);
  });
});

describe('modeOf', () => {
  it('reads a question mark as a question', () => {
    expect(modeOf('status?')).toBe('question');
  });
  it('reads idea words as an idea, even with a question mark', () => {
    expect(modeOf('I have an idea: maybe we run the report next week?')).toBe('idea');
  });
  it('an imperative sentence is an order', () => {
    expect(modeOf('@Ada, prepare the report')).toBe('order');
  });
});

describe('actionLabel', () => {
  it('speaks human for known kinds and passes unknowns through', () => {
    expect(actionLabel('task.created')).toBe('task created');
    expect(actionLabel('something.new')).toBe('something.new');
  });
});
