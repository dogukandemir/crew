import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Run } from '../../api/types';
import { useRuns } from '../../app/hooks';
import { Button } from '../../components/ui/Button';
import { Textarea } from '../../components/ui/Field';
import { useUi } from '../../stores/ui';

type Brief = {
  goal?: string;
  interpretation?: string;
  assumptions?: unknown;
  success_criteria?: unknown;
  questions?: unknown;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isGate(run: Run): boolean {
  return run.status === 'pending_confirmation' || run.status === 'pending_clarification';
}

/**
 * The human gate the run is waiting at (19 November 2026 QA). It lives above every
 * workspace view because the answer must stay reachable while the operator is looking
 * at the office or the tasks, not only on the Overview tab.
 */
export function RunGate({ projectId }: { projectId: string }) {
  const runs = useRuns(projectId);
  const qc = useQueryClient();
  const setToast = useUi((s) => s.setToast);
  const gate = runs.data?.find(isGate);
  const brief = (gate?.goal_brief ?? {}) as Brief;
  const questions = gate?.pending_questions?.length
    ? gate.pending_questions
    : strings(brief.questions);
  const [answers, setAnswers] = useState<string[]>([]);

  useEffect(() => {
    setAnswers(Array(questions.length).fill(''));
  }, [gate?.id, questions.length]);

  const answer = useMutation({
    mutationFn: ({ runId, values }: { runId: string; values: string[] }) => api.answerRun(runId, values),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Gate answered; the run continues.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err) => setToast({ kind: 'error', message: `Could not answer the gate: ${String(err)}` }),
  });

  const stop = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: () => {
      setToast({ kind: 'success', message: 'Run stopped; completed work is preserved.' });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err) => setToast({ kind: 'error', message: `Could not stop the run: ${String(err)}` }),
  });

  if (!gate) return null;

  const confirmation = gate.status === 'pending_confirmation';
  const busy = answer.isPending || stop.isPending;
  const missing = questions.some((_, index) => !answers[index]?.trim());

  return (
    <section
      className="border-b border-amber-500/30 bg-amber-950/20 px-3 py-2"
      aria-label={confirmation ? 'Goal confirmation needed' : 'Run questions'}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            {confirmation ? 'Goal confirmation needed' : 'The orchestrator has questions'}
          </p>
          <p className="text-xs text-slate-200">
            {brief.interpretation || brief.goal || gate.goal}
          </p>
          {confirmation && (
            <div className="grid gap-1 text-[11px] text-slate-400 sm:grid-cols-2">
              <p>
                <span className="text-slate-500">Success: </span>
                {strings(brief.success_criteria).join(' · ') || 'a verifiable artifact'}
              </p>
              <p>
                <span className="text-slate-500">Assumes: </span>
                {strings(brief.assumptions).join(' · ') || 'the goal text is the requirement'}
              </p>
            </div>
          )}
          {!confirmation && questions.map((question, index) => (
            <label key={question} className="block text-[11px] text-slate-300">
              {question}
              <Textarea
                aria-label={question}
                rows={2}
                className="mt-1 text-xs"
                value={answers[index] ?? ''}
                onChange={(event) => {
                  const next = [...answers];
                  next[index] = event.target.value;
                  setAnswers(next);
                }}
              />
            </label>
          ))}
          <p className="text-[10px] text-slate-500">
            Run {gate.id.slice(0, 8)} · {gate.mode ?? 'autonomous'} · this gate is recorded on the audit chain
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="primary"
            loading={answer.isPending}
            disabled={busy || (!confirmation && missing)}
            onClick={() => answer.mutate({
              runId: gate.id,
              values: confirmation ? ['Approved from the control room'] : answers,
            })}
          >
            {confirmation ? 'Approve & continue' : 'Send answers & continue'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            loading={stop.isPending}
            disabled={busy}
            onClick={() => stop.mutate(gate.id)}
          >
            Stop run
          </Button>
        </div>
      </div>
    </section>
  );
}
