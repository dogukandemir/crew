import { setMotionMode, useSystemReducedMotion, useMotionMode, type MotionMode } from './animation';
import { Select } from '../components/ui/Field';

export function MotionControl() {
  const reduced = useSystemReducedMotion();
  const mode = useMotionMode();
  return (
    <Select aria-label="Office motion" value={mode} onChange={event => setMotionMode(event.target.value as MotionMode)}
      className="w-auto shrink-0 py-1 text-xs" title="Controls only the office animation. Work and status updates continue.">
      <option value="system">System: {reduced ? 'reduced motion' : 'default motion'}</option>
      <option value="animated">Animated</option><option value="calm">Calm</option>
    </Select>
  );
}
