import { describe, expect, it } from 'vitest';
import type { EventRow } from '../api/types';
import { liveCouncil } from './meeting';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ev = (type: string, secAgo: number, agent_id: string | null, payload?: unknown): EventRow =>
  ({
    id: `${type}-${secAgo}-${agent_id}`,
    project_id: 'p1',
    seq: 1,
    ts: new Date(NOW - secAgo * 1000).toISOString(),
    type,
    severity: 'info',
    title: type,
    agent_id,
    payload,
  }) as EventRow;

const convened = (secAgo = 6) =>
  ev('council.convened', secAgo, 'a0', { session_id: 'c1', question: 'ship or fold?' });
const position = (agent: string, secAgo: number) =>
  ev('council.position', secAgo, agent, { session_id: 'c1', agent_id: agent, round: 1, option_id: 'o1', claim: 'x', confidence: 0.5, risks: [] });

describe('liveCouncil, the sitting the floor draws', () => {
  it('is nothing when no council was ever convened', () => {
    expect(liveCouncil([ev('agent.thought', 2, 'a1')], NOW)).toBeNull();
  });

  it('opens with the convened event and collects the panel from positions, convenor included', () => {
    const c = liveCouncil([convened(), position('a1', 4), position('a2', 3), position('a4', 2)], NOW);
    expect(c).not.toBeNull();
    expect(c!.id).toBe('c1');
    expect(c!.question).toBe('ship or fold?');
    expect(c!.members).toEqual(['a0', 'a1', 'a2', 'a4']);
  });

  it('closes once a decision was recorded after it opened', () => {
    const decided = ev('decision.recorded', 1, 'a0', { decision_id: 'dc1', chosen_option: 'o2' });
    expect(liveCouncil([convened(30), position('a1', 29), decided], NOW)).toBeNull();
  });

  it('closes when the sitting has gone silent past the window', () => {
    expect(liveCouncil([convened(400), position('a1', 399)], NOW)).toBeNull();
  });

  it('ignores positions that belong to another sitting', () => {
    const other = ev('council.position', 3, 'a9', { session_id: 'c-other', agent_id: 'a9' });
    const c = liveCouncil([convened(), position('a1', 4), other], NOW);
    expect(c!.members).toEqual(['a0', 'a1']);
  });

  it('a convenor alone is still a sitting: the room appears the moment one is called', () => {
    const c = liveCouncil([convened()], NOW);
    expect(c).not.toBeNull();
    expect(c!.members).toEqual(['a0']);
  });
});
