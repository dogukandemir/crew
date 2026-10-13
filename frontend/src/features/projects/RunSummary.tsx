import type { Project } from '../../api/types';
import { Button } from '../../components/ui/Button';
import type { WorkspaceTab } from '../../stores/tabs';

export function RunSummary({ project, navigate }: { project: Project; navigate: (tab: WorkspaceTab) => void }) {
  const status = project.run_status;
  if (!status || !['completed', 'failed', 'aborted', 'paused', 'paused_budget'].includes(status)) return null;
  const complete = status === 'completed';
  const paused = status.startsWith('paused');
  return <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm ${complete
    ? 'border-emerald-900/50 bg-emerald-950/20 text-emerald-100' : 'border-amber-900/50 bg-amber-950/20 text-amber-100'}`}>
    <div>
      <p className="font-medium">{complete ? 'Latest run completed' : paused ? 'Your run is paused' : status === 'failed' ? 'Latest run failed' : 'Latest run stopped'}</p>
      <p className="mt-0.5 text-xs text-slate-300">{complete ? 'Review the delivered files and checks before using the result.'
        : status === 'paused_budget' ? 'Review spending limits in Settings before resuming.'
        : paused ? 'Review approvals and the run status in Overview before resuming.'
        : 'Inspect task results before starting another run. Existing files and history are preserved.'}</p>
    </div>
    <Button size="sm" onClick={() => navigate(complete ? 'deliverables' : status === 'paused_budget' ? 'settings' : paused ? 'overview' : 'tasks')}>
      {complete ? 'View deliverables' : status === 'paused_budget' ? 'Review budget' : paused ? 'Review run' : 'Review tasks'}
    </Button>
  </div>;
}
