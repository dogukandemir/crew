/**
 * The board tab (ADR 0010): epics → features → stories, bugs, per-team views.
 *
 * Columns for items that became real tasks are DERIVED from the task state by the
 * backend, so this view cannot disagree with the engine — the card says "follows task"
 * and cannot be dragged. Only items still waiting for promotion move by hand.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useBoard, useOrg } from '../../app/hooks';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, SkeletonRows } from '../../components/ui/EmptyState';
import { PanelError } from '../../components/PanelError';
import type { BoardColumnKey, BoardItem, BoardItemKind, OrgNode, OrgTree } from '../../api/types';

const KIND_BADGE: Record<BoardItemKind, { label: string; tone: 'accent' | 'info' | 'neutral' | 'success' | 'danger' }> = {
  epic: { label: 'EPIC', tone: 'accent' },
  feature: { label: 'FEATURE', tone: 'info' },
  story: { label: 'STORY', tone: 'neutral' },
  task: { label: 'TASK', tone: 'success' },
  bug: { label: 'BUG', tone: 'danger' },
};

const SEVERITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'danger'> = {
  low: 'muted',
  normal: 'neutral',
  high: 'warning',
  critical: 'danger',
};

const FLOW: BoardColumnKey[] = ['backlog', 'ready', 'in_progress', 'review', 'done'];

function step(state: BoardColumnKey, dir: 1 | -1): BoardColumnKey | null {
  const i = FLOW.indexOf(state);
  if (i < 0) return null;
  return FLOW[i + dir] ?? null;
}

interface TeamOption {
  id: string;
  name: string;
  departmentId?: string | null;
}

function teamsFrom(tree: OrgTree | undefined): { departments: TeamOption[]; squads: TeamOption[] } {
  const departments: TeamOption[] = [];
  const squads: TeamOption[] = [];
  const walk = (n: OrgNode) => {
    if (n.kind === 'department') departments.push({ id: n.id, name: n.name });
    if (n.kind === 'squad') squads.push({ id: n.id, name: n.name, departmentId: n.department_id });
    (n.children ?? []).forEach(walk);
  };
  if (tree?.root) walk(tree.root);
  return { departments, squads };
}

const selectCls = 'rounded border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-300';
const inputCls =
  'w-48 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600';
const moveBtn =
  'rounded border border-slate-700 px-1.5 text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-40';

export function BoardTab({ projectId }: { projectId: string }) {
  const [departmentId, setDepartmentId] = useState('');
  const [squadId, setSquadId] = useState('');
  const [kind, setKind] = useState<BoardItemKind>('story');
  const [parentId, setParentId] = useState('');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('normal');
  const qc = useQueryClient();

  const board = useBoard(projectId, departmentId || undefined, squadId || undefined);
  const org = useOrg(projectId);
  const { departments, squads } = useMemo(() => teamsFrom(org.data), [org.data]);
  const visibleSquads = departmentId
    ? squads.filter((s) => s.departmentId === departmentId)
    : squads;

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['board', projectId] });
  const create = useMutation({
    mutationFn: () =>
      api.createBoardItem(projectId, {
        kind,
        title: title.trim(),
        severity: kind === 'bug' ? severity : undefined,
        department_id: departmentId || undefined,
        squad_id: squadId || undefined,
        parent_id: parentId || undefined,
      }),
    onSuccess: () => {
      setTitle('');
      invalidate();
    },
  });
  const move = useMutation({
    mutationFn: (p: { id: string; state: BoardColumnKey }) =>
      api.patchBoardItem(p.id, { state: p.state }),
    onSuccess: invalidate,
  });

  if (board.isPending) return <SkeletonRows rows={6} />;
  if (board.isError) return <PanelError error={board.error} onRetry={() => void board.refetch()} />;
  const total = board.data.columns.reduce((n, c) => n + c.items.length, 0);
  const parents = board.data.columns
    .flatMap((c) => c.items)
    .filter((i) => i.kind === 'epic' || i.kind === 'feature');

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={departmentId}
          onChange={(e) => {
            setDepartmentId(e.target.value);
            setSquadId('');
          }}
          className={selectCls}
          aria-label="Team"
        >
          <option value="">All teams</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          value={squadId}
          onChange={(e) => setSquadId(e.target.value)}
          className={selectCls}
          aria-label="Squad"
        >
          <option value="">All squads</option>
          {visibleSquads.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as BoardItemKind)}
            className={selectCls}
            aria-label="Item kind"
          >
            <option value="epic">Epic</option>
            <option value="feature">Feature</option>
            <option value="story">Story</option>
            <option value="task">Task</option>
            <option value="bug">Bug</option>
          </select>
          {(kind === 'story' || kind === 'task' || kind === 'bug') && parents.length > 0 && (
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className={selectCls}
              aria-label="Parent"
            >
              <option value="">— top level —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === 'epic' ? 'Epic' : 'Feature'} · {p.title.slice(0, 36)}
                </option>
              ))}
            </select>
          )}
          {kind === 'bug' && (
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className={selectCls}
              aria-label="Severity"
            >
              {['low', 'normal', 'high', 'critical'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New work item…"
            className={inputCls}
          />
          <Button size="sm" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
            Add
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <EmptyState
          title="The board is empty"
          description="Start a run — the planner writes its epic, features and stories here — or add an epic, feature, story, task or bug by hand; work moved to Ready is picked up by the next wave."
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {board.data.columns.map((col) => (
            <section
              key={col.key}
              className="flex w-56 shrink-0 flex-col rounded-lg border border-slate-800 bg-slate-900/30"
            >
              <header className="flex items-center justify-between border-b border-slate-800 px-2.5 py-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {col.title}
                </h3>
                <span className="text-[10px] text-slate-500">{col.items.length}</span>
              </header>
              <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden p-2">
                {col.items.length === 0 && <li className="px-1 py-2 text-[10px] text-slate-600">—</li>}
                {col.items.map((item) => (
                  <Card
                    key={item.id}
                    item={item}
                    busy={move.isPending}
                    onMove={(state) => move.mutate({ id: item.id, state })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({
  item,
  onMove,
  busy,
}: {
  item: BoardItem;
  onMove: (s: BoardColumnKey) => void;
  busy: boolean;
}) {
  const badge = KIND_BADGE[item.kind];
  const from = item.state === 'blocked' ? 'backlog' : item.state;
  const back = step(from, -1);
  const forward = step(from, 1);
  return (
    <li className="rounded-md border border-slate-700/60 bg-slate-900/60 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {item.kind === 'bug' && <Badge tone={SEVERITY_TONE[item.severity]}>{item.severity}</Badge>}
        {item.task_state && (
          <span className="ml-auto text-[10px] text-slate-500">{item.task_state}</span>
        )}
      </div>
      <p className="mt-1 text-xs leading-snug text-slate-200">{item.title}</p>
      <p className="mt-0.5 text-[10px] text-slate-500">
        {item.assignee_name
          ? `@${item.assignee_name}`
          : item.creator_name
            ? `by ${item.creator_name}`
            : item.created_by}
        {item.helpers.length > 0 && (
          <span title={item.helpers.join(', ')}> · +{item.helpers.length} helping</span>
        )}
      </p>
      {item.task_id ? (
        <p
          className="mt-1 text-[10px] text-slate-600"
          title="this item is a live task's record; its column follows the task"
        >
          follows task{item.attempts ? ` · attempt ${item.attempts}` : ' · first attempt'}
        </p>
      ) : (
        item.state !== 'done' && (
          <div className="mt-1 flex gap-1">
            {back && (
              <button className={moveBtn} disabled={busy} title={`move to ${back}`} onClick={() => onMove(back)}>
                ←
              </button>
            )}
            {forward && (
              <button
                className={moveBtn}
                disabled={busy}
                title={`move to ${forward}`}
                onClick={() => onMove(forward)}
              >
                →
              </button>
            )}
          </div>
        )
      )}
    </li>
  );
}
