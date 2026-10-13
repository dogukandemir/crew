// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function clock(hidden = false, reduced = false) {
  vi.resetModules();
  const queued = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { queued.set(++id, callback); return id; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((key: number) => queued.delete(key)));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const module = await import('./animation');
  return { ...module, queued, advance(now: number) {
    const entries = [...queued.values()]; queued.clear(); entries.forEach(callback => callback(now));
  } };
}

it('shares one frame loop and releases it when the final scene unmounts', async () => {
  const controller = await clock();
  const first = vi.fn(); const second = vi.fn();
  const removeFirst = controller.animateFrames(first); const removeSecond = controller.animateFrames(second);
  expect(controller.queued.size).toBe(1);
  controller.advance(1000);
  expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
  removeFirst(); expect(controller.queued.size).toBe(1);
  removeSecond(); expect(controller.queued.size).toBe(0);
});

it('paints an initial state while hidden but does not run background frames', async () => {
  const controller = await clock(true); const callback = vi.fn();
  const remove = controller.animateFrames(callback);
  expect(callback).toHaveBeenCalledOnce(); expect(controller.queued.size).toBe(0);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(controller.queued.size).toBe(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(controller.queued.size).toBe(0); remove();
});

it('updates calm motion immediately without stopping the state clock', async () => {
  const controller = await clock(); const callback = vi.fn(); const remove = controller.animateFrames(callback);
  controller.setCalmMotion(true);
  expect(callback.mock.lastCall?.[1]).toBe(true);
  expect(localStorage.getItem('crew-calm-motion')).toBe('true');
  expect(controller.queued.size).toBe(1); remove();
});

it('honors the system default and animates only after an explicit choice', async () => {
  const controller = await clock(false, true); const callback = vi.fn(); const remove = controller.animateFrames(callback);
  expect(callback.mock.lastCall?.[1]).toBe(true);
  controller.setMotionMode('animated'); expect(callback.mock.lastCall?.[1]).toBe(false);
  controller.setMotionMode('system'); expect(callback.mock.lastCall?.[1]).toBe(true);
  remove();
});

it('an individual drawing error does not stop the other characters', async () => {
  const controller = await clock(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const removeBroken = controller.animateFrames(() => { throw new Error('one sprite'); });
  const healthy = vi.fn(); const removeHealthy = controller.animateFrames(healthy);
  controller.advance(1000); expect(healthy).toHaveBeenCalledTimes(2);
  expect(controller.queued.size).toBe(1); removeBroken(); removeHealthy();
});
