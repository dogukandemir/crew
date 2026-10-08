/**
 * The command desk's pure parts (ADR 0012): mention typing, mode reading, and the
 * roster the desk can address. No React, no network — the drawer and its tests share
 * these rules, so the input behaves the same everywhere.
 */
import type { OrgNode, OrgTree } from '../../api/types';

export interface RosterAgent {
  id: string;
  name: string;
  role?: string;
}

export type CommandMode = 'order' | 'idea' | 'question';

/** Every hired agent the org tree knows, flattened once. */
export function agentsFromOrg(tree: OrgTree | undefined): RosterAgent[] {
  const out: RosterAgent[] = [];
  const walk = (n: OrgNode | undefined) => {
    if (!n) return;
    if (n.kind === 'agent') out.push({ id: n.id, name: n.name, role: n.role });
    (n.children ?? []).forEach(walk);
  };
  walk(tree?.root);
  return out;
}

export interface MentionContext {
  fragment: string;
  start: number;
  end: number;
  matches: RosterAgent[];
}

/**
 * The mention being typed at `caret`, if any. An `@` with no whitespace between it
 * and the caret is an open mention; a space closes it (that's how you finish a tag).
 */
export function mentionContext(
  text: string,
  caret: number,
  roster: RosterAgent[],
): MentionContext | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  const fragment = upto.slice(at + 1);
  if (/[\s\n]/.test(fragment)) return null;
  const q = fragment.toLowerCase();
  const matches = roster
    .filter(
      (a) =>
        q === '' ||
        a.name.toLowerCase().startsWith(q) ||
        a.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(q)),
    )
    .slice(0, 6);
  return { fragment, start: at, end: caret, matches };
}

/** Replace the open mention with the chosen agent's first name and a trailing space. */
export function insertMention(
  text: string,
  ctx: Pick<MentionContext, 'start' | 'end'>,
  agent: RosterAgent,
): { text: string; caret: number } {
  const before = text.slice(0, ctx.start);
  const after = text.slice(ctx.end);
  const insert = `@${agent.name.split(/\s+/)[0]} `;
  return { text: before + insert + after, caret: (before + insert).length };
}

/**
 * How the desk will read the message before it's sent: a trailing question mark asks;
 * idea words float; anything else is an order. Mirrors the backend's parser so the
 * preview never lies.
 */
export function modeOf(text: string): CommandMode {
  const t = text.trim();
  let mode: CommandMode = 'order';
  const q = t.indexOf('?');
  if (q >= 0 && q < 60) mode = 'question';
  if (/(^|\s)(fikrim|fikir|öneri|oneri|belki|idea|maybe|suggestion)(\s|:|$)/i.test(t)) mode = 'idea';
  return mode;
}

const ACTION_LABELS: Record<string, string> = {
  'task.created': 'task created',
  'task.assigned': 'assigned',
  'task.reassigned': 'reassigned',
  'run.started': 'run started',
  'agent.break.started': 'break set',
  'agent.hired': 'hired',
};

export function actionLabel(kind: string): string {
  return ACTION_LABELS[kind] ?? kind;
}
