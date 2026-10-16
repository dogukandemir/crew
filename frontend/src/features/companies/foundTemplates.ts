/** The founding wizard's presets (ADR 0015): suggested names and goals only, every
 * field stays editable, and nothing is hidden: the preview shows exactly what the
 * call will create. */
export interface FoundTemplate {
  id: string;
  icon: string;
  title: string;
  blurb: string;
  companyName: string;
  mission: string;
  projectName: string;
  goal: string;
  companyBudgetUsd: number;
  projectBudgetUsd: number;
}

export const FOUND_TEMPLATES: FoundTemplate[] = [
  {
    id: 'product',
    icon: '⬢',
    title: 'Product launch',
    blurb: 'Ship a v1 and the page that announces it',
    companyName: 'Atlas Labs',
    mission: 'Ship small, ship often: turn a stated problem into products people use.',
    projectName: 'Launch',
    goal: 'Ship the first public release: v1 scope, landing page and a waitlist.',
    companyBudgetUsd: 10,
    projectBudgetUsd: 6,
  },
  {
    id: 'research',
    icon: '◎',
    title: 'Research desk',
    blurb: 'A sourced brief on a market you name',
    companyName: 'Field Notes',
    mission: 'Answer hard questions with sources, not vibes.',
    projectName: 'Market brief',
    goal: 'Produce a sourced market brief: the players, their pricing, and where the gap is.',
    companyBudgetUsd: 8,
    projectBudgetUsd: 5,
  },
  {
    id: 'content',
    icon: '✎',
    title: 'Content engine',
    blurb: 'A weekly publishing habit that holds',
    companyName: 'Signal House',
    mission: 'Publish work worth reading, on a schedule.',
    projectName: 'Publishing engine',
    goal: 'Run a weekly publishing engine: research, drafts, one edit pass, and distribution.',
    companyBudgetUsd: 6,
    projectBudgetUsd: 4,
  },
];

export function templateById(id: string): FoundTemplate {
  return FOUND_TEMPLATES.find((t) => t.id === id) ?? FOUND_TEMPLATES[0];
}
