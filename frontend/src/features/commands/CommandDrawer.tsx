/**
 * The command desk (ADR 0012): the Captain writes, the orchestrator answers.
 *
 * One channel, attributed end to end: what the Captain writes lands in the record,
 * the reply cites the actions it took, and a message the desk can't carry out says
 * so plainly. No whispers, no god-hands — the floor knows who spoke.
 *
 * Layout rule: the composer lives in the Drawer's footer, so it is pinned to the
 * bottom of the pane by the layout itself — the transcript scrolls above it and the
 * input is on screen at all times. A sent message scrolls the record, never the
 * Captain's hands.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { CommandMessage, CommandReply } from '../../api/types';
import { Drawer } from '../../components/ui/Drawer';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format';
import { useAgentList, useCommands, useOrg } from '../../app/hooks';
import { useUi } from '../../stores/ui';
import {
  actionLabel,
  agentsFromOrg,
  insertMention,
  mentionContext,
  modeOf,
  type CommandMode,
  type MentionContext,
  type RosterAgent,
} from './commandsModel';

const MODE_TONE: Record<CommandMode, 'accent' | 'info' | 'neutral'> = {
  order: 'accent',
  idea: 'info',
  question: 'neutral',
};

const MODE_HINT: Record<CommandMode, string> = {
  order: 'an order — it binds the floor',
  idea: 'an idea — the desk weighs it',
  question: 'a question — answered, not obeyed',
};

export function CommandDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const commands = useCommands(projectId);
  const agents = useAgentList(projectId);
  const org = useOrg(projectId);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The optimistic tail: our message and the reply the POST returned. It renders the
  // instant the desk answers and steps aside once the record contains it.
  const [tail, setTail] = useState<{ text: string; reply: CommandReply | null } | null>(null);

  const roster = useMemo<RosterAgent[]>(() => {
    const seen = new Map<string, RosterAgent>();
    for (const a of agents.data ?? []) {
      const id = a.agent_id ?? a.id;
      seen.set(id, { id, name: a.name, role: a.role });
    }
    for (const a of agentsFromOrg(org.data)) seen.set(a.id, a);
    return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [agents.data, org.data]);

  const mention = useMemo(() => mentionContext(draft, caret, roster), [draft, caret, roster]);
  const mode = modeOf(draft);

  const send = useMutation({
    mutationFn: (text: string) => api.postCommand(projectId, text),
    onSuccess: (data, text) => {
      // The reply arrives on the POST itself — show it now; the refetch below quietly
      // takes over when the record catches up (one source of truth, no blank in between).
      setDraft('');
      setCaret(0);
      setTail({ text, reply: data.reply });
      void qc.invalidateQueries({ queryKey: ['commands', projectId] });
    },
    onError: (err) => {
      setTail(null);
      setToast({
        kind: 'error',
        message: `The desk didn't take that: ${err instanceof Error ? err.message : err}`,
      });
    },
  });

  const messages: CommandMessage[] = commands.data?.messages ?? [];

  const tailLanded =
    tail?.reply != null &&
    messages.some((m) => m.role === 'orchestrator' && m.text === tail.reply?.text);
  useEffect(() => {
    if (tailLanded) setTail(null);
  }, [tailLanded]);

  // Keep the newest line in view whenever the record grows (or a send is in flight).
  // The sentinel scrolls the drawer's transcript region only — the composer sits in
  // the footer, outside that region, and never moves.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, send.isPending, tail]);

  const applyMention = (agent: RosterAgent) => {
    if (!mention) return;
    const next = insertMention(draft, mention, agent);
    setDraft(next.text);
    setCaret(next.caret);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending) return;
    if (mention && mention.matches.length > 0) {
      // Enter completes the tag first — it never sends a half-typed @name.
      applyMention(mention.matches[0]);
      return;
    }
    setTail({ text, reply: null });
    send.mutate(text);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="32rem"
      title={
        <span className="flex items-center gap-2">
          Command desk <Badge tone="accent">the Captain</Badge>
        </span>
      }
      subtitle="Write to the company in plain words — orders, ideas, questions. The orchestrator reads it, the chain acts, the record keeps it."
      footer={
        <Composer
          mention={mention}
          draft={draft}
          sending={send.isPending}
          mode={mode}
          onDraft={setDraft}
          onCaret={setCaret}
          onMention={applyMention}
          onSubmit={submit}
        />
      }
    >
      <div className="flex flex-col gap-3">
          {commands.isLoading && <p className="text-xs text-slate-500">opening the desk…</p>}
          {commands.isError && (
            <p className="text-xs text-rose-400">
              The record is unreachable — the desk is blind until it returns.
            </p>
          )}
          {messages.length === 0 && !commands.isLoading && !send.isPending && !tail && (
            <div className="rounded-lg border border-dashed border-slate-700/70 bg-slate-900/40 p-3 text-xs leading-relaxed text-slate-400">
              <p className="font-medium text-slate-300">Nothing yet — the record is empty.</p>
              <p className="mt-1 text-slate-300">
                Try: <em>what&apos;s the status?</em> · <em>@Orchestrator, prepare a launch summary</em> ·{' '}
                <em>take a 15-minute break, everyone</em> · <em>move @Ada&apos;s task to @Bo</em> ·{' '}
                <em>goal: ship the beta by Friday</em>
              </p>
              <p className="mt-1 text-slate-500">
                A plain sentence is an order; “I have an idea:” floats an idea to be weighed;
                a question mark asks instead of ordering.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {tail && !tailLanded && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-100">
                  <div className="whitespace-pre-wrap">{tail.text}</div>
                  {!tail.reply && (
                    <div className="mt-1 text-[10px] text-emerald-300/70">the desk is reading…</div>
                  )}
                </div>
              </div>
              {tail.reply && (
                <Bubble
                  m={{
                    id: 'desk-tail',
                    role: 'orchestrator',
                    text: tail.reply.text,
                    mode: tail.reply.mode,
                    ok: tail.reply.ok,
                    actions: tail.reply.actions,
                    mentions: [],
                    at: null,
                  }}
                />
              )}
            </>
          )}
        <div ref={bottomRef} aria-hidden="true" className="h-px shrink-0" />
      </div>
    </Drawer>
  );
}

/**
 * The Captain's line — mention chips, the box, and the live mode preview. It lives in
 * the Drawer's footer: pinned to the bottom of the pane, on screen at all times,
 * whatever the transcript above does.
 */
function Composer({
  mention,
  draft,
  sending,
  mode,
  onDraft,
  onCaret,
  onMention,
  onSubmit,
}: {
  mention: MentionContext | null;
  draft: string;
  sending: boolean;
  mode: CommandMode;
  onDraft: (text: string) => void;
  onCaret: (at: number) => void;
  onMention: (agent: RosterAgent) => void;
  onSubmit: () => void;
}) {
  return (
    <>
      {mention && mention.matches.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {mention.matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onMention(a)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px]',
                i === 0
                  ? 'border-emerald-500/60 bg-emerald-950/50 text-emerald-200'
                  : 'border-slate-600 text-slate-300 hover:border-slate-400',
              )}
              title="tag this agent"
            >
              @{a.name}
              {a.role ? <span className="text-slate-500"> · {a.role}</span> : null}
            </button>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        rows={2}
        placeholder="Write to the company… (Enter sends · Shift+Enter for a new line)"
        aria-label="Command to the company"
        onChange={(e) => {
          onDraft(e.target.value);
          onCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={(e) => onCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
        onSelect={(e) => onCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="w-full resize-none rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
          <Badge tone={MODE_TONE[mode]}>{mode}</Badge>
          <span>{MODE_HINT[mode]}</span>
        </span>
        <Button size="xs" variant="primary" loading={sending} disabled={!draft.trim()} onClick={onSubmit}>
          Send
        </Button>
      </div>
    </>
  );
}

function Bubble({ m }: { m: CommandMessage }) {
  const captain = m.role === 'captain';
  return (
    <div className={cn('flex', captain ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg border px-3 py-2 text-xs leading-relaxed',
          captain
            ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-100'
            : m.ok === false
              ? 'border-rose-500/50 bg-rose-950/30 text-rose-100'
              : 'border-slate-700/70 bg-slate-900/80 text-slate-200',
        )}
      >
        {captain && m.mode && m.mode !== 'order' && (
          <div className="mb-1 text-[10px] uppercase tracking-wide text-emerald-300/70">
            {m.mode}
          </div>
        )}
        <div className="whitespace-pre-wrap">{m.text}</div>
        {!captain && m.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {m.actions.map((a, i) => (
              <span
                key={`${a.kind}-${i}`}
                className="rounded border border-slate-600/70 bg-slate-950/60 px-1.5 py-0.5 text-[10px] text-slate-400"
              >
                {actionLabel(a.kind)}
                {a.ref ? ` · ${String(a.ref).slice(0, 8)}` : ''}
              </span>
            ))}
          </div>
        )}
        <div className={cn('mt-1 text-[10px]', captain ? 'text-emerald-300/50' : 'text-slate-500')}>
          {captain ? 'the Captain' : m.ok === false ? 'the desk — not carried out' : 'the orchestrator'}
          {m.at ? ` · ${formatRelativeTime(m.at)}` : ''}
        </div>
      </div>
    </div>
  );
}
