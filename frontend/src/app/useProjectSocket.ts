import type { CrewSocket } from '../lib/socket';
import { getSocket } from '../lib/socketRegistry';
import { useConnection } from '../stores/connection';

/**
 * The live socket for a project, if one is open.
 *
 * In its own module because `@vitejs/plugin-react` only treats a file as a
 * Fast Refresh boundary when *every* export is a component — a hook exported
 * next to `SocketProvider` downgrades every edit of that file to a full page
 * reload.
 *
 * Subscribing to the connection slice keeps the value current: the socket is
 * created inside an effect, so a bare registry read would return `undefined`
 * on the first render and never refresh on its own.
 */
export function useProjectSocket(projectId: string | null | undefined): CrewSocket | undefined {
  useConnection((s) => (projectId ? s.byProject[projectId]?.state : undefined));
  return getSocket(projectId);
}
