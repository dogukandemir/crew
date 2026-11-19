import type { Project } from '../../api/types';

export function hasActiveRun(project: Pick<Project, 'active_run' | 'stage'>): boolean {
  return project.active_run ?? !['IDLE', 'DONE', 'FAILED', 'ABORTED', ''].includes(project.stage);
}

export function needsResume(project: Pick<Project, 'status' | 'run_status'>): boolean {
  return project.status === 'paused' || !!project.run_status?.startsWith('paused');
}

export function runLabel(project: Project): string {
  if (project.status === 'archived') return 'Archived';
  const labels: Record<string, string> = {
    completed: 'Completed', failed: 'Failed', aborted: 'Stopped',
    running: 'Running', pending: 'Queued', paused: 'Paused', paused_budget: 'Budget pause',
    pending_confirmation: 'Needs your confirmation',
    pending_clarification: 'Needs your answers',
  };
  if (project.run_status) return labels[project.run_status] ?? project.run_status;
  if (project.status === 'paused') return 'Paused';
  return project.stage === 'DONE' ? 'Completed' : hasActiveRun(project) ? 'Running' : 'Ready';
}
