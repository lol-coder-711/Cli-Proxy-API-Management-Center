import { test, expect, describe } from 'bun:test';
import {
  claudeRemainingPercent,
  probeResultHasUsableRateLimit,
  buildClaudeRateLimitProbeWindows,
  normalizeClaudeUtilizationPercent,
  normalizeClaudeRateLimitStatus,
  normalizeClaudeRepresentativeClaim,
  normalizeFlagValue,
  resolveClaudePlanType,
} from './quotaConfigs';
import type { ClaudeQuotaWindow } from '@/types/quota';

// Stub i18n: return the key so we can assert on labelKey wiring without a
// real translation table.
const t = ((key: string) => key) as never;

describe('normalizeClaudeUtilizationPercent (Fix 3: overage fraction >1.0)', () => {
  test('null/undefined stays null', () => {
    expect(normalizeClaudeUtilizationPercent(undefined)).toBeNull();
    expect(normalizeClaudeUtilizationPercent(null)).toBeNull();
  });

  test('non-numeric string => null', () => {
    expect(normalizeClaudeUtilizationPercent('abc')).toBeNull();
    expect(normalizeClaudeUtilizationPercent('')).toBeNull();
  });

  test('0 fraction => 0% used', () => {
    expect(normalizeClaudeUtilizationPercent('0')).toBe(0);
    expect(normalizeClaudeUtilizationPercent(0)).toBe(0);
  });

  test('0.26 fraction => 26% used', () => {
    expect(normalizeClaudeUtilizationPercent('0.26')).toBe(26);
  });

  test('accepts a numeric (not just string) fraction', () => {
    expect(normalizeClaudeUtilizationPercent(0.03)).toBeCloseTo(3, 5);
  });

  test('1.0 fraction => 100% used', () => {
    expect(normalizeClaudeUtilizationPercent('1')).toBe(100);
  });

  test('REGRESSION: 1.17 overage fraction => 117% used, NOT 1.17%', () => {
    // This is the exact header an exhausted 5h window returns
    // (anthropic-ratelimit-unified-5h-utilization: 1.17). The old
    // <=1 heuristic returned 1.17, making the card show ~99% remaining.
    expect(normalizeClaudeUtilizationPercent('1.17')).toBe(117);
  });

  test('large overage 2.5 => 250% used (still scaled, not passed through)', () => {
    expect(normalizeClaudeUtilizationPercent('2.5')).toBe(250);
  });

  test('exhausted window (1.17 used) => 0% remaining after clamp', () => {
    const used = normalizeClaudeUtilizationPercent('1.17');
    expect(claudeRemainingPercent(used)).toBe(0); // clamped, not 99
  });
});

describe('normalizeClaudeRateLimitStatus', () => {
  test('lowercases status values', () => {
    expect(normalizeClaudeRateLimitStatus('REJECTED')).toBe('rejected');
    expect(normalizeClaudeRateLimitStatus('Allowed')).toBe('allowed');
  });

  test('trims and lowercases', () => {
    expect(normalizeClaudeRateLimitStatus('  rejected  ')).toBe('rejected');
  });

  test('empty/null => null', () => {
    expect(normalizeClaudeRateLimitStatus('')).toBeNull();
    expect(normalizeClaudeRateLimitStatus(null)).toBeNull();
    expect(normalizeClaudeRateLimitStatus(undefined)).toBeNull();
  });
});

describe('normalizeClaudeRepresentativeClaim', () => {
  test('canonicalizes five_hour aliases', () => {
    expect(normalizeClaudeRepresentativeClaim('five_hour')).toBe('five_hour');
    expect(normalizeClaudeRepresentativeClaim('five-hour')).toBe('five_hour');
    expect(normalizeClaudeRepresentativeClaim('5H')).toBe('five_hour');
  });

  test('canonicalizes seven_day aliases', () => {
    expect(normalizeClaudeRepresentativeClaim('seven_day')).toBe('seven_day');
    expect(normalizeClaudeRepresentativeClaim('seven-day')).toBe('seven_day');
    expect(normalizeClaudeRepresentativeClaim('7d')).toBe('seven_day');
  });

  test('unknown value passes through lowercased', () => {
    expect(normalizeClaudeRepresentativeClaim('Opus')).toBe('opus');
  });

  test('empty/null => null', () => {
    expect(normalizeClaudeRepresentativeClaim('')).toBeNull();
    expect(normalizeClaudeRepresentativeClaim(null)).toBeNull();
  });
});

describe('normalizeFlagValue', () => {
  test('passes through booleans', () => {
    expect(normalizeFlagValue(true)).toBe(true);
    expect(normalizeFlagValue(false)).toBe(false);
  });

  test('numbers: nonzero true, zero false', () => {
    expect(normalizeFlagValue(1)).toBe(true);
    expect(normalizeFlagValue(0)).toBe(false);
  });

  test('truthy strings', () => {
    for (const v of ['true', '1', 'yes', 'y', 'on', 'ON', ' True ']) {
      expect(normalizeFlagValue(v)).toBe(true);
    }
  });

  test('falsy strings', () => {
    for (const v of ['false', '0', 'no', 'n', 'off']) {
      expect(normalizeFlagValue(v)).toBe(false);
    }
  });

  test('undefined/null/unknown => undefined', () => {
    expect(normalizeFlagValue(undefined)).toBeUndefined();
    expect(normalizeFlagValue(null)).toBeUndefined();
    expect(normalizeFlagValue('maybe')).toBeUndefined();
  });
});

describe('resolveClaudePlanType (setup-token plan detection)', () => {
  test('null profile => null', () => {
    expect(resolveClaudePlanType(null)).toBeNull();
  });

  test('has_claude_max wins => plan_max', () => {
    expect(resolveClaudePlanType({ account: { has_claude_max: true } } as never)).toBe('plan_max');
  });

  test('has_claude_pro => plan_pro', () => {
    expect(
      resolveClaudePlanType({ account: { has_claude_max: false, has_claude_pro: true } } as never)
    ).toBe('plan_pro');
  });

  test('active claude_team org => plan_team', () => {
    expect(
      resolveClaudePlanType({
        account: {},
        organization: { organization_type: 'claude_team', subscription_status: 'active' },
      } as never)
    ).toBe('plan_team');
  });

  test('explicit no-max + no-pro => plan_free', () => {
    expect(
      resolveClaudePlanType({ account: { has_claude_max: false, has_claude_pro: false } } as never)
    ).toBe('plan_free');
  });

  test('indeterminate (no flags, no org) => null', () => {
    expect(resolveClaudePlanType({ account: {} } as never)).toBeNull();
  });
});

describe('end-to-end: real exhausted-account probe headers', () => {
  test('susanna 5h exhausted (utilization 1.17, rejected) => 0% remaining', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-status': ['rejected'],
      'anthropic-ratelimit-unified-5h-utilization': ['1.17'],
      'anthropic-ratelimit-unified-5h-reset': ['1780005600'],
      'anthropic-ratelimit-unified-7d-status': ['allowed'],
      'anthropic-ratelimit-unified-7d-utilization': ['0.15'],
      'anthropic-ratelimit-unified-7d-reset': ['1780498800'],
    };
    const windows = buildClaudeRateLimitProbeWindows(headers, t);
    const byId = Object.fromEntries(windows.map((w) => [w.id, w]));

    // 5h: 117% used -> 0% remaining (was the 99% bug)
    expect(byId['five-hour'].status).toBe('rejected');
    expect(claudeRemainingPercent(byId['five-hour'].usedPercent)).toBe(0);

    // 7d: 15% used -> 85% remaining
    expect(byId['seven-day'].status).toBe('allowed');
    expect(claudeRemainingPercent(byId['seven-day'].usedPercent)).toBe(85);
  });

  test('qiyin healthy account (5h 0.26 + 7d 0.03, both allowed)', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-status': ['allowed'],
      'anthropic-ratelimit-unified-5h-utilization': ['0.26'],
      'anthropic-ratelimit-unified-5h-reset': ['1780006200'],
      'anthropic-ratelimit-unified-7d-status': ['allowed'],
      'anthropic-ratelimit-unified-7d-utilization': ['0.03'],
      'anthropic-ratelimit-unified-7d-reset': ['1780254000'],
    };
    const byId = Object.fromEntries(
      buildClaudeRateLimitProbeWindows(headers, t).map((w) => [w.id, w])
    );
    expect(byId['five-hour'].status).toBe('allowed');
    expect(claudeRemainingPercent(byId['five-hour'].usedPercent)).toBe(74);
    expect(byId['seven-day'].status).toBe('allowed');
    expect(claudeRemainingPercent(byId['seven-day'].usedPercent)).toBe(97);
  });
});

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

  test('utilization fraction 0.42 => 42% used / 58% remaining', () => {
    // Anthropic always sends utilization as a fraction (0.42), never as a
    // 0-100 percent. The window must scale it to 42%.
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-7d-utilization': ['0.42'],
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

  test('window with status+reset but no utilization => kept, usedPercent null', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-status': ['rejected'],
      'anthropic-ratelimit-unified-5h-reset': ['1780005600'],
    };
    const windows = buildClaudeRateLimitProbeWindows(headers, t);
    expect(windows.length).toBe(1);
    expect(windows[0].usedPercent).toBeNull();
    expect(windows[0].status).toBe('rejected');
    expect(windows[0].resetLabel).not.toBe('-');
    // remaining renders as -- when usedPercent is null
    expect(claudeRemainingPercent(windows[0].usedPercent)).toBeNull();
  });

  test('a window with no signals at all is skipped', () => {
    // 5h fully present, 7d has nothing => only 5h window emitted
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-utilization': ['0.5'],
    };
    const windows = buildClaudeRateLimitProbeWindows(headers, t);
    expect(windows.map((w) => w.id)).toEqual(['five-hour']);
    expect(windows[0].usedPercent).toBe(50);
  });

  test('status casing is normalized to lowercase', () => {
    const headers: Record<string, string[]> = {
      'anthropic-ratelimit-unified-5h-status': ['REJECTED'],
      'anthropic-ratelimit-unified-5h-utilization': ['1.0'],
    };
    expect(buildClaudeRateLimitProbeWindows(headers, t)[0].status).toBe('rejected');
  });
});
