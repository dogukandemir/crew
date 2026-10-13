/** One display-aligned clock for all floor/sprite animation; idle while hidden. */
import { useSyncExternalStore } from 'react';

type Subscriber = (now: number, reducedMotion: boolean) => void;
const subscribers = new Set<Subscriber>();
const listeners = new Set<() => void>();
let frame = 0;
let previous = 0;
const MOTION_KEY = 'crew-calm-motion';
export type MotionMode = 'system' | 'animated' | 'calm';
let mode: MotionMode = 'system';
try {
  const saved = localStorage.getItem('crew-motion-mode');
  if (saved === 'system' || saved === 'animated' || saved === 'calm') mode = saved;
  else if (localStorage.getItem(MOTION_KEY) === 'true') mode = 'calm';
} catch { /* private browser */ }
let media: MediaQueryList | undefined;

function reducedMotion() {
  return mode === 'calm' || (mode === 'system' && systemReducedMotion());
}

function systemReducedMotion() { return media?.matches ?? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; }

function paint(now: number) {
  const reduced = reducedMotion();
  for (const callback of subscribers) {
    try { callback(now, reduced); }
    catch (error) { console.error('Office animation failed', error); }
  }
}

function tick(now: number) {
  frame = 0;
  if (document.hidden || !subscribers.size) return;
  const reduced = reducedMotion();
  if (now - previous >= (reduced ? 500 : 1000 / 60 - 0.5)) {
    previous = now;
    paint(now);
  }
  frame = requestAnimationFrame(tick);
}

function visibility() {
  if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
  else if (!frame && subscribers.size) frame = requestAnimationFrame(tick);
}

function preferenceChanged() {
  listeners.forEach(listener => listener());
  paint(performance.now());
}

export function setCalmMotion(value: boolean) {
  mode = value ? 'calm' : 'system';
  try { localStorage.setItem(MOTION_KEY, String(value)); } catch { /* private browser */ }
  setMotionMode(mode);
}

export function setMotionMode(value: MotionMode) {
  mode = value;
  try { localStorage.setItem('crew-motion-mode', value); } catch { /* private browser */ }
  preferenceChanged();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function useMotionMode() { return useSyncExternalStore(subscribe, () => mode); }
export function useSystemReducedMotion() { return useSyncExternalStore(subscribe, systemReducedMotion); }

export function useCalmMotion() {
  return useSyncExternalStore(subscribe, reducedMotion);
}

export function animateFrames(callback: Subscriber): () => void {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    previous = 0;
    media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener?.('change', preferenceChanged);
    document.addEventListener('visibilitychange', visibility);
  }
  // Paint once even in a hidden tab; mounting must never depend on future frames.
  try { callback(performance.now(), reducedMotion()); }
  catch (error) { console.error('Office animation failed', error); }
  visibility();
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      cancelAnimationFrame(frame); frame = 0;
      document.removeEventListener('visibilitychange', visibility);
      media?.removeEventListener?.('change', preferenceChanged);
      media = undefined;
    }
  };
}
