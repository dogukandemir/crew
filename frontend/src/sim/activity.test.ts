import { describe, expect, it } from 'vitest';
import type { EventRow, OrgNode, Task } from '../api/types';
import { ACTIVITY_ORDER, activityTone, currentTaskFor, deriveActivity } from './activity';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function agent(over: Partial<OrgNode> = {}): OrgNode {
  return { id: 'a1', kind: 'agent', name: 'Ada', role: 'Market Researcher', state: 'busy', ...over };
}

function ev(type: string, secondsAgo: number, over: Partial<EventRow> = {}): EventRow {
  return {
    id: `e-${type}-${secondsAgo}`,
    project_id: 'p1',
    seq: 1,
    ts: new Date(NOW - secondsAgo * 1000).toISOString(),
    type,
    severity: 'info',
    title: `${type} happened`,
    agent_id: 'a1',
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    project_id: 'p1',
    title: 'Market scan',
    state: 'running',
    assignee_agent_id: 'a1',
    ...over,
  };
}

const base = { agent: agent(), events: [] as EventRow[], now: NOW };

describe('activity derivation', () => {
  it('shows an idle agent when there is nothing to do', () => {
    const a = deriveActivity(base);
    expect(a.kind).toBe('idle');
    expect(a.where).toBe('desk');
  });

  it('offlines archived and suspended agents', () => {
    expect(deriveActivity({ ...base, agent: agent({ state: 'archived' }) }).kind).toBe('offline');
    expect(deriveActivity({ ...base, agent: agent({ state: 'suspended' }) }).kind).toBe('offline');
  });

  it('types when the agent holds a running task', () => {
    const a = deriveActivity({ ...base, task: task() });
    expect(a.kind).toBe('typing');
    expect(a.note).toContain('Market scan');
  });

  it('walks to the orchestrator on escalation', () => {
    const a = deriveActivity({ ...base, task: task({ state: 'escalated', escalation_reason: 'needs budget' }) });
    expect(a.kind).toBe('blocked');
    expect(a.where).toBe('orchestrator');
    expect(a.note).toContain('needs budget');
  });

  it('walks to the shared table while verifying', () => {
    const a = deriveActivity({ ...base, task: task({ state: 'verifying' }) });
    expect(a.kind).toBe('walking');
    expect(a.where).toBe('commons');
  });

  it('raises a flag bubble on a pending approval', () => {
    const a = deriveActivity({ ...base, events: [ev('policy.approval.requested', 5)] });
    expect(a.kind).toBe('waiting');
    expect(a.bubble).toBe('⚑');
  });

  it('celebrates a freshly completed task', () => {
    const a = deriveActivity({ ...base, events: [ev('task.completed', 3)] });
    expect(a.kind).toBe('celebrating');
    expect(a.bubble).toBe('✓');
  });

  it('shows a tool call while it is fresh and drops it once stale', () => {
    expect(deriveActivity({ ...base, events: [ev('agent.tool.call', 2)] }).kind).toBe('tool');
    expect(deriveActivity({ ...base, events: [ev('agent.tool.call', 30)] }).kind).toBe('idle');
  });

  it('shows thinking while the thought is fresh', () => {
    expect(deriveActivity({ ...base, events: [ev('agent.thought', 4)] }).kind).toBe('thinking');
    expect(deriveActivity({ ...base, events: [ev('agent.thought', 40)] }).kind).toBe('idle');
  });

  it('prefers the most recent event when several are live', () => {
    const a = deriveActivity({
      ...base,
      events: [ev('agent.tool.call', 40), ev('agent.thought', 1)],
    });
    expect(a.kind).toBe('thinking');
  });

  it('puts problems above activity', () => {
    const a = deriveActivity({
      ...base,
      task: task({ state: 'blocked' }),
      events: [ev('agent.tool.call', 1), ev('task.completed', 1)],
    });
    expect(a.kind).toBe('blocked');
  });

  it('puts a hard failure above an ordinary block', () => {
    const blocked = deriveActivity({ ...base, task: task({ state: 'blocked' }) });
    const failed = deriveActivity({ ...base, task: task({ state: 'failed' }) });
    expect(blocked.bubble).toBe('⏳');
    expect(failed.bubble).toBe('⛔');
  });

  it('announces a just-hired agent walking in', () => {
    const a = deriveActivity({ ...base, arriving: true });
    expect(a.kind).toBe('walking');
    expect(a.bubble).toBe('👋');
  });

  it('ranks every kind in the documented order', () => {
    expect(ACTIVITY_ORDER[0]).toBe('offline');
    expect(ACTIVITY_ORDER.indexOf('blocked')).toBeLessThan(ACTIVITY_ORDER.indexOf('typing'));
    expect(ACTIVITY_ORDER.indexOf('celebrating')).toBeLessThan(ACTIVITY_ORDER.indexOf('thinking'));
    expect(ACTIVITY_ORDER[ACTIVITY_ORDER.length - 1]).toBe('idle');
  });

  it('maps activity to a status tone', () => {
    expect(activityTone('blocked')).toBe('danger');
    expect(activityTone('celebrating')).toBe('ok');
    expect(activityTone('typing')).toBe('busy');
    expect(activityTone('idle')).toBe('idle');
  });
});

describe('current task selection', () => {
  it('returns undefined when nothing is assigned', () => {
    expect(currentTaskFor('a1', [task({ assignee_agent_id: 'a2' })])).toBeUndefined();
  });

  it('prefers the most attention-worthy task of an agent', () => {
    const tasks = [
      task({ id: 't-run', state: 'running' }),
      task({ id: 't-esc', state: 'escalated' }),
      task({ id: 't-ver', state: 'verifying' }),
    ];
    expect(currentTaskFor('a1', tasks)?.id).toBe('t-esc');
    expect(currentTaskFor('a1', [tasks[0], tasks[2]])?.id).toBe('t-ver');
    expect(currentTaskFor('a1', [tasks[0]])?.id).toBe('t-run');
  });
});
