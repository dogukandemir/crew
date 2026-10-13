// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Menu } from './Menu';
afterEach(cleanup);
const mount = () => render(<Menu label="Switch project" items={[
  { key: 'a', label: 'Alpha', onSelect: vi.fn() },
  { key: 'b', label: 'Unavailable', disabled: true, onSelect: vi.fn() },
  { key: 'c', label: 'Gamma', onSelect: vi.fn() },
]} />);

it('focuses the first item and arrows skip unavailable items', () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
  const first = screen.getByRole('menuitem', { name: 'Alpha' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'ArrowDown' }); expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Gamma' }));
});
it('Escape returns focus to the trigger', () => {
  mount(); const trigger = screen.getByRole('button', { name: 'Switch project' });
  fireEvent.click(trigger); fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
});
