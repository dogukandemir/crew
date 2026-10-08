// Throwaway contract-shaped mock for smoke-testing the Crew frontend.
// Implements docs/11 §2 shapes with representative data. NOT part of the repo.
import http from 'node:http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
};

const PROJECT = {
  id: 'p1',
  name: 'Market Brief',
  goal: 'Build a launch plan for the Q3 campaign.',
  status: 'active',
  stage: 'EXECUTING',
  company_id: 'co1',
  created_at: '2026-01-01T10:00:00.000Z',
  budget_cap_micros: 10_000_000,
  spend_micros: 3_800_000,
  pending_approvals: 1,
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
    egress_allow: ['api.example.com'],
    model_tiers: { reasoning: 'deepseek/deepseek-v4-pro', standard: 'deepseek/deepseek-flash' },
  },
};

const agent = (id, name, role, grade, state, score, dept, spend, manager = null, squad = null) => ({
  id, kind: 'agent', project_id: 'p1', department_id: dept, squad_id: squad, manager_id: manager, name, role, grade, state,
  mission: `${role} on the launch`, autonomy: 'bounded', model_tier: 'standard', model_id: 'deepseek-flash',
  token_cap_per_step: 12000, spend_today_micros: 420_000, score, score_confidence: 0.8, evidence_count: 7,
  success_rate: 0.82, tasks_done: 5, tasks_failed: 1, penalty_count: 0, spend_micros: spend,
  skills: [{ skill_id: 's1', label: 'market-research', proficiency: 0.8 }],
});

// ── The schedule ────────────────────────────────────────────────────────────
// The office grows while you watch — and so does its plot: hires grow the org
// (t+12..t+64), and at t+40 the escalated publish plan forces a COUNCIL, a panel
// that actually meets in the meeting room until it decides at t+90 and everyone
// walks back to work. The clock starts at the FIRST org request, not at boot: the
// app opens its tab seconds after this process starts, and a clock that began at
// boot would have finished hiring before anyone looked.
const BEAT = { hire: 12, dept: 30, second: 48, third: 64, council: 40, chief: 78, decide: 90 };
let T0 = null;
const elapsed = () => {
  if (T0 === null) T0 = Date.now();
  return (Date.now() - T0) / 1000;
};

const A = {
  a0: agent('a0', 'Alex', 'Orchestrator', 5, 'idle', 0.9, 'd1', 400_000),
  a1: agent('a1', 'Ada', 'Market Researcher', 3, 'busy', 0.84, 'd1', 900_000, 'a0', 's1'),
  a2: agent('a2', 'Bo', 'Data Analyst', 2, 'busy', 0.71, 'd1', 300_000, 'a1', 's1'),
  a3: agent('a3', 'Cleo', 'Backend Engineer', 4, 'busy', 0.91, 'd2', 1_400_000, 'a0'),
  a4: agent('a4', 'Dev', 'QA Verifier', 2, 'probation', 0.42, 'd2', 200_000, 'a3'),
  a5: agent('a5', 'Iris', 'Support Agent', 2, 'idle', 0.66, 'd3', 200_000, 'a0'),
  // Hired while you watch.
  a6: agent('a6', 'Max', 'Backend Engineer', 2, 'busy', 0.55, 'd2', 60_000, 'a3'),
  a7: agent('a7', 'Zoe', 'Growth Lead', 3, 'idle', 0.6, 'd4', 40_000, 'a0'),
  a8: agent('a8', 'Nils', 'Content Strategist', 2, 'idle', 0.5, 'd4', 30_000, 'a7'),
  a9: agent('a9', 'Rae', 'SEO Analyst', 2, 'idle', 0.5, 'd4', 30_000, 'a7'),
  // The executive tier (ADR 0008): the Market function reaches two departments
  // (Research + Growth) and earns its chief.
  a10: agent('a10', 'Nadia', 'CMO', 5, 'idle', 0.7, 'd4', 20_000, 'a0'),
};

const DEPT_NAMES = { d1: 'Research', d2: 'Engineering', d3: 'Support', d4: 'Growth' };
const squadNode = (children) => ({
  id: 's1', kind: 'squad', name: 'Market-scan', state: 'active', spend_micros: 900_000,
  open_tasks: 1, department_id: 'd1', children,
});
const deptNode = (id, children) => ({
  id, kind: 'department', name: DEPT_NAMES[id], state: 'active', spend_micros: 1_200_000,
  score: 0.78, open_tasks: 1, budget_envelope_micros: 4_000_000, success_rate: 0.82,
  department_id: null, children,
});

/**
 * The org AS IT STANDS RIGHT NOW — a function of the clock, evaluated per request.
 *
 * t+12 a second engineer joins an EXISTING department (that room gains a desk);
 * t+30 a hire into nothing opens Growth, a brand new room on the canvas;
 * t+48, t+64 Growth grows further. The frontend keeps each room's slot, so the new
 * room appears beside the existing ones and nothing already built moves.
 */
const orgNow = () => {
  const t = elapsed();
  const children = [A.a0, deptNode('d1', [squadNode([A.a1, A.a2])])];
  children.push(deptNode('d2', t >= BEAT.hire ? [A.a3, A.a4, A.a6] : [A.a3, A.a4]));
  children.push(deptNode('d3', [A.a5]));
  if (t >= BEAT.dept) {
    const growth = [A.a7];
    if (t >= BEAT.second) growth.push(A.a8);
    if (t >= BEAT.third) growth.push(A.a9);
    children.push(deptNode('d4', growth));
  }
  // t+78: the Market function now spans Research + Growth — its CMO joins the org.
  if (t >= BEAT.chief) children.push(A.a10);
  return {
    root: {
      id: 'p1', kind: 'project', name: PROJECT.name, state: 'active', spend_micros: 3_800_000,
      score: 0.8, open_tasks: 3, children,
    },
  };
};

/**
 * The tasks AS THEY STAND RIGHT NOW. After the council decides (t+90) the publish
 * plan is unstuck: `escalated` becomes `running`. Before that it stays escalated —
 * the escalation is the reason the council exists, and a task that resolves before
 * its own decision would be a mock lying about its own story.
 */
const tasksNow = () => {
  const t = elapsed();
  const t3 =
    t >= BEAT.decide
      ? { id: 't3', project_id: 'p1', title: 'Publish plan', state: 'running', assignee_agent_id: 'a4', cost_micros: 120_000, attempts: 1, effort: 'S' }
      : { id: 't3', project_id: 'p1', title: 'Publish plan', state: 'escalated', assignee_agent_id: 'a4', cost_micros: 120_000, attempts: 1, effort: 'S', escalation_reason: 'needs a budget decision above my envelope', escalated_to: 'a0' };
  return [
    { id: 't1', project_id: 'p1', title: 'Market scan', state: 'completed', assignee_agent_id: 'a1', cost_micros: 420_000, attempts: 1, effort: 'M', acceptance_criteria: ['5 competitors', 'sources cited'] },
    { id: 't2', project_id: 'p1', title: 'Positioning brief', state: 'running', assignee_agent_id: 'a3', cost_micros: 610_000, attempts: 2, effort: 'L' },
    t3,
    { id: 't4', project_id: 'p1', title: 'Verify launch deck', state: 'verifying', assignee_agent_id: 'a2', cost_micros: 90_000, attempts: 1, effort: 'M' },
    { id: 't5', project_id: 'p1', title: 'Benchmark competitor pricing', state: 'running', assignee_agent_id: 'a1', cost_micros: 150_000, attempts: 1, effort: 'M' },
    { id: 't6', project_id: 'p1', title: 'Research experiment on pricing', state: 'running', assignee_agent_id: 'a6', cost_micros: 110_000, attempts: 1, effort: 'M' },
  ];
};

// Freshly-timestamped events so every office pose has something real to render.
// The last column is the event payload, which is what the office reads: a name
// to walk to, the words to put in the bubble, and whether it is work or chat.
// The clock is read per request — a snapshot taken at boot ages out of the
// seconds-long activity windows and makes working features look broken.
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const RAW_EVENTS = [
  ['a3', 'agent.thought', 'drafting the positioning brief', 1.5],
  ['a1', 'agent.tool.call', 'tool: web.search("competitor pricing")', 2],
  ['a2', 'verify.started', 'verifying: launch deck', 3],
  ['a0', 'agent.thought', 'two squads are close to their budget ceiling', 4],
  ['a4', 'policy.approval.requested', 'approval needed: publish to the CDN', 5],
  // A report upward: goes to this agent's manager, and walks there.
  ['a3', 'agent.message', 'report to manager: brief is 80% drafted', -4,
    { to: 'manager', text: 'brief is 80% drafted, one slide to go', direction: 'up' }],
  ['a3', 'llm.response', 'llm: 1.9k tokens, 0.41s', 6],
  ['a1', 'agent.thought', 'the Q3 competitors all moved upmarket', 7],
  ['a2', 'verify.check', 'check passed: sources cited', 8],
  ['a0', 'agent.delegated', 'delegated "launch plan" to Engineering', 10],
  ['a3', 'agent.tool.call', 'tool: write_file("brief.md")', 12],
  ['a1', 'task.completed', 'completed: Market scan', 14],
  ['a4', 'task.escalated', 'escalated: Publish plan', 16],
  // Water-cooler talk: between two people, about nothing either is working on.
  ['a5', 'agent.message', 'message to Cleo: the coffee machine is a war crime', -9,
    { to: 'Cleo', text: 'the coffee machine is a war crime', direction: 'side', informal: true }],
  // Office talk between two people who are NOT on that task. The story's own record
  // says the publish plan died twice (the task.escalated above), so the rumour is
  // allowed to say exactly that — no more. Cleo is on the brief, not the publish plan;
  // Dev (who escalated it) is deliberately not a mouth here. The stamp sits ahead of
  // every other talk event so the whisper wins the recency race and stays visible.
  ['a5', 'agent.gossip', 'Iris ⟷ Cleo: the publish plan died twice', -14,
    { informal: true, topic: 'failing_work', to: 'Cleo', to_name: 'Cleo', from_name: 'Iris',
      text: 'did you hear — the publish plan died twice and nobody has said why?',
      basis: ['task:t3'] }],
  ['a3', 'agent.thought', 'the deck needs a pricing slide', 18],
  ['a2', 'agent.thought', 'checking the deck against the acceptance criteria', 20],
  ['a0', 'budget.spent', 'budget: $0.42 settled to Engineering', 24],
  ['a1', 'agent.tool.call', 'tool: read_file("playbook.md")', 28],
  // A colleague asking a colleague for something: same department, live task.
  ['a1', 'agent.message', 'message to Bo: can you sanity-check my numbers?', -12,
    { to: 'Bo', text: 'can you sanity-check my numbers?', direction: 'out' }],
];
// Built per request so the timestamps stay fresh: a fixed snapshot would age
// past the 6-second "talking" window before anyone opened the tab.
const buildEvents = () => {
  // A hire has to DO something the moment they exist, or the office seats them and
  // they stand there: their first event is what the character's bubble reads.
  const hires = [];
  const t = elapsed();
  if (t >= BEAT.hire) hires.push(['a6', 'agent.thought', 'reading the brief Cleo handed me', 2]);
  if (t >= BEAT.dept) hires.push(['a7', 'agent.thought', 'first day: mapping the growth backlog', 3]);
  if (t >= BEAT.second) hires.push(['a8', 'agent.tool.call', 'tool: write_file("content-plan.md")', 1.5]);
  if (t >= BEAT.third) hires.push(['a9', 'agent.tool.call', 'tool: web.search("keyword gaps")', 1]);
  if (t >= BEAT.chief) hires.push(['a10', 'agent.thought', 'taking the market chair: research and growth report up through me now', 2]);

  // The office's whisper network: same worry, three mouths, each grounded in what the
  // story already shows. Zoe heard the envelope talk (her council position says so),
  // Nils hears it from her, Rae from him — and at t+90 the topic has enough mouths to
  // surface as a concern the company has to look at (`gossip.surfaced`). The floor
  // reads `to` to walk the speaker over and `informal` to colour the bubble.
  const whispers = [];
  if (t >= BEAT.second) {
    whispers.push(['a7', 'agent.gossip', 'Zoe ⟷ Nils: the envelope ask is really about the plan', 2,
      { informal: true, topic: 'failing_work', to: 'Nils', to_name: 'Nils', from_name: 'Zoe',
        text: 'they are asking Alex for a bigger envelope — for a plan that died twice',
        basis: ['task:t3'] }]);
  }
  if (t >= BEAT.third) {
    whispers.push(['a8', 'agent.gossip', 'Nils ⟷ Rae: three mouths, one worry', 2,
      { informal: true, topic: 'failing_work', to: 'Rae', to_name: 'Rae', from_name: 'Nils',
        text: 'Zoe says the council is really about the plan that keeps dying — watch the room',
        basis: ['task:t3'] }]);
  }
  if (t >= BEAT.decide) {
    whispers.push(['a0', 'gossip.surfaced', 'concern surfaced: failing_work', 4,
      { topic: 'failing_work', mouths: 3, basis: ['task:t3'] }]);
  }

  // The council. From t+40 the escalated publish plan has the panel in the meeting
  // room: `council.convened` opens the sitting, each member's `council.position` is
  // what makes them a MEMBER (the floor reads the panel off these), and a couple of
  // messages between them give the room something to say. At t+90 `decision.recorded`
  // closes it.
  //
  // The sitting's own record AGES after the decision instead of being dropped: the
  // frontend's log dedupes by id, and an array that loses entries in the middle
  // re-numbers everything after them — a re-indexed event reads as a duplicate and
  // is silently discarded, which is exactly how a decision once went missing.
  const council = [];
  if (t >= BEAT.council) {
    const past = t >= BEAT.decide ? t - BEAT.decide + 30 : 0;
    council.push([
      'a0',
      'council.convened',
      'council convened: ship the launch now, or fold it into Q3?',
      6 + past,
      {
        session_id: 'c1',
        question: 'Ship the launch now, or fold it into the Q3 campaign?',
        options: [
          { id: 'o1', label: 'Ship now on the current budget' },
          { id: 'o2', label: 'Fold into Q3 with a raised envelope' },
        ],
        criteria: ['correctness', 'cost', 'risk', 'reversibility'],
        rationale: 'Dev escalated the publish plan: the budget decision is above their envelope',
      },
    ]);
    council.push(
      ['a1', 'council.position', 'Ada on fold into Q3', 5 + past,
        { session_id: 'c1', agent_id: 'a1', round: 1, option_id: 'o2', claim: 'the evidence favours folding: two of three competitors moved upmarket this quarter', confidence: 0.7, risks: ['we lose a quarter of momentum'] }],
      ['a2', 'council.position', 'Bo on fold into Q3', 4.5 + past,
        { session_id: 'c1', agent_id: 'a2', round: 1, option_id: 'o2', claim: 'the pricing benchmark only holds if the deck ships with Q3 numbers', confidence: 0.62, risks: ['forecasts are two weeks stale'] }],
      ['a4', 'council.position', 'Dev on ship now', 4 + past,
        { session_id: 'c1', agent_id: 'a4', round: 1, option_id: 'o1', claim: 'shipping now proves the pipeline; the spend is already committed', confidence: 0.4, risks: ['verification coverage is thin'] }],
      ['a7', 'council.position', 'Zoe on fold into Q3', 3.5 + past,
        { session_id: 'c1', agent_id: 'a7', round: 1, option_id: 'o2', claim: 'growth needs the campaign window; a half-launch now costs us the quarter either way', confidence: 0.66, risks: ['the envelope raise needs sign-off'] }],
      ['a0', 'council.position', 'Alex on fold into Q3', 3 + past,
        { session_id: 'c1', agent_id: 'a0', round: 2, option_id: 'o2', claim: 'the dissent is about verification depth, not timing — folding answers both', confidence: 0.74, risks: [] }],
      ['a4', 'agent.message', 'message to Zoe: who signs the raised envelope?', 2.5 + past,
        { to: 'Zoe', text: 'who signs off the raised envelope if we fold?', direction: 'side' }],
      ['a7', 'agent.message', 'message to Dev: Alex can, above 4k', 2 + past,
        { to: 'Dev', text: 'Alex can, anything above four thousand — that is why we are all in this room', direction: 'side' }],
    );
  }
  if (t >= BEAT.decide) {
    council.push(
      ['a0', 'decision.recorded', 'council decided: fold the launch into Q3', 1,
        { decision_id: 'dc1', chosen_option: 'o2' }],
      ['a0', 'agent.message', 'message to Dev: unstuck — fold it in, new numbers by Friday', 1.5,
        { to: 'Dev', text: 'unstuck: fold it into Q3, new numbers by Friday', direction: 'down' }],
    );
  }

  return [...(() => {
    // Two raw events only make sense while the publish plan is stuck: the approval
    // request and the escalation itself. Once the council has decided they are
    // history, and history — in this mock — means an old timestamp, not a fresh one
    // that makes a granted approval look pending forever.
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
    summary: 'synthetic event for the office smoke test',
    payload: payload ?? { i, title, agent: agent_id },
    agent_id,
    task_id: null,
    run_id: 'r1',
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

// Flat lookup so /api/agents/{id} can answer per agent (the office panel opens
// whichever character you click).
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
  { id: 'b1', name: 'Eleanor Voss', role: 'chair', grade: 5 },
  { id: 'b2', name: 'Priya Raman', role: 'board_member', grade: 5 },
  { id: 'b3', name: 'Tom Okafor', role: 'board_member', grade: 5 },
];
const EXECUTIVES = [
  { id: 'c1', name: 'Vera', role: 'ceo', title: 'Chief Executive Officer', function: 'executive' },
  { id: 'c2', name: 'Idris', role: 'cto', title: 'Chief Technology Officer', function: 'technology' },
  { id: 'c3', name: 'Camille', role: 'cmo', title: 'Chief Marketing Officer', function: 'market' },
  { id: 'c4', name: 'Selma', role: 'cpo', title: 'Chief Product Officer', function: 'product' },
  { id: 'c5', name: 'Marcus', role: 'coo', title: 'Chief Operations Officer', function: 'operations' },
  { id: 'c6', name: 'Ruth', role: 'cfo', title: 'Chief Financial Officer', function: 'finance' },
];
const MEMBERS = [
  { id: 'p1', name: PROJECT.name, status: 'active', verdict: 'on_track', spend_ratio: 0.38,
    directive: 'keep going: 38% of the budget used, 3 completed so far',
    completed: 3, failed: 0, open_tasks: 2,
    teams: [{ id: 'd1', name: 'Research', head_name: 'Ada', agents: 3 },
            { id: 'd2', name: 'Growth', head_name: 'Bo', agents: 2 }] },
  { id: 'p2', name: 'Arctic Light — documentary', status: 'active', verdict: 'at_risk', spend_ratio: 0.84,
    directive: 'quality alarm: 3 of 5 tasks failed — put a senior pair on the recurring failure',
    completed: 2, failed: 3, open_tasks: 4,
    teams: [{ id: 'd3', name: 'Production', head_name: 'Nils', agents: 4 },
            { id: 'd4', name: 'Sound', head_name: 'Zoe', agents: 2 }] },
  { id: 'p3', name: 'Moonbase — kids series', status: 'paused', verdict: 'stop', spend_ratio: 0.97,
    directive: 'stop and fold: 97% of the budget is spent — no new spend without a fresh rationale',
    completed: 6, failed: 1, open_tasks: 0,
    teams: [{ id: 'd5', name: 'Animation', head_name: 'Iris', agents: 5 }] },
];
const COMPANY = () => ({
  id: 'co1', name: 'Northwind Pictures', mission: 'Own the Q3 launch portfolio', status: 'active',
  budget_usd: 10, spend_usd: 3.8, spend_ratio: 0.38,
  ceo: { id: 'c1', name: 'Vera', grade: 5 },
  board: DIRECTORS,
  roster: EXECUTIVES.map((e) => ({ id: e.id, name: e.name, role: e.role, grade: 5 })),
  projects: MEMBERS.map((m) => ({ id: m.id, name: m.name, status: m.status, spend_ratio: m.spend_ratio })),
  last_review: {
    ts: ago(0),
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
    id: 'co1', name: 'Northwind Pictures', mission: 'Own the Q3 launch portfolio',
    budget_usd: 10, spend_usd: 3.8, spend_ratio: 0.38,
  },
  ceo: { id: 'c1', name: 'Vera', grade: 5 },
  executives: EXECUTIVES,
  board: DIRECTORS,
  projects: MEMBERS.map((m) => ({ ...m, last_at: ago(m.verdict === 'on_track' ? 40 : m.verdict === 'at_risk' ? 150 : 3600) })),
  activity: [
    { type: 'board.convened', at: ago(38), project_id: 'co1',
      text: 'board session: Q3 portfolio allocation', summary: null,
      payload: { topic: 'Q3 portfolio allocation', session_id: 'cs-1',
                 members: ['Vera', 'Eleanor Voss', 'Priya Raman', 'Tom Okafor'] } },
    { type: 'council.position', at: ago(31), project_id: 'co1',
      text: 'Eleanor Voss took a position', summary: 'vote the read of the record, not the room',
      payload: { session_id: 'cs-1', agent_id: 'b1' } },
    { type: 'company.allocation.decided', at: ago(1500), project_id: 'co1',
      text: 'portfolio allocation: 3 projects ranked',
      summary: 'Market Brief: #1 → $4.30 · Arctic Light: #2 → $3.10 · Moonbase: #3 → $2.60',
      payload: { allocations: [
        { project_id: 'p1', name: PROJECT.name, priority: 1, verdict: 'on_track', share: 0.55,
          old_cap_micros: 3_800_000, new_cap_micros: 4_300_000 },
        { project_id: 'p2', name: 'Arctic Light — documentary', priority: 2, verdict: 'at_risk',
          share: 0.29, old_cap_micros: 3_400_000, new_cap_micros: 3_100_000 },
        { project_id: 'p3', name: 'Moonbase — kids series', priority: 3, verdict: 'stop',
          share: 0.0, old_cap_micros: 2_800_000, new_cap_micros: 2_600_000 }] } },
    { type: 'decision.recorded', at: ago(2400), project_id: 'co1',
      text: 'the board approved the allocation', summary: 'approve the plan as recorded',
      payload: { session_id: 'cs-0' } },
    { type: 'company.directive', at: ago(16), project_id: 'p2',
      text: 'company directive: at_risk — Arctic Light', summary: MEMBERS[1].directive,
      payload: { verdict: 'at_risk', project_id: 'p2', directive: MEMBERS[1].directive } },
    { type: 'company.directive', at: ago(900), project_id: 'p3',
      text: 'company directive: stop — Moonbase', summary: MEMBERS[2].directive,
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
  [/^\/api\/projects\/([^/]+)\/metrics$/, () => ({ cost_micros: 3_800_000, task_success_rate: 0.82, tasks_done: 1, tasks_total: 3 })],
  [/^\/api\/projects\/([^/]+)\/approvals$/, () => {
    const t = elapsed();
    // The approval that was waiting on the budget decision: pending during the
    // council, granted once it decides — the story and the list agree.
    return paged([{ id: 'ap1', project_id: 'p1', capability: 'network.egress', agent_id: 'a4', task_id: 't3', state: t >= BEAT.decide ? 'granted' : 'pending', request: { host: 'cdn.example.com' }, created_at: '2026-01-01T12:00:00.000Z' }]);
  }],
  [/^\/api\/projects\/([^/]+)\/runs$/, () => paged([])],
  [/^\/api\/projects\/([^/]+)\/leaderboard$/, () => paged([
    { agent_id: 'a3', name: 'Cleo', role: 'Backend Engineer', grade: 4, score: 0.91, success_rate: 0.9, cost_micros: 1_400_000, score_trend: [0.6, 0.7, 0.8, 0.91] },
    { agent_id: 'a1', name: 'Ada', role: 'Market Researcher', grade: 3, score: 0.84, success_rate: 0.85, cost_micros: 900_000, score_trend: [0.8, 0.82, 0.84] },
    { agent_id: 'a4', name: 'Dev', role: 'QA Verifier', grade: 2, score: 0.42, success_rate: 0.5, cost_micros: 200_000, score_trend: [0.7, 0.6, 0.42] },
  ])],
  [/^\/api\/projects\/([^/]+)\/reward-transitions$/, () => paged([
    { id: 'rt1', agent_id: 'a3', agent_name: 'Cleo', from_grade: 3, to_grade: 4, kind: 'promotion', rule: 'score>0.9 sustained 5 tasks', score_after: 0.91, created_at: '2026-01-01T11:00:00.000Z' },
    { id: 'rt2', agent_id: 'a4', agent_name: 'Dev', from_grade: 2, to_grade: 2, kind: 'probation', rule: 'verifier accuracy < 0.6', score_after: 0.42, created_at: '2026-01-01T11:30:00.000Z' },
  ])],
  [/^\/api\/projects\/([^/]+)\/brains$/, () => [{ id: 'b1', project_id: 'p1', scope: 'project', entry_count: 3, children: [{ id: 'b2', project_id: 'p1', scope: 'department', owner_id: 'd1', entry_count: 2 }] }]],
  [/^\/api\/brains\/([^/]+)\/entries$/, () => paged([
    { id: 'be1', brain_id: 'b1', kind: 'procedure', title: 'rate-limit playbook', body: 'Back off exponentially.', trust: 0.9, importance: 0.7, use_count: 4, decay_score: 0.95, tags: ['ops'], source: { run_id: 'r1' }, created_at: '2026-01-01T10:00:00.000Z' },
    { id: 'be2', brain_id: 'b1', kind: 'fact', title: 'competitor X raised Series B', trust: 0.6, importance: 0.4, use_count: 1, created_at: '2026-01-01T10:05:00.000Z', source: { url: 'https://example.com' } },
  ])],
  [/^\/api\/projects\/([^/]+)\/events$/, () => paged(buildEvents())],
  [/^\/api\/projects\/([^/]+)\/egress$/, () => ({ allow: ['api.example.com'], blocked: [] })],
  [/^\/api\/agents\/([^/]+)\/rewards$/, () => paged([{ id: 'rw1', project_id: 'p1', agent_id: 'a1', task_id: 't1', role_in_task: 'producer', verdict: 'pass', reward: 0.22, score_after: 0.84, components: { quality: 0.3, efficiency: 0.2 }, created_at: '2026-01-01T11:00:00.000Z' }])],
  [/^\/api\/agents\/([^/]+)$/, (m) => agentsNow()[m[1]] ?? null],
  [/^\/api\/tasks\/([^/]+)\/artifacts$/, () => paged([{ id: 'ar1', project_id: 'p1', task_id: 't1', kind: 'file', path: 'report.md', bytes: 2048, trust: 'verified', created_at: '2026-01-01T11:00:00.000Z' }])],
  [/^\/api\/tasks\/([^/]+)$/, () => ({ ...tasksNow()[0], description: 'Scan the market.', required_skills: ['market-research'], depends_on: [], output_contract: { format: 'json' }, verification: { id: 'v1', task_id: 't1', verdict: 'pass', method: 'deterministic', checks: [{ name: 'sources cited', ok: true }], confidence: 0.9, created_at: '2026-01-01T11:00:00.000Z' }, rewards: [] })],
  [/^\/api\/departments\/([^/]+)$/, () => ({ id: 'd1', project_id: 'p1', name: 'Research', status: 'active', capabilities: ['market-research'], budget_envelope_micros: 4_000_000, spend_micros: 1_600_000, roster: [agent('a1', 'Ada', 'Market Researcher', 3, 'busy', 0.84, 'd1', 900_000)] })],
  [/^\/api\/system\/audit\/verify$/, () => ({ ok: true })],
  [/^\/api\/tools$/, () => paged([])],
  [/^\/api\/secrets$/, () => paged([])],
];

// ── The command desk demo (ADR 0012): a conversation to start from ──────────────
const COMMANDS = [
  { id: 'cm-1', role: 'captain', text: 'durum ne?', mode: 'question', ok: null,
    actions: [], mentions: [], at: ago(340) },
  { id: 'cr-1', role: 'orchestrator',
    text: 'Company status: 14 agents — 3 busy, 0 on a break · tasks: 4 open, 9 done, 1 failed · latest on the record: task.completed',
    mode: 'question', ok: true, actions: [], mentions: [], at: ago(339) },
  { id: 'cm-2', role: 'captain', text: '@Ada, rakip analizini derinleştir', mode: 'order',
    ok: null, actions: [], mentions: ['a1'], at: ago(120) },
  { id: 'cr-2', role: 'orchestrator',
    text: 'On it: “rakip analizini derinleştir” is assigned to @Ada. It runs with the next wave.',
    mode: 'order', ok: true, mentions: [],
    actions: [
      { kind: 'task.created', event_id: null, ref: 't-9f21' },
      { kind: 'task.assigned', event_id: null, ref: 'a1' },
    ],
    at: ago(119) },
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
      text: 'Company status: 14 agents — 3 busy, 0 on a break · tasks: 4 open, 9 done, 1 failed · latest on the record: task.completed',
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
    text: 'I can carry these out: status (“durum ne?”) · assign (“@Ada, …”) · reassign · fire · break · goal · budget · hire. A plain sentence is an order; “bir fikrim var: …” floats an idea to be weighed; a question mark asks.',
    actions: [],
  };
}

// The board demo (ADR 0010): a live task behind one story, a bug waiting for the wave,
// a helper pair, and a done story — one card per column state.
const BOARD_ITEMS = [
  { id: 'w1', kind: 'epic', title: 'Ship the market brief', body: "The run's goal, decomposed into four stories.", state: 'in_progress', own_state: 'in_progress', severity: 'normal', priority: 2, parent_id: null, department_id: null, squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w2', kind: 'feature', title: 'Research workstream', body: 'Everything this run needs from the research capability.', state: 'in_progress', own_state: 'backlog', severity: 'normal', priority: 2, parent_id: 'w1', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w3', kind: 'feature', title: 'Engineering workstream', body: 'Everything this run needs from the engineering capability.', state: 'review', own_state: 'backlog', severity: 'normal', priority: 2, parent_id: 'w1', department_id: null, squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w4', kind: 'story', title: 'Map the competitive set', body: 'Twelve rivals, sourced.', state: 'in_progress', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w2', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a1', assignee_name: 'Ada', task_id: 't1', task_state: 'running', attempts: 0, helpers: ['a2'], acceptance: ['twelve rivals with sources'], tags: [] },
  { id: 'w5', kind: 'story', title: 'Write the exporter module', body: 'CSV export for the brief.', state: 'review', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w3', department_id: null, squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: 'a3', assignee_name: 'Nils', task_id: 't2', task_state: 'verifying', attempts: 1, helpers: [], acceptance: [], tags: [] },
  { id: 'w6', kind: 'story', title: 'Draft the pricing section', body: '', state: 'ready', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w3', department_id: null, squad_id: null, created_by: 'user:demo', creator_name: null, assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w7', kind: 'story', title: 'Collect source citations', body: '', state: 'done', own_state: 'ready', severity: 'normal', priority: 2, parent_id: 'w2', department_id: 'd1', squad_id: null, created_by: 'system:planner', creator_name: null, assignee_agent_id: null, assignee_name: 'Zoe', task_id: 't3', task_state: 'completed', attempts: 0, helpers: [], acceptance: [], tags: [] },
  { id: 'w8', kind: 'bug', title: 'Export crashes on empty rows', body: 'Found while working the exporter story — the writer divides by row count.', state: 'ready', own_state: 'ready', severity: 'high', priority: 1, parent_id: null, department_id: null, squad_id: null, created_by: 'a3', creator_name: 'Nils', assignee_agent_id: null, assignee_name: null, task_id: null, task_state: null, attempts: 0, helpers: [], acceptance: ['The reported problem is fixed and the fix is verified'], tags: [] },
];

function BOARD(url) {
  const cols = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
  const titles = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Review', done: 'Done', blocked: 'Blocked' };
  const dept = url.searchParams.get('department_id');
  const squad = url.searchParams.get('squad_id');
  let items = BOARD_ITEMS;
  if (dept) items = items.filter((i) => i.department_id === dept && i.kind !== 'epic');
  if (squad) items = items.filter((i) => i.squad_id === squad);
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
