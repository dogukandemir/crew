// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Hq } from '../../api/types';
import { HqFloor } from './HqFloor';

vi.mock('../../app/animation', () => ({ useCalmMotion: () => false,
  animateFrames: (callback: (now: number, reduced: boolean) => void) => { callback(0, false); return () => {}; } }));
vi.mock('../../app/MotionControl', () => ({ MotionControl: () => <button>Motion</button> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fixture: Hq = {
  company: { id: 'co', name: 'Test company', mission: 'Build', budget_usd: 5, spend_usd: 0, spend_ratio: 0 },
  ceo: { id: 'ceo', name: 'Ada', grade: 5 }, executives: [], board: [], projects: [], activity: [],
};

function mount() {
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() { this.callback([], this as unknown as ResizeObserver); }
    disconnect() {}
  });
  return render(<HqFloor hq={fixture} />);
}

it('preserves camera zoom across a refresh of the same company', () => {
  const view = mount();
  const scene = () => view.container.querySelector('svg > g')?.getAttribute('transform');
  const initial = scene();
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  const zoomed = scene(); expect(zoomed).not.toBe(initial);
  view.rerender(<HqFloor hq={{ ...fixture, activity: [] }} />);
  expect(scene()).toBe(zoomed);
});

it('keyboard camera actions work and buttons cannot start dragging the floor', () => {
  const view = mount();
  const host = screen.getByRole('region');
  const scene = () => view.container.querySelector('svg > g')?.getAttribute('transform');
  const initial = scene();
  fireEvent.keyDown(host, { key: 'ArrowLeft' }); expect(scene()).not.toBe(initial);
  fireEvent.keyDown(host, { key: 'f' }); expect(scene()).toBe(initial);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom in' }), { pointerId: 1 });
  expect(host.style.cursor).toBe('grab');
});
