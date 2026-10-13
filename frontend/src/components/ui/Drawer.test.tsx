// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Drawer, Modal } from './Drawer';

afterEach(cleanup);

it('names the dialog, contains keyboard focus and restores its opener', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  const view = render(<Modal open title="Approval" onClose={close}><button>Approve</button></Modal>);
  expect(screen.getByRole('dialog', { name: 'Approval' })).toBeTruthy();
  expect(opener.hasAttribute('inert')).toBe(true);
  const first = screen.getByRole('button', { name: 'Close dialog' });
  const last = screen.getByRole('button', { name: 'Approve' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(opener);
  expect(opener.hasAttribute('inert')).toBe(false);
  opener.remove();
});

it('Escape closes only the topmost dialog', () => {
  const closeDrawer = vi.fn(), closeModal = vi.fn();
  render(<><Drawer open title="Agent" onClose={closeDrawer}>Profile</Drawer>
    <Modal open title="Confirm" onClose={closeModal}>Confirmation</Modal></>);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(closeModal).toHaveBeenCalledOnce();
  expect(closeDrawer).not.toHaveBeenCalled();
});
