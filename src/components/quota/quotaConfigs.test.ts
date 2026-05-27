import { test, expect, describe } from 'bun:test';
import {
  claudeRemainingPercent,
  probeResultHasUsableRateLimit,
  buildClaudeRateLimitProbeWindows,
} from './quotaConfigs';
import type { ClaudeQuotaWindow } from '@/types/quota';

// Stub i18n: return the key so we can assert on labelKey wiring without a
// real translation table.
const t = ((key: string) => key) as never;

describe('claudeRemainingPercent (Fix 2: show remaining, not used)', () => {
  test('null utilization stays null (renders as --)', () => {
    expect(claudeRemainingPercent(null)).toBeNull();
  });

  test('0% used => 100% remaining', () => {
    expect(claudeRemainingPercent(0)).toBe(100);
  });

  test('30% used => 70% remaining (consistent with codex/gemini)', () => {
    expect(claudeRemainingPercent(30)).toBe(70);
  });

  test('100% used (exhausted) => 0% remaining', () => {
    expect(claudeRemainingPercent(100)).toBe(0);
  });

  test('clamps over-100 utilization to 0 remaining', () => {
    expect(claudeRemainingPercent(150)).toBe(0);
  });

  test('clamps negative utilization to 100 remaining', () => {
    expect(claudeRemainingPercent(-20)).toBe(100);
  });
});

describe('probeResultHasUsableRateLimit (Fix 1: 429 keeps reset/status)', () => {
  const emptyWindows: ClaudeQuotaWindow[] = [];
  const oneWindow: ClaudeQuotaWindow[] = [
    { id: 'five-hour', label: '5h', usedPercent: 100, resetLabel: '2026-05-28 10:00' },
  ];

  test('windows present => usable (exhausted account still renders)', () => {
    expect(probeResultHasUsableRateLimit(oneWindow, null, null, '-')).toBe(true);
  });

  test('only a reset timestamp present => usable', () => {
    expect(probeResultHasUsableRateLimit(emptyWindows, null, null, '2026-05-28 10:00')).toBe(true);
  });

  test('only an overall status present => usable', () => {
    expect(probeResultHasUsableRateLimit(emptyWindows, 'rejected', null, '-')).toBe(true);
  });

  test('only a representative claim present => usable', () => {
    expect(probeResultHasUsableRateLimit(emptyWindows, null, 'five_hour', '-')).toBe(true);
  });

  test('completely empty => NOT usable (genuine failure, should throw)', () => {
    expect(probeResultHasUsableRateLimit(emptyWindows, null, null, '-')).toBe(false);
  });
});

describe('buildClaudeRateLimitProbeWindows (header parsing)', () => {
  test('parses a 5h utilization fraction into used percent + reset + status', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-status': ['rejected'],
      'anthropic-ratelimit-unified-5h-utilization': ['1'], // 1.0 fraction => 100%
      'anthropic-ratelimit-unified-5h-reset': ['1780000000'],
    };
    const windows = buildClaudeRateLimitProbeWindows(headers, t);
    expect(windows.length).toBe(1);
    const w = windows[0];
    expect(w.id).toBe('five-hour');
    expect(w.usedPercent).toBe(100);
    expect(w.status).toBe('rejected');
    expect(w.resetLabel).not.toBe('-'); // a real reset timestamp was formatted
    // remaining derived from the parsed window => 0 (exhausted)
    expect(claudeRemainingPercent(w.usedPercent)).toBe(0);
  });

  test('utilization given as a 0-100 percent passes through (not re-scaled)', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-7d-utilization': ['42'],
    };
    const windows = buildClaudeRateLimitProbeWindows(headers, t);
    expect(windows.length).toBe(1);
    expect(windows[0].id).toBe('seven-day');
    expect(windows[0].usedPercent).toBe(42);
    expect(claudeRemainingPercent(windows[0].usedPercent)).toBe(58);
  });

  test('empty headers => no windows', () => {
    expect(buildClaudeRateLimitProbeWindows({}, t).length).toBe(0);
  });
});
