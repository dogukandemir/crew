/**
 * Deterministic emoji casting.
 *
 * Emoji instead of downloaded sprites on purpose: no licensing, no attribution
 * file, crisp at any zoom, and nothing that reads as generated art. The role
 * keyword picks the category, the agent id picks the variant, so the same agent
 * always looks the same.
 */

const ROLE_AVATARS: Array<{ match: RegExp; variants: string[] }> = [
  { match: /orchestrator|chief|director|vp\b/i, variants: ['🧑‍💼', '👩‍💼'] },
  { match: /manager|head|lead|principal/i, variants: ['🧑‍💼', '👨‍💼'] },
  { match: /research|analyst|investigat|scientist|market/i, variants: ['🕵️', '🔬'] },
  { match: /design|ux|ui\b|writer|copy|content|brand/i, variants: ['🎨', '✍️'] },
  { match: /verif|qa|test|review|audit|quality/i, variants: ['🧐', '🔍'] },
  { match: /data|ml\b|model|analytic/i, variants: ['📊', '🧮'] },
  { match: /marketing|growth|sales|seo|campaign/i, variants: ['📈', '📣'] },
  { match: /finance|ops\b|operations|legal|admin/i, variants: ['🧾', '📋'] },
  { match: /security|guard|safety|compliance/i, variants: ['🛡️', '🔐'] },
  { match: /support|success|community|customer/i, variants: ['🎧', '🤝'] },
  { match: /engineer|develop|backend|frontend|fullstack|devops|infra|platform/i, variants: ['🧑‍💻', '👩‍💻'] },
];

const FALLBACK = ['🧑', '👩', '👨', '🧑‍🔧'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function avatarFor(role: string | undefined, seed: string): string {
  const r = role ?? '';
  const bucket = ROLE_AVATARS.find((entry) => entry.match.test(r));
  const variants = bucket?.variants ?? FALLBACK;
  return variants[hash(seed) % variants.length];
}

/** The prop on the desk: what the character is working *on*. */
export function deviceFor(role: string | undefined, offline: boolean): string {
  if (offline) return '🔌';
  const r = role ?? '';
  if (/orchestrator|chief|director/i.test(r)) return '🖥️';
  if (/design|ux|ui\b|brand/i.test(r)) return '🎨';
  if (/data|analytic|ml\b|model/i.test(r)) return '📈';
  if (/verif|qa|test|review|audit/i.test(r)) return '🔎';
  if (/research|investigat|market/i.test(r)) return '🗂️';
  return '💻';
}
