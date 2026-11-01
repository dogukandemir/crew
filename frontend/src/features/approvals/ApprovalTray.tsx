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
  const names = useTabs((s) => s.names);
  const items = approvals.data?.items ?? [];
  const label = names[projectId] ?? projectId.slice(0, 8);

  if (approvals.isLoading) return <p className="px-1 py-2 text-[11px] text-slate-500">Loading approvals…</p>;
  if (approvals.isError) {
    // A dead backend must never look like "nothing to approve".
    return (
      <p className="px-1 py-2 text-[11px] text-amber-300/80">
        Approvals unavailable for {label}, backend unreachable.
      </p>
    );
  }
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      {items.map((a) => (
        <ApprovalRow key={a.id} approval={a} projectId={projectId} />
      ))}
    </div>
  );
}

export function ApprovalRow({ approval, projectId }: { approval: Approval; projectId: string }) {
  const [reason, setReason] = useState('');
  const [openForReason, setOpenForReason] = useState(false);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);

  // Review approvals carry their context in `request` (ADR 0017): a held command's
  // text + reasons, or a quarantined page's URL + preview. The human decides on what
  // they can actually see, everything else falls back to the raw view.
  const req = approval.request ?? {};
  const kind = typeof req.kind === 'string' ? req.kind : 'generic';
  const isCommand = kind === 'command_review';
  const isContent = kind === 'content_review';
  // An egress request is a host the proxy refused: host + url are the whole case.
  const isEgress = kind === 'egress';
  const isTool = !isCommand && !isContent && !isEgress && typeof req.tool === 'string';
  const cmd = typeof req.cmd === 'string' ? req.cmd : '';
  const url = typeof req.url === 'string' ? req.url : '';
  const preview = typeof req.preview === 'string' ? req.preview : '';
  const note = typeof req.note === 'string' ? req.note : '';
  const reasons = Array.isArray(req.reasons) ? (req.reasons as string[]) : [];
  // Field names are read defensively: a request that predates the egress card still
  // renders, an empty host reads as "not reported" instead of a blank title.
  const host =
    typeof req.host === 'string' && req.host
      ? req.host
      : typeof req.blocked_host === 'string' && req.blocked_host
        ? req.blocked_host
        : typeof req.domain === 'string'
          ? req.domain
          : '';
  const egressUrl =
    url || (typeof req.target_url === 'string' ? req.target_url : '');

  const decide = useMutation({
    mutationFn: (action: 'grant' | 'always' | 'deny'): Promise<unknown> =>
      action === 'deny'
        ? api.denyApproval(approval.id, reason || undefined)
        : api.grantApproval(approval.id, reason || undefined,
            action === 'always' ? { always: true } : undefined),
    onSuccess: (_r, action) => {
      setToast({
        kind: 'success',
        message:
          action === 'deny'
            ? 'Approval denied.'
            : action === 'always'
              ? isEgress
                ? `Always allowed, ${host || 'the host'} is now on this project’s egress allowlist.`
                : isTool
                  ? 'Standing approval saved, this agent’s calls skip the gate until revoked (Settings → Tool allowlist).'
                  : 'Always allowed, it will not ask again until revoked (Settings → Command allowlist).'
              : 'Approval granted.',
      });
      setReason('');
      setOpenForReason(false);
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'approvals'] });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'command-allows'] });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'capability-allows'] });
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'egress'] });
    },
    onError: (err) => setToast({ kind: 'error', message: String(err) }),
  });

  return (
    <div className="rounded border border-slate-700/60 bg-slate-900/60 p-1.5">
      <div className="flex items-center gap-2">
        {isCommand ? (
          <Badge tone="warning">command review</Badge>
        ) : isContent ? (
          <Badge tone="warning">content review</Badge>
        ) : isEgress ? (
          <Badge tone="warning">egress</Badge>
        ) : (
          <Badge tone="warning">{approval.capability}</Badge>
        )}
        <span className="ml-auto text-[10px] text-slate-500">{formatRelativeTime(approval.created_at)}</span>
      </div>

      {isEgress && (
        <div className="mt-1 break-all font-mono text-[12px] font-medium text-amber-200/90">
          {host || 'blocked host not reported'}
        </div>
      )}
      {isEgress && (
        <div className="mt-0.5 break-all font-mono text-[10px] text-slate-400">
          {egressUrl || 'url not reported'}
        </div>
      )}

      <div className="mt-1 font-mono text-[10px] text-slate-500">
        {approval.agent_id ? `agent ${approval.agent_id.slice(0, 8)}` : 'agent,'}
        {approval.task_id ? ` · task ${approval.task_id.slice(0, 8)}` : ''}
        {isCommand && typeof req.tool === 'string' ? ` · ${req.tool}` : ''}
      </div>

      {isCommand && (
        <>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-slate-950/70 p-1 font-mono text-[10px] text-amber-200/90">
            {cmd || 'n/a'}
          </pre>
          {note && <p className="mt-1 text-[10px] italic leading-snug text-slate-400">{note}</p>}
        </>
      )}

      {isContent && (
        <>
          <div className="mt-1 break-all font-mono text-[10px] text-slate-400">{url || 'n/a'}</div>
          {preview && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-950/70 p-1 font-mono text-[10px] text-slate-400">
              {preview}
            </pre>
          )}
        </>
      )}

      {!isCommand && !isContent && !isEgress && approval.request && (
        <pre className="mt-1 max-h-20 overflow-auto rounded bg-slate-950/70 p-1 font-mono text-[10px] text-slate-400">
          {JSON.stringify(approval.request, null, 1)}
        </pre>
      )}

      {isEgress && (
        <p className="mt-1 text-[10px] leading-snug text-slate-400">
          Always allow writes {host || 'this host'} into this project’s egress allowlist, it will not ask again.
        </p>
      )}

      {reasons.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {reasons.slice(0, 6).map((r) => (
            <span key={r} className="rounded bg-amber-950/50 px-1 py-0.5 text-[9px] text-amber-300/80">
              {r}
            </span>
          ))}
        </div>
      )}
      {openForReason && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
          className="mt-1 h-6 text-[11px]"
        />
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="primary" loading={decide.isPending} onClick={() => decide.mutate('grant')}>
          {isContent ? 'Release' : isEgress ? 'Allow once' : 'Grant once'}
        </Button>
        {(isCommand || isTool || isEgress) && (
          <Button size="xs" variant="secondary" loading={decide.isPending} onClick={() => decide.mutate('always')}>
            Always allow
          </Button>
        )}
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
