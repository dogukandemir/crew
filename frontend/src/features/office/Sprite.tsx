import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import type { OrgNode } from '../../api/types';
import type { Activity } from '../../sim/activity';
import { SvgCharacter, type SvgMotionRef } from '../characters/SvgCharacter';
import { lookFor } from '../characters/look';

/**
 * One character on the 2.5D floor.
 *
 * The outer `.sprite` is positioned in world coordinates by the rAF walker loop,
 * which writes `transform` directly so a floor of people moves without React
 * re-rendering. The inner element is counter-rotated so the character stands
 * upright on the tilted floor, and the figure itself is an SVG: crisp at any
 * zoom, no GPU needed, and the same person the 3D office draws — both renderers
 * read one identity from `lookFor`.
 */
export function Sprite({
  agent,
  activity,
  motion,
  atDesk,
  selected,
  dimmed,
  walkingTo,
  onSelect,
  register,
}: {
  agent: OrgNode;
  activity: Activity;
  motion: SvgMotionRef;
  atDesk: boolean;
  selected: boolean;
  dimmed?: boolean;
  walkingTo?: string;
  onSelect: () => void;
  register: (el: HTMLDivElement | null) => void;
}) {
  const look = useMemo(
    () => lookFor(agent.id, agent.role ?? 'agent', agent.grade),
    [agent.id, agent.role, agent.grade],
  );

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
          <span className="sprite-body">
            <SvgCharacter
              look={look}
              activity={activity.kind}
              atDesk={atDesk}
              motion={motion}
              size={72}
              faded={activity.kind === 'offline'}
            />
          </span>
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
