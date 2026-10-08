import { describe, expect, it } from 'vitest';
import type { Company, Project } from '../../api/types';
import { switchTargets } from './projectSwitch';

const project = (over: Partial<Project>): Project =>
  ({
    id: 'p1',
    name: 'Atlas — customer data platform',
    goal: '',
    status: 'active',
    stage: 'EXECUTING',
    created_at: '2026-09-01T00:00:00Z',
    budget_cap_micros: 0,
    spend_micros: 0,
    ...over,
  }) as Project;

const company = (over: Partial<Company> = {}): Company => ({
  id: 'co1',
  name: 'Northwind Labs',
  mission: '',
  status: 'active',
  budget_usd: 10,
  spend_usd: 3.8,
  spend_ratio: 0.38,
  ceo: { id: 'c1', name: 'Katherine Brooks' },
  roster: [],
  projects: [
    { id: 'p1', name: 'Atlas — customer data platform', status: 'active', spend_ratio: 0.38 },
    { id: 'p2', name: 'Nimbus — mobile app', status: 'active', spend_ratio: 0.84 },
    { id: 'p3', name: 'Forge — design system', status: 'paused', spend_ratio: 0.97 },
  ],
  last_review: null,
  ...over,
});

describe('switchTargets', () => {
  it('offers the company siblings for a member project, with the current one marked', () => {
    const out = switchTargets(project({ company_id: 'co1' }), [company()], undefined);
    expect(out.map((t) => t.id)).toEqual(['p1', 'p2', 'p3']);
    expect(out.filter((t) => t.current).map((t) => t.id)).toEqual(['p1']);
    expect(out[1].status).toBe('active');
  });

  it('offers the members for a company (HQ) tab — none of them is current', () => {
    const out = switchTargets(project({ id: 'co1', kind: 'company', company_id: null }), [company()], undefined);
    expect(out.map((t) => t.id)).toEqual(['p1', 'p2', 'p3']);
    expect(out.some((t) => t.current)).toBe(false);
  });

  it('falls back to every other project for an unattached one, excluding companies', () => {
    const out = switchTargets(
      project({ id: 'px', company_id: null }),
      [],
      [project({ id: 'px' }), project({ id: 'co1', kind: 'company' }), project({ id: 'py', name: 'Solitary' })],
    );
    expect(out.map((t) => t.id)).toEqual(['py']);
    expect(out[0].current).toBe(false);
  });

  it('returns nothing when there is nothing to switch to', () => {
    expect(switchTargets(project({ id: 'px', company_id: null }), [], [project({ id: 'px' })])).toEqual([]);
  });
});
