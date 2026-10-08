// The demo backend: Northwind Pictures, staged so the studio looks alive.
//
// This is not a contract fixture with canned strings — it is a SCENARIO. A real
// independent film studio (`Northwind Pictures`) with a board, a C-suite, three
// productions in different health, and one documentary (`Arctic Light`) whose org
// grows WHILE YOU WATCH: a hire into Post-Production at t+12, a brand-new
// Festivals & Press department at t+30, more hires after, a council at t+40 that
// actually convenes over the festival-package envelope and decides at t+90, and a
// post supervisor joining at t+78. It implements docs/11 §2 shapes.
//
// Two clocks, deliberately:
//   · the GROWTH clock (BEAT) starts at the first org request, not at boot — the
//     tab opens seconds after this process starts, and a clock that began at boot
//     would have finished hiring before anyone looked;
//   · the HISTORY clock is re-stamped per request (`ago`), because a snapshot
//     taken at boot ages out of the seconds-long activity windows and makes
//     working features look broken. Old history uses day-scale ages, so the
//     Events tab reads like a studio that has been at this for weeks.
import http from 'node:http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
};

// ── The working project: Arctic Light, a feature documentary ────────────────
const PROJECT = {
  id: 'p1',
  name: 'Arctic Light — feature documentary',
  goal: 'Land the locked cut and the festival package in time for the winter circuit.',
  description:
    'A 58-minute documentary on the Tromsø aurora observatory and the last winter of its founding director. Fifty hours of 16mm reels, three years of interviews, one deadline.',
  status: 'active',
  stage: 'EXECUTING',
  company_id: 'co1',
  created_at: '2026-09-01T09:00:00.000Z',
  updated_at: new Date().toISOString(),
  tags: ['documentary', 'festival-circuit'],
  budget_cap_micros: 10_000_000,
  spend_micros: 3_800_000,
  pending_approvals: 1,
  org_size: 11,
  tasks_done: 5,
  tasks_total: 10,
  settings: {
    autonomous_intake: false,
    require_goal_confirmation: true,
    require_human_verification: false,
    max_agents: 24,
    max_departments: 6,
    max_senior_ratio: 0.5,
    auto_hire: true,
    layoff_idle_days: 14,
    budget_warning_pct: 0.8,
    egress_allow: ['archive.nordicfilm.no', 'api.deepseek.com', 'submissions.sundance.org', 'berlinale.de'],
    model_tiers: { reasoning: 'deepseek/deepseek-v4-pro', standard: 'deepseek/deepseek-flash' },
  },
};

// ── The schedule ────────────────────────────────────────────────────────────
// t+12 Max (assistant editor) joins Post-Production — an existing room gains a desk;
// t+30 a hire into nothing opens Festivals & Press — a brand-new room on the canvas;
// t+48, t+64 the department grows; t+40 the escalated festival package puts a COUNCIL
// in the meeting room (it sits until the decision at t+90); t+78 the post supervisor
// joins. The frontend keeps each room's slot, so nothing already built moves.
const BEAT = { hire: 12, dept: 30, second: 48, third: 64, council: 40, post: 78, decide: 90 };
let T0 = null;
const elapsed = () => {
  if (T0 === null) T0 = Date.now();
  return (Date.now() - T0) / 1000;
};
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

// ── The cast ────────────────────────────────────────────────────────────────
// Real people, real jobs: everyone below has a mission you could read in a call
// sheet, and a score history that matches the story (the QC agent is on
// probation because the reel-3 drift slipped past twice; the lead editor earned
// a promotion on the v3 assembly).
const mk = (id, name, role, grade, state, score, dept, over = {}) => ({
  id, kind: 'agent', project_id: 'p1', department_id: dept, squad_id: null, manager_id: null,
  name, role, grade, state,
  mission: '',
  autonomy: 'bounded', model_tier: 'standard', model_id: 'deepseek-flash',
  token_cap_per_step: 12000, spend_today_micros: 240_000, spend_micros: 200_000,
  score, score_confidence: 0.8, evidence_count: 7, score_trend: [0.5, 0.6, score],
  success_rate: 0.82, tasks_done: 4, tasks_failed: 0, penalty_count: 0,
  skills: [],
  ...over,
});

const A = {
  a0: mk('a0', 'Alex Moreau', 'Orchestrator', 5, 'idle', 0.9, null, {
    mission: 'Runs the production: plans the work, staffs the crew, owns the envelope.',
    model_tier: 'reasoning', model_id: 'deepseek-v4-pro', spend_micros: 400_000,
    skills: [{ skill_id: 'sk-orch', label: 'orchestration', proficiency: 0.93 }, { skill_id: 'sk-plan', label: 'planning', proficiency: 0.88 }],
  }),
  a1: mk('a1', 'Ada Osei', 'Story Researcher', 3, 'busy', 0.84, 'd1', {
    mission: 'Track down every frame and every paper the story needs — and check every claim.',
    manager_id: 'a0', squad_id: 's1', spend_micros: 900_000, tasks_done: 6,
    skills: [{ skill_id: 'sk-arch', label: 'archival-research', proficiency: 0.85 }, { skill_id: 'sk-int', label: 'interviewing', proficiency: 0.7 }],
  }),
  a2: mk('a2', 'Bo Rasmussen', 'Archive Producer', 2, 'busy', 0.74, 'd1', {
    mission: 'Owns the archive: licences, ingests, and the expiry dates nobody remembers.',
    manager_id: 'a1', squad_id: 's1', spend_micros: 300_000, tasks_done: 3,
    skills: [{ skill_id: 'sk-lic', label: 'archive-licensing', proficiency: 0.8 }, { skill_id: 'sk-ing', label: 'media-ingest', proficiency: 0.65 }],
  }),
  a3: mk('a3', 'Cleo Marchetti', 'Lead Editor', 4, 'busy', 0.91, 'd2', {
    mission: 'Holds the cut: structure, rhythm, and the two scenes the third act is missing.',
    manager_id: 'a0', spend_micros: 1_400_000, tasks_done: 9,
    score_trend: [0.6, 0.7, 0.8, 0.91], model_tier: 'reasoning', model_id: 'deepseek-v4-pro',
    skills: [{ skill_id: 'sk-edit', label: 'picture-editing', proficiency: 0.92 }, { skill_id: 'sk-struct', label: 'story-structure', proficiency: 0.78 }],
  }),
  a4: mk('a4', 'Dev Singh', 'QC & Continuity', 2, 'probation', 0.42, 'd2', {
    mission: 'Verifies before anything ships: drift, timecode, and the cinema checklist.',
    manager_id: 'a3', spend_micros: 200_000, tasks_done: 2, tasks_failed: 2,
    score_trend: [0.7, 0.6, 0.42],
    skills: [{ skill_id: 'sk-qc', label: 'qc-continuity', proficiency: 0.55 }, { skill_id: 'sk-dcp', label: 'dcp-prep', proficiency: 0.5 }],
  }),
  a5: mk('a5', 'Iris Nakamura', 'Sound Designer', 3, 'busy', 0.66, 'd3', {
    mission: 'The mix: temp cues first, the full score once the cut locks.',
    manager_id: 'a0', spend_micros: 200_000, tasks_done: 4,
    skills: [{ skill_id: 'sk-score', label: 'score-supervision', proficiency: 0.74 }, { skill_id: 'sk-sd', label: 'sound-design', proficiency: 0.7 }],
  }),
  // Hired while you watch.
  a6: mk('a6', 'Max Bergström', 'Assistant Editor', 2, 'busy', 0.55, 'd2', {
    mission: 'Keeps media moving: selects, syncs, and the trailer cutdown.',
    manager_id: 'a3', spend_micros: 60_000, tasks_done: 1,
    skills: [{ skill_id: 'sk-assist', label: 'assistant-editing', proficiency: 0.6 }, { skill_id: 'sk-media', label: 'media-management', proficiency: 0.55 }],
  }),
  a7: mk('a7', 'Zoe Delacroix', 'Festival Strategist', 3, 'idle', 0.6, 'd4', {
    mission: 'Where the film goes first: deadlines, juries, and the campaign calendar.',
    manager_id: 'a0', spend_micros: 40_000,
    skills: [{ skill_id: 'sk-fest', label: 'festival-strategy', proficiency: 0.72 }, { skill_id: 'sk-aud', label: 'audience-research', proficiency: 0.66 }],
  }),
  a8: mk('a8', 'Nils Åkesson', 'Trailer Editor', 2, 'idle', 0.5, 'd4', {
    mission: 'The 60-second argument: a cutdown that sells the film without spoiling it.',
    manager_id: 'a7', spend_micros: 30_000,
    skills: [{ skill_id: 'sk-trail', label: 'trailer-editing', proficiency: 0.68 }, { skill_id: 'sk-mot', label: 'motion-graphics', proficiency: 0.6 }],
  }),
  a9: mk('a9', 'Rae Patel', 'Press & Publicity', 2, 'idle', 0.5, 'd4', {
    mission: 'The press kit, the stills, and the journalists who covered arctic docs before.',
    manager_id: 'a7', spend_micros: 30_000,
    skills: [{ skill_id: 'sk-press', label: 'press', proficiency: 0.7 }, { skill_id: 'sk-pub', label: 'publicity', proficiency: 0.65 }],
  }),
  // t+78: the post supervisor joins the department that keeps growing.
  a10: mk('a10', 'Maria Solberg', 'Post-production Supervisor', 4, 'idle', 0.79, 'd2', {
    mission: 'Schedules post: facility, render windows, and the delivery checklist.',
    manager_id: 'a0', spend_micros: 20_000,
    skills: [{ skill_id: 'sk-post', label: 'post-supervision', proficiency: 0.8 }, { skill_id: 'sk-sched', label: 'scheduling', proficiency: 0.75 }],
  }),
};

const DEPT_NAMES = { d1: 'Development', d2: 'Post-Production', d3: 'Sound & Music', d4: 'Festivals & Press' };
const squadNode = (children) => ({
  id: 's1', kind: 'squad', name: 'Story desk', state: 'active', spend_micros: 900_000,
  open_tasks: 1, department_id: 'd1', children,
});
const deptNode = (id, children, over = {}) => ({
  id, kind: 'department', name: DEPT_NAMES[id], state: 'active', spend_micros: 1_200_000,
  score: 0.78, open_tasks: 1, budget_envelope_micros: 4_000_000, success_rate: 0.82,
  department_id: null, children, ...over,
});

/**
 * The org AS IT STANDS RIGHT NOW — a function of the clock, evaluated per request.
 */
const orgNow = () => {
  const t = elapsed();
  const children = [A.a0, deptNode('d1', [squadNode([A.a1, A.a2])], { mission: 'story, rights, archive' })];
  children.push(deptNode('d2', t >= BEAT.hire ? [A.a3, A.a4, A.a6] : [A.a3, A.a4], { mission: 'cut, colour, delivery' }));
  children.push(deptNode('d3', [A.a5], { mission: 'score and mix' }));
  if (t >= BEAT.dept) {
    const festivals = [A.a7];
    if (t >= BEAT.second) festivals.push(A.a8);
    if (t >= BEAT.third) festivals.push(A.a9);
    children.push(deptNode('d4', festivals, { mission: 'the festival campaign' }));
  }
  // t+78: post keeps growing — the supervisor joins the busiest room.
  if (t >= BEAT.post) children[2].children.push(A.a10);
  return {
    root: {
      id: 'p1', kind: 'project', name: PROJECT.name, state: 'active', spend_micros: 3_800_000,
      score: 0.8, open_tasks: 3, children,
    },
  };
};

/**
 * The tasks AS THEY STAND RIGHT NOW. After the council decides (t+90) the festival
 * package is unstuck: `escalated` becomes `running`. Before that it stays escalated —
 * the escalation is the reason the council exists, and a task that resolves before
 * its own decision would be a mock lying about its own story.
 */
const tasksNow = () => {
  const t = elapsed();
  const t3 =
    t >= BEAT.decide
      ? { id: 't3', project_id: 'p1', title: 'Festival submission package (DCP + press kit)', state: 'running', assignee_agent_id: 'a4', cost_micros: 120_000, attempts: 1, effort: 'S' }
      : { id: 't3', project_id: 'p1', title: 'Festival submission package (DCP + press kit)', state: 'escalated', assignee_agent_id: 'a4', cost_micros: 120_000, attempts: 1, effort: 'S', escalation_reason: 'the mix and the DCP render run past the post envelope — a slate-level call', escalated_to: 'a0' };
  return [
    { id: 't2', project_id: 'p1', title: 'Rough cut v4 — third-act restructure', state: 'running', assignee_agent_id: 'a3', cost_micros: 610_000, attempts: 2, effort: 'L' },
    t3,
    { id: 't4', project_id: 'p1', title: 'Fact-check the narration script (v3)', state: 'verifying', assignee_agent_id: 'a1', cost_micros: 90_000, attempts: 1, effort: 'M' },
    { id: 't5', project_id: 'p1', title: 'Score: temp cues for the 58-minute structure', state: 'running', assignee_agent_id: 'a5', cost_micros: 150_000, attempts: 1, effort: 'M' },
    { id: 't6', project_id: 'p1', title: 'Trailer cutdown (60s) for the festival market', state: 'running', assignee_agent_id: 'a6', cost_micros: 110_000, attempts: 1, effort: 'M' },
    { id: 't1', project_id: 'p1', title: 'Clear the archival licences (14 clips)', state: 'completed', assignee_agent_id: 'a2', cost_micros: 420_000, attempts: 1, effort: 'M', acceptance_criteria: ['all 14 clips logged with expiry dates', 'paperwork filed'] },
    { id: 't7', project_id: 'p1', title: 'Assembly v3 → rough cut', state: 'completed', assignee_agent_id: 'a3', cost_micros: 980_000, attempts: 2, effort: 'L' },
    { id: 't8', project_id: 'p1', title: 'Story research: observatory interviews', state: 'completed', assignee_agent_id: 'a1', cost_micros: 640_000, attempts: 1, effort: 'M' },
    { id: 't9', project_id: 'p1', title: 'Archive ingest: 40h of 16mm reels digitised', state: 'completed', assignee_agent_id: 'a2', cost_micros: 520_000, attempts: 1, effort: 'L' },
    { id: 't10', project_id: 'p1', title: 'Screening notes: test cut at the Nordic Doc Lab', state: 'completed', assignee_agent_id: 'a1', cost_micros: 80_000, attempts: 1, effort: 'S' },
  ];
};

/** Full details for one task (the drawer opens whichever card you click). */
const TASK_META = {
  t2: { description: 'Rebuild the third act around the two scenes shot last month — the storm sequence and the director\'s final interview — and get the cut under 62 minutes with tempo intact.', required_skills: ['picture-editing', 'story-structure'], depends_on: ['t7'], output_contract: { format: 'edl + screeners', duration_min: 58 }, verification: null, rewards: [] },
  t3: { description: 'DCP master at 2K flat, cinema QC checklist passed, and a press kit: six stills, director\'s statement, full credits.', required_skills: ['dcp-prep', 'qc-continuity'], depends_on: ['t2'], output_contract: { format: 'dcp + pdf press kit' }, verification: null, rewards: [] },
  t4: { description: 'Every claim in narration v3 needs a source note in the fact sheet — start with the observatory chronology and the Sámi joik attribution.', required_skills: ['archival-research'], depends_on: [], output_contract: { format: 'fact-sheet.md' }, verification: { id: 'v4', task_id: 't4', verdict: 'running', method: 'deterministic', checks: [{ name: 'sources cited', ok: true }, { name: 'chronology consistent', ok: true }, { name: 'attribution cleared', ok: false }], confidence: 0.8, created_at: ago(180) }, rewards: [] },
  t5: { description: 'Temp cues under the 58-minute structure so the council can hear the film as cut. Final score only after the picture lock.', required_skills: ['score-supervision'], depends_on: [], output_contract: { format: 'session + stems' }, verification: null, rewards: [] },
  t6: { description: 'A 60-second cutdown from reel 3 selects — the observatory at night, the director\'s line about the last winter, no spoilers.', required_skills: ['trailer-editing'], depends_on: [], output_contract: { format: 'prores 422', duration_sec: 60 }, verification: null, rewards: [] },
  t1: { description: 'Clear and log every third-party clip: the NRK news reel, the foundation\'s 16mm, the two private collections.', required_skills: ['archive-licensing'], depends_on: [], output_contract: { format: 'licence-sheet.csv' }, verification: { id: 'v1', task_id: 't1', verdict: 'pass', method: 'deterministic', checks: [{ name: '14/14 clips logged', ok: true }, { name: 'expiry dates present', ok: true }], confidence: 0.95, created_at: daysAgo(1) }, rewards: [] },
  t7: { description: 'First full assembly of the Tromsø material at 74 minutes — the cut every later note refers to.', required_skills: ['picture-editing'], depends_on: [], output_contract: { format: 'edl + screeners' }, verification: { id: 'v7', task_id: 't7', verdict: 'pass', method: 'hybrid', checks: [{ name: 'runtime within plan', ok: true }, { name: 'continuity clean', ok: true }], confidence: 0.9, created_at: daysAgo(2) }, rewards: [] },
  t8: { description: 'Three years of interviews condensed into a source log: who said what, where, and under which release.', required_skills: ['interviewing'], depends_on: [], output_contract: { format: 'interview-log.md' }, verification: { id: 'v8', task_id: 't8', verdict: 'pass', method: 'deterministic', checks: [{ name: 'every subject released', ok: true }], confidence: 0.93, created_at: daysAgo(3) }, rewards: [] },
  t9: { description: 'Forty hours of 16mm scanned at 4K with audio sync pass — the spine of the third act.', required_skills: ['media-ingest'], depends_on: [], output_contract: { format: 'prores 4444' }, verification: { id: 'v9', task_id: 't9', verdict: 'pass', method: 'hybrid', checks: [{ name: '40h accounted for', ok: true }, { name: 'sync drift < 1 frame', ok: true }], confidence: 0.88, created_at: daysAgo(4) }, rewards: [] },
  t10: { description: 'Notes from the test cut screening at the Doc Lab — what lands, what sits.', required_skills: ['audience-research'], depends_on: [], output_contract: { format: 'notes.md' }, verification: { id: 'v10', task_id: 't10', verdict: 'pass', method: 'deterministic', checks: [{ name: '18 cards transcribed', ok: true }], confidence: 0.9, created_at: daysAgo(1) }, rewards: [] },
};

// Artifacts per task, so opening different cards shows different shelves.
const ARTIFACTS = {
  t1: [{ id: 'ar1', project_id: 'p1', task_id: 't1', kind: 'file', path: 'licence-sheet.csv', bytes: 21_400, trust: 'verified', created_at: daysAgo(1) }],
  t2: [{ id: 'ar2', project_id: 'p1', task_id: 't2', kind: 'file', path: 'assembly_v4.edl', bytes: 412_000, trust: 'draft', created_at: ago(5400) }],
  t7: [{ id: 'ar4', project_id: 'p1', task_id: 't7', kind: 'file', path: 'assembly_v3.edl', bytes: 398_000, trust: 'verified', created_at: daysAgo(2) }],
  t8: [{ id: 'ar3', project_id: 'p1', task_id: 't8', kind: 'file', path: 'interview-log.md', bytes: 38_100, trust: 'verified', created_at: daysAgo(3) }],
  t10: [{ id: 'ar5', project_id: 'p1', task_id: 't10', kind: 'file', path: 'screening-notes.md', bytes: 9_800, trust: 'verified', created_at: daysAgo(1) }],
};

// ── The live tape ───────────────────────────────────────────────────────────
// Freshly-timestamped events so every office pose has something real to render.
// The last column is the event payload, which is what the office reads: a name
// to walk to, the words to put in the bubble, and whether it is work or chat.
// The clock is read per request — a snapshot taken at boot ages out of the
// seconds-long activity windows and makes working features look broken.
const RAW_EVENTS = [
  ['a3', 'agent.thought', 'drafting the new third-act assembly', 1.5],
  ['a1', 'agent.tool.call', 'tool: web.search("aurora observatory foundation history")', 2],
  ['a4', 'verify.started', 'verifying: reel 3 drift fix', 3],
  ['a0', 'agent.thought', 'two rooms are close to their envelope — one call has to happen', 4],
  ['a4', 'policy.approval.requested', 'approval needed: upload to submissions.sundance.org', 5],
  // A report upward: goes to this agent's manager, and walks there.
  ['a3', 'agent.message', 'report to manager: assembly v4 is 80% through the third act', -4,
    { to: 'manager', text: 'assembly v4 is 80% through the third act — one scene to go', direction: 'up' }],
  ['a3', 'llm.response', 'llm: 1.9k tokens, 0.41s', 6],
  ['a1', 'agent.thought', 'the foundation\'s own 16mm reels are the spine of the third act', 7],
  ['a4', 'verify.check', 'check passed: drift within tolerance (0.4 frames)', 8],
  ['a0', 'agent.delegated', 'delegated "festival package" to Post-Production', 10],
  ['a1', 'agent.tool.call', 'tool: read_file("narration_v3.md")', 12],
  ['a2', 'task.completed', 'completed: Clear the archival licences (14 clips)', 14],
  ['a4', 'task.escalated', 'escalated: Festival submission package', 16],
  // Water-cooler talk: between two people, about nothing either is working on.
  ['a5', 'agent.message', 'message to Cleo: the espresso machine is a war crime', -9,
    { to: 'Cleo', text: 'the espresso machine is a war crime', direction: 'side', informal: true }],
  // Office talk between two people who are NOT on that task. The story's own record
  // says the festival package failed QC twice (the task.escalated above), so the
  // rumour is allowed to say exactly that — no more. Cleo is on the cut, not the
  // package; Dev (who escalated it) is deliberately not a mouth here.
  ['a5', 'agent.gossip', 'Iris ⟷ Cleo: the festival package failed QC twice', -14,
    { informal: true, topic: 'failing_work', to: 'Cleo', to_name: 'Cleo', from_name: 'Iris',
      text: 'did you hear — the festival package failed QC twice and nobody has said why?',
      basis: ['task:t3'] }],
  ['a3', 'agent.thought', 'the third act wants one more beat before the coda', 18],
  ['a4', 'agent.thought', 'prepping the DCP checklist for the package', 20],
  ['a0', 'budget.spent', 'budget: $0.61 settled to Post-Production', 24],
  ['a1', 'agent.tool.call', 'tool: read_file("interview-log.md")', 28],
  // A colleague asking a colleague for something: same department, live task.
  ['a2', 'agent.message', 'message to Ada: licence sheet is in the shared folder', -12,
    { to: 'Ada', text: 'licence sheet is in the shared folder — sanity-check the expiry dates?', direction: 'out' }],
  // The studio has a history, not just a present: day-scale entries so the Events
  // tab reads like a production in its fourth week.
  ['a0', 'run.started', 'run completed: assembly cycle — rough cut v4', 95_000],
  ['a1', 'task.completed', 'completed: Story research — observatory interviews', 88_000],
  ['a7', 'agent.hired', 'hired: Zoe Delacroix — Festival Strategist', 172_800],
  ['a0', 'run.started', 'run started: assemble rough cut v4 from the Tromsø selects', 99_000],
  ['a2', 'task.completed', 'completed: Archive ingest — 40h of 16mm digitised', 260_000],
  ['a1', 'task.completed', 'completed: Screening notes — test cut at the Nordic Doc Lab', 90_000],
];

// Built per request so the timestamps stay fresh.
const buildEvents = () => {
  // A hire has to DO something the moment they exist, or the office seats them and
  // they stand there: their first event is what the character's bubble reads.
  const hires = [];
  const t = elapsed();
  if (t >= BEAT.hire) hires.push(['a6', 'agent.thought', 'cutting the 60s trailer from reel 3 selects', 2]);
  if (t >= BEAT.dept) hires.push(['a7', 'agent.thought', 'first day: mapping the winter circuit deadlines', 3]);
  if (t >= BEAT.second) hires.push(['a8', 'agent.tool.call', 'tool: write_file("trailer-cutdown.plan")', 1.5]);
  if (t >= BEAT.third) hires.push(['a9', 'agent.tool.call', 'tool: web.search("journalists arctic documentary")', 1]);
  if (t >= BEAT.post) hires.push(['a10', 'agent.thought', 'taking post schedule: render windows booked through December', 2]);

  // The office's whisper network: same worry, three mouths, each grounded in what the
  // story already shows (the festival package that keeps failing QC). At t+90 the
  // topic has enough mouths to surface as a concern the company has to look at.
  const whispers = [];
  if (t >= BEAT.second) {
    whispers.push(['a7', 'agent.gossip', 'Zoe ⟷ Nils: the envelope ask is really about the package', 2,
      { informal: true, topic: 'failing_work', to: 'Nils', to_name: 'Nils', from_name: 'Zoe',
        text: 'they are asking Alex for a bigger mix envelope — for a package that keeps failing QC',
        basis: ['task:t3'] }]);
  }
  if (t >= BEAT.third) {
    whispers.push(['a8', 'agent.gossip', 'Nils ⟷ Rae: three mouths, one worry', 2,
      { informal: true, topic: 'failing_work', to: 'Rae', to_name: 'Rae', from_name: 'Nils',
        text: 'Zoe says the council is really about the package that keeps failing — watch the room',
        basis: ['task:t3'] }]);
  }
  if (t >= BEAT.decide) {
    whispers.push(['a0', 'gossip.surfaced', 'concern surfaced: failing_work', 4,
      { topic: 'failing_work', mouths: 3, basis: ['task:t3'] }]);
  }

  // The council. From t+40 the escalated festival package has the panel in the meeting
  // room: `council.convened` opens the sitting, each member's `council.position` is
  // what makes them a MEMBER (the floor reads the panel off these), and a couple of
  // messages between them give the room something to say. At t+90 `decision.recorded`
  // closes it. The sitting's record AGES after the decision instead of being dropped:
  // the frontend's log dedupes by id, and an array that loses entries in the middle
  // re-numbers everything after them — a re-indexed event reads as a duplicate and is
  // silently discarded, which is exactly how a decision once went missing.
  const council = [];
  if (t >= BEAT.council) {
    const past = t >= BEAT.decide ? t - BEAT.decide + 30 : 0;
    council.push([
      'a0',
      'council.convened',
      'council convened: submit the 52-minute cut now, or extend for the Berlinale window?',
      6 + past,
      {
        session_id: 'c1',
        question: 'Submit the 52-minute cut to Sundance now, or extend to 58 minutes and take the Berlinale window?',
        options: [
          { id: 'o1', label: 'Submit the 52\' cut now, on the current envelope' },
          { id: 'o2', label: 'Extend to 58\' for the Berlinale window, with a raised mix envelope' },
        ],
        criteria: ['correctness', 'cost', 'risk', 'reversibility'],
        rationale: 'Dev escalated the festival package: the mix and DCP render are above the post envelope',
      },
    ]);
    council.push(
      ['a1', 'council.position', 'Ada on extend to 58\'', 5 + past,
        { session_id: 'c1', agent_id: 'a1', round: 1, option_id: 'o2', claim: 'the third act needs the two scenes already shot — the 52-minute cut reads thin', confidence: 0.7, risks: ['two more weeks of edit'] }],
      ['a2', 'council.position', 'Bo on extend to 58\'', 4.5 + past,
        { session_id: 'c1', agent_id: 'a2', round: 1, option_id: 'o2', claim: 'two archive licences expire in March — the Berlinale window keeps them in scope', confidence: 0.65, risks: ['licence renewals cost'] }],
      ['a4', 'council.position', 'Dev on submit now', 4 + past,
        { session_id: 'c1', agent_id: 'a4', round: 1, option_id: 'o1', claim: 'the pipeline is ready today; QC coverage on an extended cut is thin', confidence: 0.4, risks: ['verification coverage is thin'] }],
      ['a7', 'council.position', 'Zoe on extend to 58\'', 3.5 + past,
        { session_id: 'c1', agent_id: 'a7', round: 1, option_id: 'o2', claim: 'Sundance gives us eight weeks; the Berlinale gives us four months and a stronger slot', confidence: 0.68, risks: ['the raised envelope needs sign-off'] }],
      ['a0', 'council.position', 'Alex on extend to 58\'', 3 + past,
        { session_id: 'c1', agent_id: 'a0', round: 2, option_id: 'o2', claim: 'the dissent is about verification depth, not the window — extending answers both', confidence: 0.74, risks: [] }],
      ['a4', 'agent.message', 'message to Zoe: who signs the raised mix envelope?', 2.5 + past,
        { to: 'Zoe', text: 'who signs off the raised mix envelope if we extend?', direction: 'side' }],
      ['a7', 'agent.message', 'message to Dev: Alex can, above the envelope', 2 + past,
        { to: 'Dev', text: 'Alex can, anything above the envelope — that is why we are all in this room', direction: 'side' }],
    );
  }
  if (t >= BEAT.decide) {
    council.push(
      ['a0', 'decision.recorded', 'council decided: extend to 58\' for the Berlinale window', 1,
        { decision_id: 'dc1', chosen_option: 'o2' }],
      ['a0', 'agent.message', 'message to Dev: unstuck — extend to 58\', new assembly by Friday', 1.5,
        { to: 'Dev', text: 'unstuck: extend to 58\', Berlinale window — new assembly by Friday', direction: 'down' }],
    );
  }

  return [...(() => {
    // Two raw events only make sense while the festival package is stuck: the approval
    // request and the escalation itself. Once the council has decided they are history,
    // and history — in this mock — means an old timestamp, not a fresh one that makes a
    // granted approval look pending forever.
    const t2 = elapsed();
    if (t2 < BEAT.decide) return RAW_EVENTS;
    return RAW_EVENTS.map((e) =>
      e[1] === 'policy.approval.requested' || e[1] === 'task.escalated'
        ? [e[0], e[1], e[2], 100 + (t2 - BEAT.decide), ...e.slice(4)]
        : e,
    );
  })(), ...hires, ...whispers, ...council].map((entry, i) => {
    const [agent_id, type, title, secAgo, payload] = entry;
    return {
    id: `e${i}`,
    project_id: 'p1',
    seq: i + 1,
    ts: ago(secAgo),
    type,
    severity: type === 'task.escalated' ? 'warning' : 'info',
    title,
    summary: null,
    payload: payload ?? { i, title, agent: agent_id },
    agent_id,
    task_id: type.startsWith('task.') || type === 'verify.started' || type === 'verify.check' ? 't3' : null,
    run_id: 'r2',
    trace_id: 'tr-0001',
    span_id: `sp-${i}`,
    actor: `agent:${agent_id}`,
    cost_micros: type.startsWith('llm') ? 24_000 : 4_000,
    tokens_in: 900,
    tokens_out: 300,
    duration_ms: 640,
    };
  });
};

/** Only the agents who have actually been hired are addressable. */
const agentsNow = () => {
  const out = {};
  (function collect(node) {
    if (node.kind === 'agent') out[node.id] = node;
    (node.children ?? []).forEach(collect);
  })(orgNow().root);
  return out;
};

const paged = (items) => ({ items, next_cursor: null, total: items.length });

// ── The company (ADR 0009/0011): a headquarters with a board, C-level and 3 projects ──
const DIRECTORS = [
  { id: 'b1', name: 'Eleanor Voss', role: 'chair', grade: 5,
    bio: 'Chairs the slate reviews. Twenty years cutting documentaries for NRK and BBC Storyville.' },
  { id: 'b2', name: 'Priya Raman', role: 'board_member', grade: 5,
    bio: 'Meridian Capital. Reads the numbers before the room does.' },
  { id: 'b3', name: 'Tom Okafor', role: 'board_member', grade: 5,
    bio: 'Producer, forty features. Knows what a film costs before the estimate is written.' },
];
const EXECUTIVES = [
  { id: 'c1', name: 'Vera Lindqvist', role: 'ceo', title: 'Chief Executive Officer', function: 'executive',
    bio: 'Founded Northwind after a decade in public broadcasting. Signs the slate.' },
  { id: 'c2', name: 'Idris Farah', role: 'cto', title: 'Chief Technology Officer', function: 'technology',
    bio: 'Owns the pipeline: archive ingest, edit systems, the render farm.' },
  { id: 'c3', name: 'Camille Laurent', role: 'cmo', title: 'Chief Marketing Officer', function: 'market',
    bio: 'Festival strategy, press, and the audience campaigns.' },
  { id: 'c4', name: 'Selma Aydın', role: 'cpo', title: 'Chief Production Officer', function: 'product',
    bio: 'The slate\'s productions, from greenlight to delivery.' },
  { id: 'c5', name: 'Marcus Whitfield', role: 'coo', title: 'Chief Operations Officer', function: 'operations',
    bio: 'Schedules, vendors, and keeping the studio honest on spend.' },
  { id: 'c6', name: 'Ruth Almeida', role: 'cfo', title: 'Chief Financial Officer', function: 'finance',
    bio: 'The books. The one who reads the overruns first.' },
];
const MEMBERS = [
  { id: 'p1', name: PROJECT.name, status: 'active', verdict: 'on_track', spend_ratio: 0.38,
    directive: 'keep going: 38% of the envelope used, the cut is in week four',
    completed: 5, failed: 0, open_tasks: 5,
    teams: [{ id: 'd1', name: 'Development', head_name: 'Ada Osei', agents: 2 },
            { id: 'd2', name: 'Post-Production', head_name: 'Cleo Marchetti', agents: 4 },
            { id: 'd3', name: 'Sound & Music', head_name: 'Iris Nakamura', agents: 1 },
            { id: 'd4', name: 'Festivals & Press', head_name: 'Zoe Delacroix', agents: 3 }] },
  { id: 'p2', name: 'Moonbase — kids series, season 2', status: 'active', verdict: 'at_risk', spend_ratio: 0.84,
    directive: 'quality alarm: 2 of the last 5 episode renders failed QC — pair the animation lead with script on the dialogue-sync failure',
    completed: 2, failed: 3, open_tasks: 4,
    teams: [{ id: 'd21', name: 'Animation', head_name: 'Tobias Reyes', agents: 4 },
            { id: 'd22', name: 'Script', head_name: 'Hana Kobayashi', agents: 2 }] },
  { id: 'p3', name: 'Harbor House — limited series', status: 'paused', verdict: 'stop', spend_ratio: 0.97,
    directive: 'stop and fold: the pilot overran its envelope by 34% — no new spend without a fresh rationale',
    completed: 6, failed: 1, open_tasks: 0,
    teams: [{ id: 'd31', name: 'Casting', head_name: 'Marta Silva', agents: 2 },
            { id: 'd32', name: 'Production', head_name: 'Jonas Berg', agents: 3 }] },
];
const COMPANY = () => ({
  id: 'co1', name: 'Northwind Pictures',
  mission: 'Deliver the winter slate — and keep every production honest.',
  status: 'active',
  budget_usd: 10, spend_usd: 3.8, spend_ratio: 0.38,
  ceo: { id: 'c1', name: 'Vera Lindqvist', grade: 5 },
  board: DIRECTORS,
  roster: EXECUTIVES.map((e) => ({ id: e.id, name: e.name, role: e.role, grade: 5 })),
  projects: MEMBERS.map((m) => ({ id: m.id, name: m.name, status: m.status, spend_ratio: m.spend_ratio })),
  last_review: {
    ts: ago(12),
    projects: MEMBERS.length,
    verdicts: MEMBERS.map((m) => ({ project_id: m.id, name: m.name, verdict: m.verdict,
                                    directive: m.directive,
                                    basis: { spend_ratio: m.spend_ratio, completed: m.completed,
                                             failed: m.failed, attempted: m.completed + m.failed } })),
    counts: { on_track: 1, at_risk: 1, stop: 1 },
  },
});

// ── The HQ floor (ADR 0011): the whole company on one screen ────────────────
const HQ = () => ({
  company: {
    id: 'co1', name: 'Northwind Pictures', mission: 'Deliver the winter slate — and keep every production honest.',
    budget_usd: 10, spend_usd: 3.8, spend_ratio: 0.38,
  },
  ceo: { id: 'c1', name: 'Vera Lindqvist', grade: 5 },
  executives: EXECUTIVES,
  board: DIRECTORS,
  projects: MEMBERS.map((m) => ({ ...m, last_at: ago(m.verdict === 'on_track' ? 40 : m.verdict === 'at_risk' ? 150 : 3600) })),
  activity: [
    { type: 'board.convened', at: ago(38), project_id: 'co1',
      text: 'board session: winter slate review', summary: null,
      payload: { topic: 'winter slate review', session_id: 'cs-1',
                 members: ['Vera Lindqvist', 'Eleanor Voss', 'Priya Raman', 'Tom Okafor'] } },
    { type: 'council.position', at: ago(31), project_id: 'co1',
      text: 'Eleanor Voss took a position', summary: 'vote the read of the record, not the room',
      payload: { session_id: 'cs-1', agent_id: 'b1' } },
    { type: 'company.allocation.decided', at: ago(1500), project_id: 'co1',
      text: 'portfolio allocation: 3 productions ranked',
      summary: 'Arctic Light: #1 → $4.30 · Moonbase: #2 → $3.10 · Harbor House: #3 → $2.60',
      payload: { allocations: [
        { project_id: 'p1', name: PROJECT.name, priority: 1, verdict: 'on_track', share: 0.55,
          old_cap_micros: 3_800_000, new_cap_micros: 4_300_000 },
        { project_id: 'p2', name: 'Moonbase — kids series, season 2', priority: 2, verdict: 'at_risk',
          share: 0.29, old_cap_micros: 3_400_000, new_cap_micros: 3_100_000 },
        { project_id: 'p3', name: 'Harbor House — limited series', priority: 3, verdict: 'stop',
          share: 0.0, old_cap_micros: 2_800_000, new_cap_micros: 2_600_000 }] } },
    { type: 'decision.recorded', at: ago(2400), project_id: 'co1',
      text: 'the board approved the allocation', summary: 'approve the plan as recorded',
      payload: { session_id: 'cs-0' } },
    { type: 'company.directive', at: ago(16), project_id: 'p2',
      text: 'company directive: at_risk — Moonbase S2', summary: MEMBERS[1].directive,
      payload: { verdict: 'at_risk', project_id: 'p2', directive: MEMBERS[1].directive } },
    { type: 'company.directive', at: ago(900), project_id: 'p3',
      text: 'company directive: stop — Harbor House', summary: MEMBERS[2].directive,
      payload: { verdict: 'stop', project_id: 'p3', directive: MEMBERS[2].directive } },
    { type: 'board.seated', at: ago(1800), project_id: 'co1',
      text: "board seated: Eleanor Voss chairs, 2 owners' seats", summary: null,
      payload: { role: 'chair', agent_id: 'b1' } },
  ],
});

const PORTFOLIO = () => ({
  company_id: 'co1', cap_micros: 10_000_000, spend_micros: 3_800_000, headroom_micros: 6_200_000,
  projects: MEMBERS.map((m, i) => ({
    project_id: m.id, name: m.name, verdict: m.verdict, severity: 'notice',
    directive: m.directive, basis: { spend_ratio: m.spend_ratio }, weight: 1 - i * 0.3,
    success_rate: 0.7, share: [0.55, 0.29, 0.16][i], priority: i + 1,
    spend_micros: m.spend_ratio * 8_000_000, cap_micros: 8_000_000,
    new_cap_micros: [4_300_000, 3_100_000, 2_600_000][i],
  })),
  method: 'cap_i = spend_i + share_i of company headroom; a stop verdict funds nothing new',
});

// ── Runs: the production has a past, not just a present ─────────────────────
const RUNS = [
  { id: 'r2', project_id: 'p1', goal: 'Finish the 58-minute cut and prepare the festival submission package.',
    stage: 'EXECUTING', status: 'running', started_at: daysAgo(0.03), ended_at: null,
    trace_id: 'tr-0002', cost_micros: 1_020_000, tokens_in: 240_000, tokens_out: 32_000,
    triggered_by: 'user', report: null },
  { id: 'r1', project_id: 'p1', goal: 'Assemble rough cut v4 from the Tromsø selects.',
    stage: 'DONE', status: 'completed', started_at: daysAgo(1.1), ended_at: daysAgo(1.0),
    trace_id: 'tr-0001', cost_micros: 1_450_000, tokens_in: 380_000, tokens_out: 52_000,
    triggered_by: 'user',
    report: { deliverables: [{ kind: 'file', id: 'ar4', name: 'assembly_v4.edl' }],
              verification_summary: '11/12 checks passed — one continuity note carried into v4',
              lessons: ['the third act still runs two scenes short', 'archive ingests finish faster than licence paperwork'],
              cost_micros: 1_450_000 } },
];

// ── Per-agent shelves ───────────────────────────────────────────────────────
const REWARDS = {
  a1: [
    { id: 'rw1', project_id: 'p1', agent_id: 'a1', task_id: 't8', role_in_task: 'producer', verdict: 'pass', reward: 0.24, score_after: 0.84, components: { quality: 0.3, efficiency: 0.2 }, created_at: daysAgo(3) },
    { id: 'rw2', project_id: 'p1', agent_id: 'a1', task_id: 't10', role_in_task: 'producer', verdict: 'pass', reward: 0.12, score_after: 0.82, components: { quality: 0.25 }, created_at: daysAgo(1) },
  ],
  a2: [
    { id: 'rw3', project_id: 'p1', agent_id: 'a2', task_id: 't9', role_in_task: 'producer', verdict: 'pass', reward: 0.21, score_after: 0.74, components: { quality: 0.3, efficiency: 0.18 }, created_at: daysAgo(4) },
    { id: 'rw4', project_id: 'p1', agent_id: 'a2', task_id: 't1', role_in_task: 'producer', verdict: 'pass', reward: 0.22, score_after: 0.74, components: { quality: 0.3, cost: 0.2 }, created_at: daysAgo(1) },
  ],
  a3: [
    { id: 'rw5', project_id: 'p1', agent_id: 'a3', task_id: 't7', role_in_task: 'producer', verdict: 'pass', reward: 0.31, score_after: 0.91, components: { quality: 0.4, efficiency: 0.25 }, created_at: daysAgo(2) },
  ],
  a7: [
    { id: 'rw6', project_id: 'p1', agent_id: 'a7', task_id: 't10', role_in_task: 'verifier', verdict: 'pass', reward: 0.15, score_after: 0.6, components: { accuracy: 0.3 }, created_at: daysAgo(1) },
  ],
};

// ── The company asks: what the desk answers with any context ────────────────
const CONTEXT = (agentId) => {
  const a = agentsNow()[agentId];
  if (!a) return null;
  return {
    agent_id: agentId,
    built_at: ago(240),
    version: 'ctx-4',
    sections: {
      mission: a.mission,
      instructions: `You are ${a.name}, ${a.role} on the Arctic Light production. Stay inside your envelope; escalate anything above it to the orchestrator.`,
      recent_tasks: tasksNow().filter((x) => x.assignee_agent_id === agentId).slice(0, 3)
        .map((x) => ({ id: x.id, title: x.title, state: x.state })),
      brain_hits: [
        { entry_id: 'be1', title: 'Archive licensing playbook', trust: 0.9 },
        { entry_id: 'be2', title: "The foundation's 16mm reels: cleared until 2027-03-01", trust: 0.8 },
      ],
      note: 'context pack assembled from the project brain + the agent\'s own history',
    },
  };
};

const ack = { accepted: true, event_seq: 4123, unit: { kind: 'project', id: 'p1', name: PROJECT.name } };

const routes = [
  // TEMPORARY: restart the hiring clock, so the growth can be watched from t=0. The
  // clock starts again on the next org request. Delete with the demo schedule.
  [/^\/api\/dev\/reset$/, () => { T0 = null; return { ok: true, note: 'the clock restarts on the next org request' }; }],
  [/^\/api\/health$/, () => ({ status: 'ok', version: '0.1.0-mock', contract: 1 })],
  [/^\/api\/system\/status$/, () => ({ db: { ok: true }, bus: { ok: true } })],
  [/^\/api\/projects$/, () => paged([PROJECT])],
  [/^\/api\/projects\/([^/]+)\/org$/, () => orgNow()],
  [/^\/api\/projects\/([^/]+)\/tasks$/, () => paged(tasksNow())],
  [/^\/api\/projects\/([^/]+)\/metrics$/, () => ({ cost_micros: 3_800_000, task_success_rate: 0.85, tasks_done: 5, tasks_total: 10 })],
  [/^\/api\/projects\/([^/]+)\/approvals$/, () => {
    const t = elapsed();
    // The approval that was waiting on the budget decision: pending during the
    // council, granted once it decides — the story and the list agree.
    return paged([{ id: 'ap1', project_id: 'p1', capability: 'network.egress', agent_id: 'a4', task_id: 't3', state: t >= BEAT.decide ? 'granted' : 'pending', request: { host: 'submissions.sundance.org' }, created_at: ago(t >= BEAT.decide ? 300 : 60) }]);
  }],
  [/^\/api\/projects\/([^/]+)\/runs$/, () => paged(RUNS)],
  [/^\/api\/runs\/([^/]+)$/, (m) => RUNS.find((r) => r.id === m[1]) ?? null],
  [/^\/api\/projects\/([^/]+)\/leaderboard$/, () => paged(Object.values(agentsNow())
    .sort((x, y) => y.score - x.score)
    .map((a) => ({ agent_id: a.id, name: a.name, role: a.role, grade: a.grade, score: a.score,
                   success_rate: a.success_rate, cost_micros: a.spend_micros, score_trend: a.score_trend })))],
  [/^\/api\/projects\/([^/]+)\/reward-transitions$/, () => paged([
    { id: 'rt1', agent_id: 'a3', agent_name: 'Cleo Marchetti', from_grade: 3, to_grade: 4, kind: 'promotion', rule: 'score > 0.9 sustained across 5 tasks', score_after: 0.91, created_at: daysAgo(3) },
    { id: 'rt2', agent_id: 'a4', agent_name: 'Dev Singh', from_grade: 2, to_grade: 2, kind: 'probation', rule: 'QC accuracy < 0.6 — the reel-3 drift slipped past twice', score_after: 0.42, created_at: daysAgo(3) },
  ])],
  [/^\/api\/projects\/([^/]+)\/brains$/, () => [
    { id: 'b1', project_id: 'p1', scope: 'project', entry_count: 3, children: [
      { id: 'b2', project_id: 'p1', scope: 'department', owner_id: 'd4', entry_count: 2 },
    ] },
  ]],
  [/^\/api\/brains\/([^/]+)\/entries$/, (m) => m[1] === 'b2' ? paged([
    { id: 'be4', brain_id: 'b2', kind: 'fact', title: '34 journalists covered arctic documentaries in the last 3 years', body: 'Rae maintains the list; the top 12 got the Doc Lab screening invite.', trust: 0.7, importance: 0.5, use_count: 2, tags: ['press'], source: { run_id: 'r1' }, created_at: daysAgo(2) },
    { id: 'be5', brain_id: 'b2', kind: 'procedure', title: 'Festival deadlines are checked on Mondays', body: 'Sundance, Berlinale, IDFA — the circuit moves; check before promising a window.', trust: 0.75, importance: 0.6, use_count: 3, tags: ['festival'], source: { run_id: 'r1' }, created_at: daysAgo(2) },
  ]) : paged([
    { id: 'be1', brain_id: 'b1', kind: 'procedure', title: 'Archive licensing playbook', body: "Log every clip's expiry date in the credit sheet the day it is cleared — the festival window outlives two of our current licences.", trust: 0.9, importance: 0.7, use_count: 6, decay_score: 0.95, tags: ['archive', 'rights'], source: { run_id: 'r1' }, created_at: daysAgo(4) },
    { id: 'be2', brain_id: 'b1', kind: 'fact', title: "The foundation's 16mm reels: cleared until 2027-03-01", body: 'The observatory foundation granted festival use; broadcast needs a separate paper.', trust: 0.8, importance: 0.6, use_count: 4, decay_score: 0.9, tags: ['archive'], source: { url: 'https://archive.nordicfilm.no' }, created_at: daysAgo(4) },
    { id: 'be3', brain_id: 'b1', kind: 'insight', title: 'Festival strategy: extend for the Berlinale window', body: "The 52' cut leaves the third act thin; the material for 58' is already in the can.", trust: 0.7, importance: 0.8, use_count: 2, tags: ['festival', 'edit'], source: { run_id: 'r2' }, created_at: daysAgo(0.5) },
  ])],
  [/^\/api\/projects\/([^/]+)\/events$/, () => paged(buildEvents())],
  [/^\/api\/projects\/([^/]+)\/egress$/, () => ({ allow: ['archive.nordicfilm.no', 'api.deepseek.com', 'submissions.sundance.org', 'berlinale.de'], blocked: [] })],
  [/^\/api\/projects\/([^/]+)\/agents\/([^/]+)\/context$/, (m) => CONTEXT(m[2])],
  [/^\/api\/agents\/([^/]+)\/rewards$/, (m) => paged(REWARDS[m[1]] ?? [])],
  [/^\/api\/agents\/([^/]+)$/, (m) => agentsNow()[m[1]] ?? null],
  [/^\/api\/tasks\/([^/]+)\/artifacts$/, (m) => paged(ARTIFACTS[m[1]] ?? [])],
  [/^\/api\/tasks\/([^/]+)$/, (m) => {
    const t = tasksNow().find((x) => x.id === m[1]);
    return t ? { ...t, ...TASK_META[m[1]] } : null;
  }],
  [/^\/api\/departments\/([^/]+)$/, (m) => {
    const detail = {
      d1: { name: 'Development', capabilities: ['story-research', 'archival-licensing'], budget_envelope_micros: 4_000_000, spend_micros: 1_600_000, roster: ['a1', 'a2'] },
      d2: { name: 'Post-Production', capabilities: ['picture-editing', 'qc-continuity', 'dcp-prep'], budget_envelope_micros: 5_000_000, spend_micros: 1_800_000, roster: ['a3', 'a4', 'a6', 'a10'] },
      d3: { name: 'Sound & Music', capabilities: ['score-supervision', 'sound-design'], budget_envelope_micros: 2_000_000, spend_micros: 600_000, roster: ['a5'] },
      d4: { name: 'Festivals & Press', capabilities: ['festival-strategy', 'trailer-editing', 'press'], budget_envelope_micros: 2_500_000, spend_micros: 400_000, roster: ['a7', 'a8', 'a9'] },
    }[m[1]] ?? null;
    if (!detail) return null;
    const agents = agentsNow();
    return { id: m[1], project_id: 'p1', status: 'active', ...detail,
             roster: detail.roster.map((id) => agents[id]).filter(Boolean) };
  }],
  [/^\/api\/system\/audit\/verify$/, () => ({ ok: true })],
  [/^\/api\/tools$/, () => paged([])],
  [/^\/api\/secrets$/, () => paged([])],
];

// ── The command desk demo (ADR 0012): a conversation to start from ──────────────
const COMMANDS = [
  { id: 'cm-1', role: 'captain', text: 'durum ne?', mode: 'question', ok: null,
    actions: [], mentions: [], at: ago(340) },
  { id: 'cr-1', role: 'orchestrator',
    text: 'Arctic Light: 11 agents — 4 busy, 1 on probation · tasks: 5 open, 5 done · latest on the record: verify.check passed',
    mode: 'question', ok: true, actions: [], mentions: [], at: ago(339) },
  { id: 'cm-2', role: 'captain', text: '@Ada, arşiv lisanslarının sürelerini kontrol et', mode: 'order',
    ok: null, actions: [], mentions: ['a1'], at: ago(120) },
  { id: 'cr-2', role: 'orchestrator',
    text: 'On it: “arşiv lisanslarının sürelerini kontrol et” is assigned to @Ada. It runs with the next wave.',
    mode: 'order', ok: true, mentions: [],
    actions: [
      { kind: 'task.created', event_id: null, ref: 't-9f21' },
      { kind: 'task.assigned', event_id: null, ref: 'a1' },
    ],
    at: ago(119) },
  { id: 'cm-3', role: 'captain', text: 'bir fikrim var: kış turu için iki alternatif mekân planlayalım', mode: 'idea',
    ok: null, actions: [], mentions: [], at: ago(60) },
  { id: 'cr-3', role: 'orchestrator',
    text: 'Logged as an idea: “kış turu için iki alternatif mekân planlayalım”. Zoe will weigh it against the circuit calendar before anything moves.',
    mode: 'idea', ok: true, actions: [], mentions: [], at: ago(59) },
];

function COMMAND_MODE(text) {
  const t = text.trim();
  let m = 'order';
  const q = t.indexOf('?');
  if (q >= 0 && q < 60) m = 'question';
  if (/(fikrim|fikir|öneri|oneri|belki|idea|maybe)/i.test(t)) m = 'idea';
  return m;
}

function COMMAND_REPLY(norm, text, ids, names) {
  if (/gorevden al|kov|işten çıkar|isten cikar/.test(norm)) {
    return { text: `Done: @${names[0] || '—'} is archived (reason: “the Captain's call”).`, actions: [] };
  }
  if (/mola/.test(norm)) {
    return {
      text: norm.includes('herkes')
        ? 'Everyone on a break for 15 minutes (no new assignments until then; work already in their hands finishes first).'
        : `@${names[0] || '—'} on a break for 10 minutes (no new assignments until then; work already in their hands finishes first).`,
      actions: [{ kind: 'agent.break.started', event_id: null, ref: ids[0] || null }],
    };
  }
  if (/hedef|goal/.test(norm)) {
    return {
      text: `Run started: “${text.replace(/^[^:]*:\s*/, '').slice(0, 90)}”. Planning begins on the next tick.`,
      actions: [{ kind: 'run.started', event_id: null, ref: 'r-demo' }],
    };
  }
  if (/\?|durum|ne yap/.test(norm)) {
    return {
      text: 'Arctic Light: 11 agents — 4 busy, 1 on probation · tasks: 5 open, 5 done · latest on the record: verify.check passed',
      actions: [],
    };
  }
  if (names.length > 0) {
    const title = text.replace(/@[^\s,;:!?]+/g, '').replace(/^[\s,;:—-]+/, '').slice(0, 80);
    return {
      text: `On it: “${title || 'the assignment'}” is assigned to @${names[0]}. It runs with the next wave.`,
      actions: [
        { kind: 'task.created', event_id: null, ref: 't-demo' },
        { kind: 'task.assigned', event_id: null, ref: ids[0] || null },
      ],
    };
  }
  return {
    text: 'I can carry these out: status (“durum ne?”) · assign (“@Cleo, …”) · reassign · fire · break · goal · budget · hire. A plain sentence is an order; “bir fikrim var: …” floats an idea to be weighed; a question mark asks.',
    actions: [],
  };
}

// The board demo (ADR 0010): a live task behind one story, a bug waiting for the wave,
// a helper pair, and done stories — one card per column state. Every task link points
// at a task whose state agrees (the submission package is blocked only while its
// escalation stands; the board cannot disagree with the engine).
const BOARD_ITEMS = [
  { id: 'w1', kind: 'epic', title: 'Finish Arctic Light for the winter festivals', body: "The run's goal: the locked cut and the festival package.", state: 'in_progress', own_state: 'in_progress', severity: 'normal', priority: 2, parent_id: null, department_id: null, squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w2', kind: 'feature', title: 'Post-production workstream', body: 'Everything the run needs from the post room: cut, colour, DCP.', state: 'in_progress', own_state: 'backlog', severity: 'normal', priority: 2, parent_id: 'w1', department_id: 'd2', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w3', kind: 'feature', title: 'Story & rights workstream', body: 'Everything the run needs from development: facts, papers, releases.', state: 'review', own_state: 'backlog', severity: 'normal', priority: 2, parent_id: 'w1', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w4', kind: 'story', title: 'Rough cut v4 — third-act restructure', body: 'Two scenes shot last month, built back into the act.', state: 'in_progress', own_state: 'ready', severity: 'normal', priority: 3, parent_id: 'w2', department_id: 'd2', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a3', assignee_name: 'Cleo Marchetti', task_id: 't2', task_state: 'running', attempts: 2, helpers: ['a6'], acceptance: ['third act holds without narration', 'runtime under 62 minutes'], tags: ['edit'] },
  { id: 'w5', kind: 'story', title: 'Fact-check the narration script (v3)', body: 'Every claim gets a source note.', state: 'review', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w3', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a1', assignee_name: 'Ada Osei', task_id: 't4', task_state: 'verifying', attempts: 1, helpers: [], acceptance: ['every claim has a source note'], tags: [] },
  { id: 'w6', kind: 'story', title: 'Director\'s statement — first pass', body: '', state: 'backlog', own_state: 'backlog', severity: 'normal', priority: 2, parent_id: 'w3', department_id: null, squad_id: null, created_by: 'user:demo', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w7', kind: 'story', title: 'Clear the archival licences (14 clips)', body: 'NRK reel, the foundation\'s 16mm, two private collections.', state: 'done', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w3', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a2', assignee_name: 'Bo Rasmussen', task_id: 't1', task_state: 'completed', attempts: 1, helpers: [], acceptance: ['all 14 clips logged with expiry dates'], tags: ['archive'] },
  { id: 'w8', kind: 'bug', title: 'Audio drift on reel 3 exports (24→25 fps)', body: 'Found while prepping the DCP — the conform divides by the wrong timebase.', state: 'ready', own_state: 'ready', severity: 'high', priority: 1, parent_id: null, department_id: null, squad_id: null, created_by: 'a4', creator_name: 'Dev Singh', assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: ['The reported problem is fixed and the fix is verified'], tags: ['qc'] },
  { id: 'w9', kind: 'story', title: 'Festival submission package (DCP + press kit)', body: 'Six stills, the statement, the full credits.', state: 'blocked', own_state: 'ready', severity: 'normal', priority: 3, parent_id: 'w2', department_id: 'd2', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a4', assignee_name: 'Dev Singh', task_id: 't3', task_state: 'escalated', attempts: 1, helpers: [], acceptance: ['DCP passes the cinema QC checklist', 'press kit: 6 stills + statement + credits'], tags: [] },
  { id: 'w10', kind: 'story', title: 'Score: temp cues for the 58-minute structure', body: 'So the council can hear the film as cut.', state: 'in_progress', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w2', department_id: 'd3', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a5', assignee_name: 'Iris Nakamura', task_id: 't5', task_state: 'running', attempts: 1, helpers: [], acceptance: [], tags: ['sound'] },
  { id: 'w11', kind: 'story', title: 'Trailer cutdown (60s)', body: 'From reel 3 selects — no spoilers.', state: 'in_progress', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w2', department_id: 'd2', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a6', assignee_name: 'Max Bergström', task_id: 't6', task_state: 'running', attempts: 1, helpers: [], acceptance: [], tags: ['trailer'] },
  { id: 'w12', kind: 'story', title: 'Colour grade — pass one', body: '', state: 'ready', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w2', department_id: 'd2', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: ['colour'] },
];

function BOARD(url) {
  const cols = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
  const titles = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Review', done: 'Done', blocked: 'Blocked' };
  const dept = url.searchParams.get('department_id');
  const squad = url.searchParams.get('squad_id');
  let items = BOARD_ITEMS;
  if (dept) items = items.filter((i) => i.department_id === dept && i.kind !== 'epic');
  if (squad) items = items.filter((i) => i.squad_id === squad);
  // Once the council decides, the submission package is unstuck — the blocked card
  // moves with the task, because the column is derived from the task state.
  const decided = elapsed() >= BEAT.decide;
  items = items.map((i) => i.id === 'w9' && decided
    ? { ...i, state: 'in_progress', task_state: 'running' }
    : i);
  return {
    project_id: 'p1',
    columns: cols.map((k) => ({ key: k, title: titles[k], items: items.filter((i) => i.state === k) })),
    filter: { department_id: dept, squad_id: squad },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  // project detail last so /org etc. win
  for (const [re, fn] of routes) {
    const m = re.exec(url.pathname);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      return res.end(JSON.stringify(fn(m)));
    }
  }
  if (/^\/api\/companies$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ items: [COMPANY()] }));
  }
  if (/^\/api\/companies\/[^/]+\/hq$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(HQ()));
  }
  if (/^\/api\/companies\/[^/]+\/portfolio$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(PORTFOLIO()));
  }
  if (/^\/api\/companies\/[^/]+\/review$/.test(url.pathname) && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(COMPANY().last_review));
  }
  if (/^\/api\/companies\/[^/]+\/allocate$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    const p = PORTFOLIO();
    return res.end(JSON.stringify({ company_id: 'co1', projects: p.projects,
                                    headroom_micros: p.headroom_micros, method: p.method }));
  }
  if (/^\/api\/companies\/[^/]+\/board-session$/.test(url.pathname)) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw); } catch { /* demo */ }
      res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ session_id: `cs-${Date.now()}`, question: String(b.topic || 'board session'),
                               panel: DIRECTORS.map((x) => x.id).concat(['c1']),
                               members: DIRECTORS.map((x) => x.name) }));
    });
    return;
  }
  if (/^\/api\/companies\/[^/]+\/board$/.test(url.pathname)) {
    res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ id: `b${DIRECTORS.length + 1}`, name: 'New Seat',
                                    role: 'board_member', grade: 5 }));
  }
  if (/^\/api\/companies\/[^/]+$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(COMPANY()));
  }
  if (/^\/api\/projects\/[^/]+\/board$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(BOARD(url)));
  }
  if (/^\/api\/projects\/[^/]+\/board\/items$/.test(url.pathname) && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw); } catch { /* empty body is fine in the demo */ }
      const kind = ['story', 'task', 'bug', 'epic', 'feature'].includes(b.kind) ? b.kind : 'story';
      const isBug = kind === 'bug';
      const item = {
        id: `w${BOARD_ITEMS.length + 1}`, kind,
        title: String(b.title || 'Untitled story'), body: String(b.body || ''),
        state: 'backlog', own_state: 'backlog',
        severity: isBug ? (b.severity || 'normal') : 'normal', priority: 2,
        parent_id: null, department_id: b.department_id || null, squad_id: b.squad_id || null,
        created_by: 'user:demo', creator_name: null, assignee_agent_id: null, assignee_name: null,
        task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [],
      };
      BOARD_ITEMS.push(item);
      res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(item));
    });
    return;
  }
  if (/^\/api\/board\/items\/[^/]+$/.test(url.pathname)) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const id = url.pathname.split('/').pop();
      let b = {};
      try { b = JSON.parse(raw); } catch { /* keep the old state */ }
      const item = BOARD_ITEMS.find((i) => i.id === id);
      if (item && b.state) { item.state = b.state; item.own_state = b.state; }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify(item || { id, state: b.state || null }));
    });
    return;
  }
  // The command desk (ADR 0012): the same lexicon the backend speaks, deterministic.
  if (/^\/api\/projects\/[^/]+\/commands$/.test(url.pathname) && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(raw); } catch { /* empty body is fine in the demo */ }
      const text = String(b.text || '').trim();
      const norm = text.toLocaleLowerCase('tr');
      const tokens = [...text.matchAll(/@([^\s,;:!?]+)/g)].map((mm) => mm[1].split("'")[0]);
      const roster = Object.values(agentsNow());
      const hit = tokens.map((tok) => roster.find((a) => a.name.split(' ')[0].toLowerCase() === tok.toLowerCase()));
      const names = tokens.filter((_, i) => hit[i]);
      const ids = hit.filter(Boolean).map((a) => a.id);
      const mode = COMMAND_MODE(text);
      const reply = COMMAND_REPLY(norm, text, ids, names);
      const mid = `cm-${COMMANDS.length + 1}`;
      const rid = `cr-${COMMANDS.length + 1}`;
      const at = new Date().toISOString();
      COMMANDS.push({ id: mid, role: 'captain', text, mode, ok: null, actions: [],
                      mentions: ids, at });
      COMMANDS.push({ id: rid, role: 'orchestrator', text: reply.text, mode, ok: true,
                      actions: reply.actions, mentions: [], at });
      res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ message_id: mid, reply_event_id: rid,
                               reply: { text: reply.text, ok: true, mode, actions: reply.actions } }));
    });
    return;
  }
  if (/^\/api\/projects\/[^/]+\/commands$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify({ messages: COMMANDS }));
  }
  if (/^\/api\/projects\/[^/]+$/.test(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(PROJECT));
  }
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    return res.end(JSON.stringify(ack));
  }
  res.writeHead(404, { 'Content-Type': 'application/problem+json', ...CORS });
  res.end(JSON.stringify({ type: 'https://crew/errors/not_found', title: 'Not found', status: 404 }));
});

server.listen(8788, '127.0.0.1', () => console.log('mock backend on http://127.0.0.1:8788'));
