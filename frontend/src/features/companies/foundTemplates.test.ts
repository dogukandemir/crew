import { describe, expect, it } from 'vitest';
import { FOUND_TEMPLATES, templateById } from './foundTemplates';

describe('founding templates', () => {
  it('every template is complete and its budgets cohere', () => {
    expect(FOUND_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const t of FOUND_TEMPLATES) {
      expect(t.companyName.length).toBeGreaterThan(0);
      expect(t.projectName.length).toBeGreaterThan(0);
      expect(t.goal.length).toBeGreaterThan(10);
      expect(t.mission.length).toBeGreaterThan(10);
      expect(t.companyBudgetUsd).toBeGreaterThanOrEqual(t.projectBudgetUsd);
      expect(t.projectBudgetUsd).toBeGreaterThan(0);
    }
  });

  it('templateById falls back to the first template', () => {
    expect(templateById('does-not-exist')).toBe(FOUND_TEMPLATES[0]);
    expect(templateById(FOUND_TEMPLATES[1].id)).toBe(FOUND_TEMPLATES[1]);
  });
});
