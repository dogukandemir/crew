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
    refetchInterval: 10_000,
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
