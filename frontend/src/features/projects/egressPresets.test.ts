import { expect, it } from 'vitest';
import { buildPresetCatalog, presetNames, publishedSelection } from './egressPresets';

it('reads the served catalogue: backend hosts, the known description, the published selection', () => {
  const project = {
    settings: {},
    egress_presets: {
      available: { docs: ['python.org', 'readthedocs.io'], obscure: ['x.test'] },
      selected: ['docs'],
    },
  };
  expect(publishedSelection(project)).toEqual(['docs']);

  const presets = buildPresetCatalog(project, ['docs']);
  expect(presets.map((p) => p.name)).toEqual(['docs', 'obscure']);
  expect(presets[0]).toMatchObject({
    hosts: ['python.org', 'readthedocs.io'],
    description: 'vendor and framework documentation',
    advertised: true,
  });
  // An unknown category still says what it opens: the hosts themselves.
  expect(presets[1].description).toBe('x.test');
});

it('falls back to the known categories, with no invented hosts, when nothing is advertised', () => {
  const presets = buildPresetCatalog({ settings: { egress_presets: ['docs'] } }, ['docs']);
  expect(presets.map((p) => p.name)).toEqual(['docs', 'research', 'news', 'shopping', 'code']);
  expect(presets[0].advertised).toBe(false);
  expect(presets[0].hosts).toEqual([]);
  expect(publishedSelection({ settings: { egress_presets: ['docs'] } })).toEqual([]);
});

it('keeps a stored selection the catalogue does not mention, and sanitizes the names', () => {
  const presets = buildPresetCatalog({ egress_presets: { available: { docs: ['python.org'] } } }, [
    'docs',
    'retired',
  ]);
  expect(presets.map((p) => p.name)).toEqual(['docs', 'retired']);
  expect(presets[1].advertised).toBe(false);
  expect(presetNames(['docs', ' docs ', '', 3, null])).toEqual(['docs']);
  expect(presetNames('docs')).toEqual([]);
});
