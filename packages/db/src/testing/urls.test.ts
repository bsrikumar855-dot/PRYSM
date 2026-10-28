import { describe, expect, it } from 'vitest';
import { isSweepPrefix, testDatabaseCreatedAtMs, testDatabaseName, withDatabase } from './urls.ts';

describe('withDatabase', () => {
  it('swaps only the database name', () => {
    expect(withDatabase('postgres://u:p@127.0.0.1:5432/prysm?sslmode=disable', 'prysm_t_1')).toBe(
      'postgres://u:p@127.0.0.1:5432/prysm_t_1?sslmode=disable',
    );
  });
});

describe('testDatabaseName', () => {
  it('embeds the creation time and a sanitised suite name', () => {
    const name = testDatabaseName('Baseline / RLS!', 1_790_000_123_456, 'abc123');
    expect(name).toBe('prysm_t_1790000123_baseline_rls_abc123');
    expect(testDatabaseCreatedAtMs(name)).toBe(1_790_000_123_000);
  });

  it('falls back for an empty suite and caps the length', () => {
    expect(testDatabaseName('!!!', 1_790_000_000_000, 'abcdef')).toContain('_suite_');
    expect(testDatabaseName('x'.repeat(100), 1_790_000_000_000, 'abcdef').length).toBeLessThanOrEqual(63);
  });

  it('rejects a short or non-hex random part', () => {
    expect(() => testDatabaseName('s', 0, 'zz')).toThrow(TypeError);
  });

  it('only recognises its own names when reading the timestamp', () => {
    expect(testDatabaseCreatedAtMs('prysm')).toBeNull();
    expect(testDatabaseCreatedAtMs('prysm_template')).toBeNull();
    expect(testDatabaseCreatedAtMs('prysm_t_notanumber_x')).toBeNull();
  });
});

describe('scoped sweep prefixes', () => {
  it('parses names under the default prefix exactly as before, and under another prefix only when asked', () => {
    const name = testDatabaseName('x', 1_790_000_123_000, 'abcdef');
    expect(testDatabaseCreatedAtMs(name)).toBe(1_790_000_123_000);
    expect(testDatabaseCreatedAtMs(name, 'prysm_other_')).toBeNull();
    expect(testDatabaseCreatedAtMs('prysm_other_1790000123_x_abcdef')).toBeNull();
    expect(testDatabaseCreatedAtMs('prysm_other_1790000123_x_abcdef', 'prysm_other_')).toBe(1_790_000_123_000);
  });

  it('accepts only prysm_<words>_ prefixes', () => {
    expect(isSweepPrefix('prysm_t_')).toBe(true);
    expect(isSweepPrefix('prysm_sweeptest_')).toBe(true);
    for (const bad of ['', 'prysm_', 'prysm_template_', 'postgres_', 'prysm_x', 'prysm_%_', "prysm_a'_", 'PRYSM_a_'])
      expect(isSweepPrefix(bad), bad).toBe(false);
  });
});
