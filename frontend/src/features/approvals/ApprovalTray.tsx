import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Approval } from '../../api/types';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { useApprovals } from '../../app/hooks';
import { useTabs } from '../../stores/tabs';
import { useUi } from '../../stores/ui';
import { formatRelativeTime } from '../../lib/format';

/**
 * Persistent approval tray (docs/09 §3): "the two things that need *you*".
 * One section per open project; renders nothing when there is nothing pending.
 */
export function ApprovalTray() {
  const tabs = useTabs((s) => s.tabs);
  const open = useUi((s) => s.approvalsOpen);
  const setOpen = useUi((s) => s.setApprovalsOpen);
  // Derive outside the selector: a mapped array is a new identity every render,
  // which would spin `useSyncExternalStore` into an infinite loop.
  const unique = useMemo(() => Array.from(new Set(tabs.map((t) => t.projectId))), [tabs]);

  // useQueries (not a hook in a loop) keeps the collapsed counter honest.
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: ['project', id, 'approvals', 'pending'],
      queryFn: () => api.listApprovals(id, 'pending'),
      refetchInterval: 15_000,
    })),
  });
  const total = results.reduce((sum, r) => sum + (r.data?.items.length ?? 0), 0);

  if (unique.length === 0) return null;

  return (
    <div className="fixed bottom-3 right-3 z-30 w-[22rem]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mb-1 flex w-full items-center justify-between rounded-md border border-slate-600/70 bg-slate-900/95 px-2.5 py-1.5 text-xs text-slate-200 shadow-lg"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>⚑</span> Approvals
          {total > 0 ? (
            <Badge tone="warning">{total} pending</Badge>
          ) : (
            <Badge tone="muted">none pending</Badge>
          )}
        </span>
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-md border border-slate-700/70 bg-slate-950/97 p-2 shadow-2xl">
          {unique.map((id) => (
            <ProjectApprovals key={id} projectId={id} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectApprovals({ projectId }: { projectId: string }) {
  const approvals = useApprovals(projectId, 'pending');
  const items = approvals.data?.items ?? [];

  if (approvals.isLoading) return <p className="px-1 py-2 text-[11px] text-slate-500">Loading approvals…</p>;
  if (approvals.isError) {
    // A dead backend must never look like "nothing to approve".
    return (
      <p className="px-1 py-2 text-[11px] text-amber-300/80">
        Approvals unavailable for {projectId.slice(0, 8)} — backend unreachable.
      </p>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{projectId.slice(0, 8)}</div>
      {items.map((a) => (
        <ApprovalRow key={a.id} approval={a} projectId={projectId} />
      ))}
    </div>
  );
}

function ApprovalRow({ approval, projectId }: { approval: Approval; projectId: string }) {
  const [reason, setReason] = useState('');
  const [openForReason, setOpenForReason] = useState(false);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);

  const decide = useMutation({
    mutationFn: (kind: 'grant' | 'deny') =>
      kind === 'grant'
        ? api.grantApproval(approval.id, reason || undefined)
        : api.denyApproval(approval.id, reason || undefined),
    onSuccess: (_r, kind) => {
      setToast({ kind: 'success', message: `Approval ${kind === 'grant' ? 'granted' : 'denied'}.` });
      setReason('');
      setOpenForReason(false);
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'approvals'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  return (
    <div className="rounded border border-slate-700/60 bg-slate-900/60 p-1.5">
      <div className="flex items-center gap-2">
        <Badge tone="warning">{approval.capability}</Badge>
        <span className="ml-auto text-[10px] text-slate-500">{formatRelativeTime(approval.created_at)}</span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-slate-500">
        {approval.agent_id ? `agent ${approval.agent_id.slice(0, 8)}` : 'agent —'}
        {approval.task_id ? ` · task ${approval.task_id.slice(0, 8)}` : ''}
      </div>
      {approval.request && (
        <pre className="mt-1 max-h-20 overflow-auto rounded bg-slate-950/70 p-1 font-mono text-[10px] text-slate-400">
          {JSON.stringify(approval.request, null, 1)}
        </pre>
      )}
      {openForReason && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
          className="mt-1 h-6 text-[11px]"
        />
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button size="xs" variant="primary" loading={decide.isPending} onClick={() => decide.mutate('grant')}>
          Grant
        </Button>
        <Button size="xs" variant="danger" onClick={() => (openForReason ? decide.mutate('deny') : setOpenForReason(true))}>
          {openForReason ? 'Confirm deny' : 'Deny'}
        </Button>
        <button
          type="button"
          className="ml-auto text-[10px] text-slate-500 hover:text-slate-300"
          onClick={() => setOpenForReason((v) => !v)}
        >
          {openForReason ? 'hide reason' : 'add reason'}
        </button>
      </div>
    </div>
  );
}
