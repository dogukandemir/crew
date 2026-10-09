import { describe, expect, it } from 'vitest';
import {
  COMPANY_TABS,
  PROJECT_TABS,
  WORKSPACE_TAB_LABEL,
  defaultWorkspaceTab,
  workspaceTabsFor,
} from './tabs';

describe('workspace scopes (ADR 0015)', () => {
  it('a company shows HQ, the portfolio, deliverables, memory, events and settings — no office', () => {
    expect(workspaceTabsFor('company')).toEqual([
      'hq',
      'projects',
      'deliverables',
      'brains',
      'events',
      'settings',
    ]);
    expect(workspaceTabsFor('company')).not.toContain('office');
  });

  it('a member project has no HQ — the company is one breadcrumb up', () => {
    expect(workspaceTabsFor('project')).not.toContain('hq');
    expect(workspaceTabsFor('project')).toContain('office');
    expect(defaultWorkspaceTab('company')).toBe('hq');
    expect(defaultWorkspaceTab('project')).toBe('office');
  });

  it('unknown kinds degrade to the project scope', () => {
    expect(workspaceTabsFor(undefined)).toEqual(PROJECT_TABS);
    expect(defaultWorkspaceTab(null)).toBe('office');
  });

  it('every tab id has a label and each scope is a subset of the union', () => {
    for (const t of [...COMPANY_TABS, ...PROJECT_TABS]) {
      expect(WORKSPACE_TAB_LABEL[t]).toBeTruthy();
    }
  });
});
