/** One 30 fps clock for all floor/sprite animation; idle while the page is hidden. */
type Subscriber = (now: number, reducedMotion: boolean) => void;
const subscribers = new Set<Subscriber>();
let frame = 0;
let previous = 0;

function tick(now: number) {
  frame = 0;
  if (document.hidden || !subscribers.size) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (now - previous >= (reduced ? 500 : 1000 / 30)) {
    previous = now;
    subscribers.forEach(callback => callback(now, reduced));
  }
  frame = requestAnimationFrame(tick);
}

function visibility() {
  if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
  else if (!frame && subscribers.size) frame = requestAnimationFrame(tick);
}

export function animateFrames(callback: Subscriber): () => void {
  subscribers.add(callback);
  if (subscribers.size === 1) document.addEventListener('visibilitychange', visibility);
  visibility();
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      cancelAnimationFrame(frame); frame = 0;
      document.removeEventListener('visibilitychange', visibility);
    }
  };
}
