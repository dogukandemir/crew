/**
 * Module-level registry of live sockets, one per open project.
 *
 * Kept out of `SocketProvider.tsx` on purpose: a module that exports a React
 * component must not also export plain functions, or Vite's Fast Refresh
 * invalidates the whole file on every edit instead of hot-swapping it.
 */
import { CrewSocket } from './socket';

const registry = new Map<string, CrewSocket>();

export function getSocket(projectId: string | null | undefined): CrewSocket | undefined {
  return projectId ? registry.get(projectId) : undefined;
}

export function hasSocket(projectId: string): boolean {
  return registry.has(projectId);
}

export function registerSocket(projectId: string, socket: CrewSocket): void {
  registry.set(projectId, socket);
}

export function unregisterSocket(projectId: string): void {
  registry.delete(projectId);
}

export function socketEntries(): Array<[string, CrewSocket]> {
  return Array.from(registry.entries());
}
