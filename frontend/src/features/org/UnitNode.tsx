import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { StatusDot, dotForState } from '../../components/ui/StatusDot';
import { formatMicros } from '../../lib/format';
import { gradeLabel, type UnitFlowNode } from './orgUtils';

const KIND_LABEL: Record<string, string> = {
  project: 'project',
  department: 'dept',
  squad: 'squad',
  agent: 'agent',
};

const KIND_STYLE: Record<string, string> = {
  project: 'border-emerald-500/50',
  department: 'border-sky-500/40',
  squad: 'border-violet-500/40',
  agent: 'border-slate-600/60',
};

export function UnitNode({ data, selected }: NodeProps<UnitFlowNode>) {
  const u = data.unit;
  const cost = u.spend_micros ?? u.cost_micros;
  const openTasks = u.open_tasks ?? 0;

  return (
    <div
      className={cn(
        'w-[180px] rounded-md border bg-slate-900/95 px-2 py-1.5 text-left shadow-md transition-shadow',
        KIND_STYLE[u.kind] ?? 'border-slate-600/60',
        selected && 'ring-2 ring-emerald-400/70',
        u.state === 'archived' && 'opacity-50',
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-600" />
      <div className="flex items-center gap-1.5">
        <StatusDot state={dotForState(u.state)} pulse={data.pulse} />
        <span className="truncate text-[11px] font-semibold text-slate-100" title={u.name}>
          {u.name}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Badge tone="muted">{KIND_LABEL[u.kind] ?? u.kind}</Badge>
        {u.role && <Badge tone="info">{u.role}</Badge>}
        {u.grade !== undefined && <Badge tone="accent">G{u.grade}</Badge>}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
        <span title="reputation score">
          score {typeof u.score === 'number' ? u.score.toFixed(2) : '—'}
        </span>
        <span className="tabular-nums" title="spend">
          {cost === undefined ? '—' : formatMicros(cost)}
        </span>
      </div>
      {openTasks > 0 && (
        <div className="mt-0.5 text-[10px] text-amber-300/90">{openTasks} open task{openTasks === 1 ? '' : 's'}</div>
      )}
      {u.grade !== undefined && u.kind === 'agent' && (
        <div className="text-[10px] text-slate-500">{gradeLabel(u.grade)}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-600" />
    </div>
  );
}
