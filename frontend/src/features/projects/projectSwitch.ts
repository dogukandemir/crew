import type { Company, Project } from '../../api/types';

export interface SwitchTarget {
  id: string;
  name: string;
  status?: string;
  current: boolean;
}

/**
 * The project switcher's model (pure, testable): which other projects this tab can
 * jump to. A member project offers its company's siblings, that is the hop people
 * keep looking for, and a company (HQ) tab offers its members. An unattached project
 * falls back to every other project. The current entry stays in the list, marked:
 * a menu that hides where you are makes you re-open your own tab to check.
 */
export function switchTargets(
  project: Pick<Project, 'id' | 'company_id' | 'kind' | 'name'>,
  companies: Company[] | undefined,
  projects: Project[] | undefined,
): SwitchTarget[] {
  const company =
    (project.company_id ? companies?.find((c) => c.id === project.company_id) : undefined) ??
    companies?.find((c) => c.id === project.id);
  if (company) {
    return company.projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      current: p.id === project.id,
    }));
  }
  return (projects ?? [])
    .filter((p) => p.kind !== 'company' && p.id !== project.id)
    .map((p) => ({ id: p.id, name: p.name, status: p.status, current: false }));
}
