/**
 * Query hooks — the read side of the client (docs/11 §2).
 * One hook per endpoint group; React Query owns loading/error/stale state.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  Approval,
  Brain,
  BrainEntry,
  Department,
  EventRow,
  Health,
  LeaderboardEntry,
  OrgTree,
  Paged,
  Project,
  ProjectMetrics,
  RewardEvent,
  RewardTransition,
  Run,
  Task,
} from '../api/types';

const MINUTE = 60_000;

export function useHealth(): UseQueryResult<Health> {
  return useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10_000,
    retry: 1,
    staleTime: 5_000,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: ['system', 'status'],
    queryFn: api.systemStatus,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
}

export function useCompanies() {
  // The company strip is optional: a backend without the company layer must not break Home.
  return useQuery({ queryKey: ['companies'], queryFn: api.listCompanies, retry: 1 });
}

export function useBoard(projectId: string | null | undefined, departmentId?: string,
                         squadId?: string) {
  return useQuery({
    queryKey: ['board', projectId, departmentId ?? '', squadId ?? ''],
    queryFn: () => api.getBoard(projectId as string, { department_id: departmentId, squad_id: squadId }),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });
}

export function useCompanyHq(companyId: string | null | undefined) {
  // The HQ floor polls like the office does: the board convenes, money moves and
  // leads walk to the CEO's office because the record changed — not on reload.
  return useQuery({
    queryKey: ['company-hq', companyId],
    queryFn: () => api.getCompanyHq(companyId as string),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id as string),
    enabled: !!id,
  });
}

export function useProjectMetrics(id: string | null | undefined) {
  return useQuery({
    queryKey: ['project', id, 'metrics'],
    queryFn: () => api.projectMetrics(id as string),
    enabled: !!id,
  });
}

export function useProjectRuns(id: string | null | undefined) {
  return useQuery({
    queryKey: ['project', id, 'runs'],
    queryFn: () => api.listRuns(id as string),
    enabled: !!id,
  });
}

export function useOrg(id: string | null | undefined) {
  return useQuery({
    queryKey: ['project', id, 'org'],
    queryFn: () => api.getOrg(id as string),
    enabled: !!id,
    // The organization is not a photograph. Agents are hired while the tab is open and
    // departments open around them, and the office draws itself FROM this query — so
    // without a poll the floor plan is whatever it was the moment the tab loaded: the
    // new room exists in the database and nowhere on screen.
    //
    // A poll rather than a socket listener because the office needs the whole org, not
    // one event. When the backend emits agent.hired / department.created on the bus,
    // this should be invalidated from there and the interval dropped.
    // ... and it polls in the BACKGROUND too, which is the difference between a floor
    // plan that grows while you watch it and one that only catches up when you come
    // back to the tab. React Query's default is to pause intervals on an unfocused
    // window; for an office dashboard left open on a second monitor that is the wrong
    // trade, and it is also what made this look broken from a headless tab.
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });
}

export function useTasks(
  id: string | null | undefined,
  filter?: { state?: string; dept?: string; squad?: string; agent?: string; run?: string },
) {
  return useQuery<Paged<Task>>({
    queryKey: ['project', id, 'tasks', filter ?? {}],
    queryFn: () => api.listTasks(id as string, filter),
    enabled: !!id,
  });
}

export function useTask(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.getTask(taskId as string),
    enabled: !!taskId,
  });
}

export function useAgent(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => api.getAgent(agentId as string),
    enabled: !!agentId,
  });
}

export function useDepartment(deptId: string | null | undefined) {
  return useQuery<Department>({
    queryKey: ['department', deptId],
    queryFn: () => api.getDepartment(deptId as string),
    enabled: !!deptId,
  });
}

export function useAgentRewards(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['agent', agentId, 'rewards'],
    queryFn: () => api.agentRewards(agentId as string),
    enabled: !!agentId,
  });
}

export function useLeaderboard(id: string | null | undefined) {
  return useQuery<Paged<LeaderboardEntry>>({
    queryKey: ['project', id, 'leaderboard'],
    queryFn: () => api.leaderboard(id as string),
    enabled: !!id,
  });
}

export function useRewardTransitions(id: string | null | undefined) {
  return useQuery<Paged<RewardTransition>>({
    queryKey: ['project', id, 'reward-transitions'],
    queryFn: () => api.rewardTransitions(id as string),
    enabled: !!id,
  });
}

export function useApprovals(id: string | null | undefined, state?: string) {
  return useQuery<Paged<Approval>>({
    queryKey: ['project', id, 'approvals', state ?? 'all'],
    queryFn: () => api.listApprovals(id as string, state),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useBrains(id: string | null | undefined) {
  return useQuery<Brain[]>({
    queryKey: ['project', id, 'brains'],
    queryFn: () => api.listBrains(id as string),
    enabled: !!id,
  });
}

export function useBrainEntries(
  brainId: string | null | undefined,
  filter?: { kind?: string; tag?: string; q?: string },
) {
  return useQuery<Paged<BrainEntry>>({
    queryKey: ['brain', brainId, 'entries', filter ?? {}],
    queryFn: () => api.listBrainEntries(brainId as string, filter),
    enabled: !!brainId,
  });
}

export function useAgentContext(projectId: string | null | undefined, agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'agent', agentId, 'context'],
    queryFn: () => api.getAgentContext(projectId as string, agentId as string),
    enabled: !!projectId && !!agentId,
    retry: false,
  });
}

export function useRuns(projectId: string | null | undefined) {
  return useQuery<Run[]>({
    queryKey: ['project', projectId, 'runs'],
    queryFn: async () => (await api.listRuns(projectId as string)).items,
    enabled: !!projectId,
  });
}

export function useTaskArtifacts(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ['task', taskId, 'artifacts'],
    queryFn: () => api.listTaskArtifacts(taskId as string),
    enabled: !!taskId,
  });
}

/** Historical events for a cold view (the socket only carries the live tail). */
export function useEventBackfill(projectId: string | null | undefined, limit = 200) {
  return useQuery<Paged<EventRow>>({
    queryKey: ['project', projectId, 'events', limit],
    queryFn: () => api.listEvents(projectId as string, { limit }),
    enabled: !!projectId,
    staleTime: MINUTE,
    retry: false,
  });
}

export function useAgentList(id: string | null | undefined) {
  return useQuery<LeaderboardEntry[]>({
    queryKey: ['project', id, 'agents'],
    queryFn: async () => (await api.leaderboard(id as string)).items,
    enabled: !!id,
    retry: false,
  });
}
