import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import {
  areApiKeyPoolsEqual,
  candidateKeyPoolValues,
  parseApiKeyPools,
  removeApiKeyPools,
  renameApiKeyPools,
  serializeApiKeyPoolsForYaml,
  withApiKeyPools,
} from '../src/features/config/keyPools';
import { runVisualConfig } from './helpers/visualConfig';

describe('parseApiKeyPools', () => {
  test('keeps non-empty string lists and trims entries', () => {
    expect(
      parseApiKeyPools({
        'sk-a': ['loomy', ' zcode-bigmodel '],
        ' sk-b ': ['zcode-zai'],
        'sk-c': [],
        'sk-d': 'loomy',
        'sk-e': [1, null, 'ok'],
      })
    ).toEqual({
      'sk-a': ['loomy', 'zcode-bigmodel'],
      'sk-b': ['zcode-zai'],
      'sk-e': ['ok'],
    });
  });

  test('rejects non-object input', () => {
    for (const raw of [undefined, null, 'x', 42, ['loomy']]) {
      expect(parseApiKeyPools(raw)).toEqual({});
    }
  });
});

describe('serializeApiKeyPoolsForYaml', () => {
  test('drops keys no longer present in access.api-keys and empty lists', () => {
    expect(
      serializeApiKeyPoolsForYaml(
        { 'sk-a': ['loomy'], 'sk-gone': ['zcode-zai'], 'sk-empty': [] },
        ['sk-a']
      )
    ).toEqual({ 'sk-a': ['loomy'] });
  });
});

describe('api key pool mutations', () => {
  test('withApiKeyPools sets, replaces, and clears a single key', () => {
    const base = { 'sk-a': ['loomy'] };
    expect(withApiKeyPools(base, 'sk-b', ['zcode-zai'])).toEqual({
      'sk-a': ['loomy'],
      'sk-b': ['zcode-zai'],
    });
    expect(withApiKeyPools(base, 'sk-a', [])).toEqual({});
    // Never mutates the input.
    expect(base).toEqual({ 'sk-a': ['loomy'] });
  });

  test('removeApiKeyPools and renameApiKeyPools preserve other entries', () => {
    const base = { 'sk-a': ['loomy'], 'sk-b': ['zcode-zai'] };
    expect(removeApiKeyPools(base, 'sk-a')).toEqual({ 'sk-b': ['zcode-zai'] });
    expect(renameApiKeyPools(base, 'sk-a', 'sk-c')).toEqual({
      'sk-c': ['loomy'],
      'sk-b': ['zcode-zai'],
    });
    expect(renameApiKeyPools(base, 'missing', 'sk-c')).toBe(base);
  });

  test('areApiKeyPoolsEqual is order-insensitive per key but key-sensitive', () => {
    expect(areApiKeyPoolsEqual({ 'sk-a': ['loomy'] }, { 'sk-a': ['loomy'] })).toBe(true);
    expect(areApiKeyPoolsEqual({ 'sk-a': ['loomy', 'zcode-zai'] }, { 'sk-a': ['zcode-zai'] })).toBe(
      false
    );
    expect(areApiKeyPoolsEqual({ 'sk-a': ['loomy'] }, { 'sk-b': ['loomy'] })).toBe(false);
    expect(areApiKeyPoolsEqual(undefined, {})).toBe(true);
  });

  test('candidateKeyPoolValues lists known pools first, then custom ones', () => {
    expect(candidateKeyPoolValues([])).toEqual(['loomy', 'zcode-bigmodel', 'zcode-zai']);
    expect(candidateKeyPoolValues(['zcode-bigmodel', 'my-pool'])).toEqual([
      'loomy',
      'zcode-bigmodel',
      'zcode-zai',
      'my-pool',
    ]);
  });
});

describe('visual config key-pools round trip', () => {
  const fixture = `access:
  api-keys:
    - sk-a
    - sk-b
  key-pools:
    sk-a: [loomy]
    sk-b: [zcode-bigmodel, zcode-zai]
`;

  test('reads access.key-pools and leaves the document unchanged when untouched', () => {
    const config = runVisualConfig(fixture);
    expect(config.visualValues.apiKeyPools).toEqual({
      'sk-a': ['loomy'],
      'sk-b': ['zcode-bigmodel', 'zcode-zai'],
    });
    expect(config.visualDirty).toBe(false);
    expect(parseYaml(config.applyVisualChangesToYaml(fixture))).toEqual(parseYaml(fixture));
  });

  test('writes a key-pools entry and clears it when emptied', () => {
    const config = runVisualConfig('access:\n  api-keys:\n    - sk-a\n', [
      { apiKeyPools: { 'sk-a': ['loomy'] } },
    ]);
    expect([...config.visualDirtyFields]).toEqual(['apiKeyPools']);
    expect(parseYaml(config.applyVisualChangesToYaml('access:\n  api-keys:\n    - sk-a\n'))).toEqual({
      access: { 'api-keys': ['sk-a'], 'key-pools': { 'sk-a': ['loomy'] } },
    });

    const cleared = runVisualConfig(fixture, [{ apiKeyPools: { 'sk-b': ['zcode-zai'] } }]);
    expect(parseYaml(cleared.applyVisualChangesToYaml(fixture)).access['key-pools']).toEqual({
      'sk-b': ['zcode-zai'],
    });
  });

  test('drops orphaned pool entries when an API key is removed', () => {
    const config = runVisualConfig(fixture, [{ apiKeysText: 'sk-b' }]);
    const output = parseYaml(config.applyVisualChangesToYaml(fixture));
    expect(output.access['api-keys']).toEqual(['sk-b']);
    expect(output.access['key-pools']).toEqual({ 'sk-b': ['zcode-bigmodel', 'zcode-zai'] });
  });

  test('removing the last scoped key removes the key-pools block entirely', () => {
    const single = 'access:\n  api-keys:\n    - sk-a\n  key-pools:\n    sk-a: [loomy]\n';
    const config = runVisualConfig(single, [{ apiKeysText: '' }]);
    const output = parseYaml(config.applyVisualChangesToYaml(single));
    expect(output.access['api-keys']).toBeUndefined();
    expect(output.access['key-pools']).toBeUndefined();
  });

  test('reverting pool edits clears dirty state', () => {
    const config = runVisualConfig(fixture, [
      { apiKeyPools: { 'sk-a': ['zcode-zai'] } },
      { apiKeyPools: { 'sk-a': ['loomy'], 'sk-b': ['zcode-bigmodel', 'zcode-zai'] } },
    ]);
    expect(config.visualDirty).toBe(false);
    expect(config.visualDirtyFields.size).toBe(0);
  });
});
