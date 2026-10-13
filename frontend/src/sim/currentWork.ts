import type { Project, Task } from '../api/types';

/** History remains available, but it must not masquerade as work happening now. */
export function currentWork(tasks: Task[], project?: Pick<Project, 'latest_run_id' | 'active_run' | 'run_status'>): Task[] {
  if (!project || project.active_run === undefined) return tasks;
  return tasks.filter(task => !task.run_id || (project.active_run && task.run_id === project.latest_run_id));
}

export function latestRunTasks(tasks: Task[], project?: Pick<Project, 'latest_run_id'>): Task[] {
  return project?.latest_run_id ? tasks.filter(task => task.run_id === project.latest_run_id) : tasks;
}
