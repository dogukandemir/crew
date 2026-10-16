import { describe, expect, it } from 'vitest';
import { BOARD_TABLE, M, VERDICT_COLOR, WINDOWS, buildHqWorld } from './hqScene';
import type { Hq } from '../../api/types';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const iso = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

function fixture(activity: Hq['activity']): Hq {
  return {
    company: { id: 'co1', name: 'Northwind Pictures', mission: 'm', budget_usd: 10, spend_usd: 3.8, spend_ratio: 0.38 },
    ceo: { id: 'c1', name: 'Vera', grade: 5 },
    executives: [
      { id: 'c1', name: 'Vera', role: 'ceo', title: 'Chief Executive Officer', function: 'executive' },
      { id: 'c2', name: 'Idris', role: 'cto', title: 'Chief Technology Officer', function: 'technology' },
      { id: 'c6', name: 'Ruth', role: 'cfo', title: 'Chief Financial Officer', function: 'finance' },
    ],
    board: [
      { id: 'b1', name: 'Eleanor Voss', role: 'chair', grade: 5 },
      { id: 'b2', name: 'Priya Raman', role: 'board_member', grade: 5 },
      { id: 'b3', name: 'Tom Okafor', role: 'board_member', grade: 5 },
    ],
    projects: [
      { id: 'p1', name: 'Market Brief', status: 'active', verdict: 'on_track', directive: 'keep going',
        spend_ratio: 0.38, completed: 3, failed: 0, open_tasks: 2,
        teams: [{ id: 'd1', name: 'Research', head_name: 'Ada', agents: 3 }] },
      { id: 'p2', name: 'Arctic Light', status: 'active', verdict: 'at_risk', directive: 'quality alarm',
        spend_ratio: 0.84, completed: 2, failed: 3, open_tasks: 4,
        teams: [{ id: 'd3', name: 'Production', head_name: 'Nils', agents: 4 }] },
    ],
    activity,
  };
}

describe('the HQ scene model', () => {
  it('lays out the board room, one office per executive and one pod per project', () => {
    const w = buildHqWorld(fixture([]), NOW);
    const kinds = w.rooms.map((r) => r.kind);
    expect(kinds.filter((k) => k === 'board')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'exec')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'pod')).toHaveLength(2);
    expect(w.people).toHaveLength(3 + 3 + 2);
  });

  it('walks the board and the CEO to the table while a session is open', () => {
    const w = buildHqWorld(
      fixture([
        { type: 'board.convened', at: iso(38), project_id: 'co1',
          payload: { topic: 'Q3 portfolio allocation' } },
        { type: 'council.position', at: iso(31), project_id: 'co1' },
      ]),
      NOW,
    );
    expect(w.inSession).toBe(true);
    expect(w.banner).toContain('Q3 portfolio allocation');
    const ids = w.stages.map((s) => s.personId);
    expect(ids).toEqual(expect.arrayContaining(['b1', 'b2', 'b3', 'c1']));
    for (const s of w.stages) {
      expect(s.path.length).toBeGreaterThanOrEqual(1);
      expect(s.path[s.path.length - 1]).toEqual(s.at);
    }
    // the CEO walks in; the board is already in the room and takes its chairs
    const ceoStage = w.stages.find((s) => s.personId === 'c1');
    expect(ceoStage!.path.length).toBeGreaterThanOrEqual(3);
    const chairStage = w.stages.find((s) => s.personId === 'b1');
    expect(BOARD_TABLE.seats).toContainEqual(chairStage?.at);
  });

  it('a session that has been decided is over, nobody is staged', () => {
    const w = buildHqWorld(
      fixture([
        { type: 'board.convened', at: iso(900), project_id: 'co1', payload: { topic: 'old' } },
        { type: 'decision.recorded', at: iso(120), project_id: 'co1' },
        { type: 'company.directive', at: iso(3600), project_id: 'p2' },
      ]),
      NOW,
    );
    expect(w.inSession).toBe(false);
    expect(w.stages).toHaveLength(0);
    expect(w.banner).toBeNull();
  });

  it('a fresh directive sends the project lead to the CEO office with the directive in hand', () => {
    const w = buildHqWorld(
      fixture([
        { type: 'company.directive', at: iso(140), project_id: 'p2',
          payload: { verdict: 'at_risk', directive: 'quality alarm: 3 of 5 tasks failed' } },
      ]),
      NOW,
    );
    const stage = w.stages.find((s) => s.personId === 'lead-p2');
    expect(stage).toBeDefined();
    expect(stage?.note).toContain('3 of 5');
    expect(w.banner).toContain('Arctic Light');
    const ceo = w.rooms.find((r) => r.id === 'exec-ceo');
    expect(stage!.at.x).toBeGreaterThan(ceo!.x);
    expect(stage!.at.y).toBeGreaterThan(ceo!.y + ceo!.d);
  });

  it('a fresh allocation gathers the non-CEO executives in the board room', () => {
    const w = buildHqWorld(
      fixture([
        { type: 'company.allocation.decided', at: iso(30), project_id: 'co1',
          payload: { allocations: [] } },
      ]),
      NOW,
    );
    expect(w.inSession).toBe(false);
    const ids = w.stages.map((s) => s.personId).sort();
    expect(ids).toEqual(['c2', 'c6']);
    expect(w.banner).toContain('allocat');
  });

  it('pod verdict colours come from the record, and M is the one metre', () => {
    const w = buildHqWorld(fixture([]), NOW);
    const p2pod = w.rooms.find((r) => r.id === 'pod-p2');
    expect(p2pod?.accent).toBe(VERDICT_COLOR.at_risk);
    const p1pod = w.rooms.find((r) => r.id === 'pod-p1');
    expect(p1pod?.accent).toBe(VERDICT_COLOR.on_track);
    expect(M).toBeGreaterThan(60);
    expect(WINDOWS.session).toBeLessThanOrEqual(600);
  });
});
