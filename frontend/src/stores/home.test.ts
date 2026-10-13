// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { useTabs } from './tabs';
afterEach(() => { useTabs.setState({ tabs: [], activeTabId: null, homeOpen: false, names: {} }); localStorage.clear(); });

it('Home preserves open projects and their view, and reopening leaves Home', () => {
  const id = useTabs.getState().openTab('project', 'main', 'tasks');
  useTabs.getState().goHome();
  expect(useTabs.getState().homeOpen).toBe(true);
  expect(useTabs.getState().tabs[0].internalTab).toBe('tasks');
  expect(useTabs.getState().openTab('project')).toBe(id);
  expect(useTabs.getState().homeOpen).toBe(false);
  expect(useTabs.getState().tabs).toHaveLength(1);
});

it('events arriving while Home is open still badge the hidden project', () => {
  const id = useTabs.getState().openTab('project');
  useTabs.getState().goHome(); useTabs.getState().bumpBadge('project');
  expect(useTabs.getState().tabs.find(tab => tab.id === id)?.badge).toBe(1);
});
