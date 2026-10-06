import { cn } from '../../lib/cn';
import type { OrgNode } from '../../api/types';
import { avatarFor } from './avatars';
import type { Activity } from './activity';

/**
 * One character. The outer `.sprite` is positioned in world coordinates by the
 * rAF walker loop (which writes `transform` directly to avoid re-rendering on
 * every frame); the inner element is billboarded so the emoji stands upright on
 * the tilted floor.
 */
export function Sprite({
  agent,
  activity,
  selected,
  dimmed,
  walkingTo,
  onSelect,
  register,
}: {
  agent: OrgNode;
  activity: Activity;
  selected: boolean;
  dimmed?: boolean;
  walkingTo?: string;
  onSelect: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const avatar = avatarFor(agent.role, agent.id);

  return (
    <div
      ref={register}
      className={cn('sprite', `act-${activity.kind}`, dimmed && 'is-dim', selected && 'is-selected')}
    >
      <span className="sprite-shadow" aria-hidden />
      <div className="sprite-inner">
        {activity.bubble && <span className="sprite-bubble">{activity.bubble}</span>}
        <span className="sprite-tag" title={`${agent.name} — ${activity.note}`}>
          {agent.name}
        </span>
        <button
          type="button"
          className="sprite-hit"
          data-sprite={agent.id}
          onClick={onSelect}
          aria-label={`${agent.name} — ${agent.role ?? 'agent'} — ${activity.note}`}
          aria-pressed={selected}
        >
          <span className="sprite-body">{avatar}</span>
        </button>
        <div className="sprite-tip" role="tooltip">
          <div className="sprite-tip-title">
            {agent.name}
            {agent.grade !== undefined ? ` · G${agent.grade}` : ''}
          </div>
          <div className="sprite-tip-line">{agent.role ?? 'agent'}</div>
          <div className="sprite-tip-note">{activity.note}</div>
          {walkingTo && <div className="sprite-tip-line">walking to {walkingTo}</div>}
          <div className="sprite-tip-line">click for thinking &amp; output</div>
        </div>
        <span className="sprite-ring" aria-hidden />
      </div>
    </div>
  );
}
