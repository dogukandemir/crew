/**
 * Egress presets: a named, curated host list the operator can switch on instead of
 * typing every host into `egress_allow` by hand.
 *
 * The backend owns the catalogue (it is the thing that actually expands a preset
 * into hosts) and serves it with the project payload as
 * `egress_presets: { available: { name: hosts[] }, selected: string[] }`. The parser
 * below also accepts the flatter shapes a mock might send, and never breaks on a
 * backend that predates the feature: with no catalogue the control degrades to the
 * known category names with no published expansion, never to a render error and
 * never to an invented host list.
 */

export interface EgressPreset {
  /** Category name, this is what lands in `settings.egress_presets`. */
  name: string;
  /** One line on what turning it on opens. */
  description: string;
  /** Hosts the preset expands to, empty when the backend did not publish them. */
  hosts: string[];
  /** True when the backend advertised the preset: the hosts shown are its. */
  advertised: boolean;
}

/** The categories the product offers, with the one line that says what each opens.
 * The backend map carries hosts only, so the description lives here and the host
 * list is always the backend's. Without a catalogue there is no host list to show,
 * and guessing one would be a lie about what the operator is opening. */
const KNOWN_CATEGORIES: ReadonlyArray<Omit<EgressPreset, 'advertised'>> = [
  { name: 'docs', description: 'vendor and framework documentation', hosts: [] },
  { name: 'research', description: 'papers, reference archives and encyclopaedias', hosts: [] },
  { name: 'news', description: 'news outlets and press wires', hosts: [] },
  { name: 'shopping', description: 'retail, catalogue and price pages', hosts: [] },
  { name: 'code', description: 'source hosting, package registries and code search', hosts: [] },
];

const KNOWN_BY_NAME = new Map(KNOWN_CATEGORIES.map((p) => [p.name, p]));

const CATALOGUE_KEYS = ['egress_presets', 'egress_preset_catalog', 'egress_presets_catalog', 'egressPresets'];
const SETTINGS_KEYS = ['egress_preset_catalog', 'egress_presets_catalog', 'egress_presets'];
/** Envelopes the served shape (or a mock) may wrap the name -> hosts map in. */
const WRAPPER_KEYS = ['available', 'presets', 'catalog', 'catalogue'];
const HOST_KEYS = ['hosts', 'allow', 'domains', 'allowlist', 'egress_allow'];
const TEXT_KEYS = ['description', 'label', 'summary', 'title', 'hint'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hostList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      .map((h) => h.trim());
  }
  return [];
}

function presetHosts(raw: unknown): string[] {
  const rec = asRecord(raw);
  if (!rec) return hostList(raw);
  for (const key of HOST_KEYS) {
    if (key in rec) {
      const hosts = hostList(rec[key]);
      if (hosts.length > 0) return hosts;
    }
  }
  return [];
}

function presetText(raw: unknown): string {
  if (typeof raw === 'string') {
    // A bare string is a description (a name-only catalogue entry arrives as a string
    // inside an array, where it is read as the name instead).
    return raw.trim();
  }
  const rec = asRecord(raw);
  if (!rec) return '';
  for (const key of TEXT_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** One catalogue entry in either the map or the array shape. */
function entryName(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return '';
  for (const key of ['name', 'id', 'key', 'preset']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** What to say about a preset: the entry's own text, the known category line, or the
 * hosts it opens when the name is one this build does not know. */
function describeEntry(name: string, value: unknown, hosts: string[]): string {
  const given = presetText(value);
  if (given) return given;
  const known = KNOWN_BY_NAME.get(name.toLowerCase());
  if (known) return known.description;
  if (hosts.length === 0) return '';
  return hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? ', …' : '');
}

function collect(raw: unknown): EgressPreset[] {
  const out: EgressPreset[] = [];
  const push = (name: string, value: unknown) => {
    const clean = name.trim();
    if (!clean) return;
    if (out.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return;
    const hosts = presetHosts(value);
    out.push({
      name: clean,
      description: describeEntry(clean, value, hosts),
      hosts,
      advertised: true,
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        push(item, item);
        continue;
      }
      const name = entryName(item);
      if (name) push(name, item);
    }
    return out;
  }
  const rec = asRecord(raw);
  if (!rec) return out;
  // `{ available: {...}, selected: [...] }` is the served shape: unwrap the map so the
  // envelope's own keys never read as preset names.
  for (const key of WRAPPER_KEYS) {
    const inner = rec[key];
    if (asRecord(inner) || Array.isArray(inner)) return collect(inner);
  }
  for (const [name, value] of Object.entries(rec)) push(name, value);
  return out;
}

function advertisedCatalog(project: unknown): EgressPreset[] {
  const rec = asRecord(project);
  if (!rec) return [];
  const settings = asRecord(rec.settings);

  const found: EgressPreset[] = [];
  const absorb = (raw: unknown) => {
    for (const preset of collect(raw)) {
      if (!found.some((p) => p.name.toLowerCase() === preset.name.toLowerCase())) found.push(preset);
    }
  };

  for (const key of CATALOGUE_KEYS) absorb(rec[key]);
  if (settings) {
    for (const key of SETTINGS_KEYS) {
      const value = settings[key];
      // `settings.egress_presets` is the selection (list of names); a plain string
      // array there is not a catalogue and must not shadow the real one.
      if (key === 'egress_presets' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        continue;
      }
      absorb(value);
    }
  }
  return found;
}

/** The selection the payload publishes next to the catalogue, if it does. */
export function publishedSelection(project: unknown): string[] {
  const rec = asRecord(project);
  const published = asRecord(rec?.egress_presets);
  if (published) {
    for (const key of ['selected', 'presets_selected', 'enabled']) {
      const names = presetNames(published[key]);
      if (names.length > 0) return names;
    }
  }
  return presetNames(rec?.egress_presets_selected);
}

/**
 * The presets the control renders: the backend catalogue when there is one, the
 * known category names otherwise, plus any stored selection the catalogue does not
 * mention so a saved setting is never silently hidden.
 */
export function buildPresetCatalog(project: unknown, selected: readonly string[] = []): EgressPreset[] {
  const advertised = advertisedCatalog(project);
  const presets: EgressPreset[] = advertised.length > 0
    ? advertised
    : KNOWN_CATEGORIES.map((p) => ({ ...p, advertised: false }));

  for (const rawName of selected) {
    const name = rawName.trim();
    if (!name) continue;
    if (presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    presets.push({ name, description: '', hosts: [], advertised: false });
  }
  return presets;
}

/** The stored selection, sanitized: anything that is not a list of names is empty. */
export function presetNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}
