/**
 * Deterministic procedural characters.
 *
 * Every agent gets a stable, human-looking identity generated from their id —
 * skin tone, hair, build, clothing, dress code and accessories — so the same
 * person looks the same on every reload and on every machine. That recognisability
 * is what makes a floor feel like *your* company instead of a crowd of clones.
 *
 * Deliberately generated in code rather than downloaded: no licensed assets, no
 * hundreds of megabytes of binaries in the repository, and infinite variation.
 *
 * Appearance variation is *decorrelated from role*: hair, skin, build, and
 * skirt/trousers are pure genetics. Only things that are genuinely occupational —
 * a lab coat for QA, hi-vis for facilities, a headset for support, and a dress
 * code that steps up with seniority — follow the role, which is how a real
 * company actually looks.
 */

export type HairStyle = 'buzz' | 'short' | 'wave' | 'bun' | 'ponytail' | 'long' | 'curly' | 'braid' | 'bald';
export type FacialHair = 'none' | 'stubble' | 'beard' | 'goatee';
export type Frame = 'slim' | 'average' | 'broad';
export type TopKind = 'tee' | 'shirt' | 'blouse' | 'hoodie' | 'blazer' | 'labcoat' | 'hivis';
export type BottomKind = 'trousers' | 'skirt' | 'dress';
/**
 * Which hair set somebody draws from.
 *
 * The org data carries no gender, so this is a *styling* choice, not a claim: a
 * recognisable first name decides it where the system knows the name, and
 * otherwise it is derived from the agent id like every other trait, so the same
 * person still looks the same on every reload.
 */
export type Presentation = 'feminine' | 'masculine';

export interface CharacterLook {
  seed: number;
  presentation: Presentation;
  /** Overall stature multiplier (0.93 short … 1.07 tall). */
  height: number;
  frame: Frame;
  skin: string;
  hair: { style: HairStyle; color: string };
  facialHair: FacialHair;
  glasses: boolean;
  headset: boolean;
  cap: boolean;
  /** Lanyard accent — nearly everyone wears a badge. */
  badge: string | null;
  top: { kind: TopKind; color: string; sleeve: 'long' | 'short' };
  bottom: { kind: BottomKind; color: string };
  shoes: string;
}

// ── Palettes: muted and realistic. No neon, nothing that reads as a toy. ─────

const SKIN = [
  '#f6dcc6',
  '#f0cdaa',
  '#e5b98f',
  '#d6a276',
  '#c08a5e',
  '#a06a45',
  '#82553a',
  '#65402c',
] as const;

/**
 * Hair colours. Deliberately spread across black, brown, blonde, ginger, auburn,
 * grey and white — a floor where everybody's hair is dark brown reads as a row of
 * identical helmets, which is exactly how the first pass looked.
 */
const HAIR = [
  '#151114',
  '#241a15',
  '#3c2718',
  '#5c3c1f',
  '#7d5126',
  '#a06a2c',
  '#c9a03f',
  '#e2c477',
  '#a8401f',
  '#6d3320',
  '#8f8f96',
  '#dcdce2',
  '#4a2f3a',
  '#2f3d4a',
] as const;

const TOPS = [
  '#2f3a4a',
  '#3b4657',
  '#4a5568',
  '#5b6472',
  '#6b7a8f',
  '#7d8b9c',
  '#8c6b5d',
  '#9a5f4a',
  '#4f6152',
  '#6b7f5e',
  '#c8ccd4',
  '#e2e5ea',
  '#7a5f80',
  '#3f6b74',
  '#a8845c',
] as const;

const BOTTOMS = ['#252b36', '#2f3542', '#3a4150', '#454b57', '#565d6b', '#6e6656', '#1f242e'] as const;

const SHOES = ['#171a20', '#241f1c', '#3a3a3d', '#d8d8dc', '#5a4632'] as const;

const BADGES = ['#e0a458', '#5b8def', '#5fbf8f', '#c97bb6', '#6fc3d0', '#d97a6c'] as const;

// ── Small deterministic RNG ─────────────────────────────────────────────────

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, and stable across engines. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)];
const chance = (r: () => number, p: number): boolean => r() < p;
const between = (r: () => number, lo: number, hi: number): number => lo + r() * (hi - lo);

// ── Role → dress code ───────────────────────────────────────────────────────

const RE_QA = /verif|qa\b|test|quality|audit|inspect/i;
const RE_OPS = /ops\b|operation|facilit|security|warehouse|logistic|guard/i;
const RE_ENG = /engineer|develop|frontend|backend|fullstack|devops|infra|platform|sre\b/i;
const RE_SUPPORT = /support|success|community|customer|service/i;
const RE_DESIGN = /design|ux\b|ui\b|brand|creative/i;
const RE_SENIOR = /orchestrator|chief|director|\bvp\b|principal|head\b|manager|lead\b/i;

/**
 * Occupational clothing. `grade` nudges formality the way seniority really does:
 * someone at grade 4–5 is far more likely to be in a blazer than a new hire.
 */
function dressCode(role: string, grade: number | undefined, r: () => number): TopKind {
  if (RE_QA.test(role)) return 'labcoat';
  if (RE_OPS.test(role)) return 'hivis';
  if (RE_SUPPORT.test(role)) return 'tee';

  const seniority = (grade ?? 2) / 5;
  const formal = chance(r, 0.18 + seniority * 0.55);
  if (RE_SENIOR.test(role) || formal) return 'blazer';
  if (RE_ENG.test(role)) return chance(r, 0.7) ? 'hoodie' : 'tee';
  if (RE_DESIGN.test(role)) return chance(r, 0.5) ? 'blouse' : 'tee';
  return chance(r, 0.5) ? 'shirt' : 'blouse';
}

// Bald is the *absence* of hair and is handled separately below, not as a style.
// The two sets are what makes a floor read as a mixed group at a glance. Neither
// is a claim about anybody: see `Presentation`.
const HAIR_FEMININE: HairStyle[] = ['long', 'ponytail', 'bun', 'wave', 'braid', 'curly', 'short'];
const HAIR_MASCULINE: HairStyle[] = ['short', 'buzz', 'wave', 'curly', 'short', 'short'];

/** First names that read clearly enough to pick a hair set, and their set. */
const FEMININE_NAMES = [
  'ada', 'cleo', 'iris', 'zeynep', 'elif', 'ayse', 'ayşe', 'fatma', 'emine', 'meryem',
  'selin', 'esra', 'melis', 'ceren', 'sara', 'sarah', 'emma', 'olivia', 'sophia', 'mia',
  'lena', 'nora', 'ava', 'maya', 'chloe', 'clara', 'julia', 'anna', 'maria', 'nina',
  'priya', 'yuki', 'mei', 'aisha', 'leyla', 'melisa', 'gamze', 'damla', 'ipek',
];
const MASCULINE_NAMES = [
  'bo', 'alex', 'dev', 'ahmet', 'mehmet', 'mustafa', 'ali', 'huseyin', 'hüseyin', 'hasan',
  'emre', 'kerem', 'can', 'cem', 'burak', 'jack', 'liam', 'noah', 'ethan', 'luca',
  'diego', 'omar', 'adam', 'daniel', 'marco', 'ivan', 'raj', 'kenji', 'wei', 'yusuf',
  'mert', 'tolga', 'onur', 'baran', 'arda',
];

/** Which hair set a name suggests, or undefined when the name says nothing. */
export function presentationFromName(name: string | undefined): Presentation | undefined {
  if (!name) return undefined;
  const first = name.trim().toLowerCase().split(/\s+/)[0];
  if (!first) return undefined;
  if (FEMININE_NAMES.includes(first)) return 'feminine';
  if (MASCULINE_NAMES.includes(first)) return 'masculine';
  return undefined;
}

export function lookFor(agentId: string, role = 'agent', grade?: number, name?: string): CharacterLook {
  const seed = hash(`${agentId}:look`);
  const r = rng(seed);

  const presentation: Presentation =
    presentationFromName(name) ?? (chance(r, 0.5) ? 'feminine' : 'masculine');

  const height = Number(between(r, 0.93, 1.07).toFixed(3));
  const frame: Frame = pick(['slim', 'average', 'average', 'broad'] as const, r);
  const skin = pick(SKIN, r);

  // Hair comes from the person's own set. Bald stays a small minority and skews
  // older, which reads naturally on a floor.
  const set = presentation === 'feminine' ? HAIR_FEMININE : HAIR_MASCULINE;
  const hairStyle: HairStyle = chance(r, 0.06) ? 'bald' : pick(set, r);
  const greyHair = hairStyle !== 'bald' && (grade ?? 2) >= 4 && chance(r, 0.18);
  const hairColor = greyHair ? '#b9b9c2' : pick(HAIR, r);

  const facialHair: FacialHair =
    presentation === 'masculine' && chance(r, 0.5)
      ? pick(['stubble', 'beard', 'goatee'] as const, r)
      : 'none';

  const kind = dressCode(role, grade, r);
  const topColor = pick(TOPS, r);

  // A dress or skirt is a personal choice, not a job title.
  const wantsSkirt = presentation === 'feminine' ? chance(r, 0.6) : chance(r, 0.05);
  const bottomKind: BottomKind = wantsSkirt ? (chance(r, 0.4) ? 'dress' : 'skirt') : 'trousers';

  const tiesToTop = kind === 'hivis' || kind === 'labcoat';

  return {
    seed,
    presentation,
    height,
    frame,
    skin,
    hair: { style: hairStyle, color: hairColor },
    facialHair,
    glasses: chance(r, 0.32),
    headset: RE_SUPPORT.test(role) || chance(r, 0.05),
    // A hard hat is issued kit for the people who need one, never a hairstyle.
    cap: RE_OPS.test(role) ? chance(r, 0.75) : false,
    badge: chance(r, 0.94) ? pick(BADGES, r) : null,
    top: {
      kind,
      // Uniforms are issued, so they are not personalised.
      color: tiesToTop ? (kind === 'hivis' ? '#e8a33d' : '#eef1f5') : topColor,
      sleeve: kind === 'tee' || (kind === 'shirt' && chance(r, 0.35)) ? 'short' : 'long',
    },
    bottom: {
      kind: bottomKind,
      color: bottomKind === 'dress' ? topColor : pick(BOTTOMS, r),
    },
    shoes: pick(SHOES, r),
  };
}

/** Torso/limb thickness for a frame, used by the rig. */
export function frameScale(frame: Frame): number {
  switch (frame) {
    case 'slim':
      return 0.88;
    case 'broad':
      return 1.16;
    default:
      return 1;
  }
}
