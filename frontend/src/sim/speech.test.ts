import { describe, expect, it } from 'vitest';
import type { EventRow, OrgNode } from '../api/types';
import { deriveActivity, speechKindOf } from './activity';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

const event = (type: string, secondsAgo: number, payload?: unknown): EventRow =>
  ({
    id: `e-${type}-${secondsAgo}`,
    project_id: 'p',
    seq: 1,
    ts: new Date(NOW - secondsAgo * 1000).toISOString(),
    type,
    severity: 'info',
    title: `${type} happened`,
    payload: payload ?? null,
    agent_id: 'a1',
  }) as unknown as EventRow;

const agent: OrgNode = {
  id: 'a1',
  kind: 'agent',
  name: 'Ada',
  role: 'Market Researcher',
  grade: 3,
  state: 'busy',
} as OrgNode;

describe('what kind of thing is being said', () => {
  it('takes an explicit marker over anything it could infer', () => {
    expect(speechKindOf(event('agent.message', 1, { informal: true, direction: 'up' }), true)).toBe(
      'gossip',
    );
  });

  it('reads direction: up is a report, down is a directive', () => {
    expect(speechKindOf(event('agent.message', 1, { direction: 'up' }), true)).toBe('report');
    expect(speechKindOf(event('agent.message', 1, { direction: 'down' }), true)).toBe('directive');
  });

  it('calls an escalation and a hand-off by their event type', () => {
    expect(speechKindOf(event('agent.escalated', 1), true)).toBe('escalation');
    expect(speechKindOf(event('agent.delegated', 1), true)).toBe('delegation');
    // Even when the payload says otherwise — the event type is the truth.
    expect(speechKindOf(event('agent.escalated', 1, { direction: 'up' }), true)).toBe('escalation');
  });

  it('is ordinary talk when the speaker is at work, and gossip when they are not', () => {
    expect(speechKindOf(event('agent.message', 1, { direction: 'out' }), true)).toBe('talk');
    expect(speechKindOf(event('agent.message', 1, { direction: 'out' }), false)).toBe('gossip');
  });

  it('accepts a topic marker as a synonym for informal', () => {
    expect(speechKindOf(event('agent.message', 1, { topic: 'gossip' }), true)).toBe('gossip');
    expect(speechKindOf(event('agent.message', 1, { kind: 'gossip' }), true)).toBe('gossip');
  });

  it('survives a payload of the wrong shape', () => {
    expect(speechKindOf(event('agent.message', 1, 'nonsense'), true)).toBe('talk');
    expect(speechKindOf(event('agent.message', 1), true)).toBe('talk');
  });
});

describe('the words in the bubble', () => {
  it('carries the real message text and who it was for', () => {
    const activity = deriveActivity({
      agent,
      // At work, so this is a work conversation rather than chatter.
      task: { id: 't1', state: 'running' } as never,
      events: [
        event('agent.message', 2, { to: 'Bo', text: 'can you sanity-check my numbers?', direction: 'out' }),
      ],
      now: NOW,
    });
    expect(activity.kind).toBe('talking');
    expect(activity.speech).toEqual({
      kind: 'talk',
      text: 'can you sanity-check my numbers?',
      to: 'Bo',
    });
  });

  it('calls it water-cooler talk when nobody involved is working on anything', () => {
    const activity = deriveActivity({
      agent,
      events: [event('agent.message', 2, { to: 'Bo', text: 'seen the state of the kitchen?', direction: 'out' })],
      now: NOW,
    });
    expect(activity.speech?.kind).toBe('gossip');
  });

  it('shows no bubble at all when there were no words', () => {
    const activity = deriveActivity({
      agent,
      events: [event('agent.message', 2, { to: 'Bo', direction: 'out' })],
      now: NOW,
    });
    expect(activity.kind).toBe('talking');
    expect(activity.speech).toBeUndefined();
  });

  it('stops showing a message once its window has passed', () => {
    const activity = deriveActivity({
      agent,
      events: [event('agent.message', 60, { to: 'Bo', text: 'old news', direction: 'out' })],
      now: NOW,
    });
    expect(activity.speech).toBeUndefined();
  });
});
