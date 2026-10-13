/** The welcome checklist (ADR 0015): what the first hour with Crew looks like.
 * Every step reads the record — a provider with no key stays open, honestly; it
 * never marks a step done because the card was dismissed. */
export interface GettingStartedStep {
  key: 'provider' | 'company' | 'project' | 'run';
  label: string;
  hint: string;
  done: boolean;
}

export interface GettingStartedInput {
  demo?: boolean;
  /** From the onboarding state: true when a provider can actually run agents. */
  providerReady: boolean;
  companies: number;
  projects: number;
  /** Runs ever started across projects — the list endpoint carries the count. */
  runs: number;
}

export function gettingStartedSteps(input: GettingStartedInput): GettingStartedStep[] {
  const steps: GettingStartedStep[] = [
    {
      key: 'provider',
      label: 'Connect a model provider',
      hint: 'Required for Live agents. You can explore Demo without one.',
      done: input.providerReady,
    },
    {
      key: 'company',
      label: 'Found your company',
      hint: 'A company holds the portfolio; its CEO and board come with it.',
      done: input.companies > 0,
    },
    {
      key: 'project',
      label: 'Create a project under it',
      hint: 'A project is what the org actually works on.',
      done: input.projects > 0,
    },
    {
      key: 'run',
      label: 'Start the first run',
      hint: 'Give the goal — the Orchestrator forms the org and executes.',
      done: input.runs > 0,
    },
  ];
  return input.demo ? steps.filter(step => step.key !== 'provider') : steps;
}

export function allDone(steps: GettingStartedStep[]): boolean {
  return steps.every((s) => s.done);
}
