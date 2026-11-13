/**
 * Settings validation, in-place update and load sanitisation tests
 */

import { applySettingsUpdate, sanitizeLoadedSettings } from '../config/settings-update.js';
import { DEFAULT_SETTINGS } from '../config/default-settings.js';
import { settingsSchema } from '../middleware/validation.js';
import type { Settings } from '../types/index.js';

const fresh = (): Settings => ({ ...DEFAULT_SETTINGS });

describe('settingsSchema vs defaults', () => {
  it('accepts the default settings (the fix must not reject its own defaults)', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });

  it('covers every default settings key', () => {
    const parsed = settingsSchema.parse(DEFAULT_SETTINGS);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('applySettingsUpdate', () => {
  it('applies a valid partial update in place (same object reference)', () => {
    const current = fresh();
    const ref = current;
    const result = applySettingsUpdate(current, { accountCooldown: 12345, drawingDirection: 'center_out' });
    expect(result).toEqual({ ok: true, changed: ['accountCooldown', 'drawingDirection'] });
    expect(ref.accountCooldown).toBe(12345);
    expect(ref.drawingDirection).toBe('center_out');
  });

  it('accepts the payload shape sent by the settings page and ignores unknown fields', () => {
    const current = fresh();
    const uiPayload = {
      openBrowserOnStart: false,
      drawingDirection: 'btt',
      drawingOrder: 'color',
      pixelSkip: 2,
      accountCooldown: 30 * 1000,
      purchaseCooldown: 5 * 1000,
      accountCheckCooldown: 0, // not a backend setting
      dropletReserve: 0,
      antiGriefStandby: 10 * 60000,
      chargeThreshold: 50 / 100,
      proxyEnabled: false,
      proxyRotationMode: 'sequential',
      logProxyUsage: false,
    };
    const result = applySettingsUpdate(current, uiPayload);
    expect(result.ok).toBe(true);
    expect(current).not.toHaveProperty('accountCheckCooldown');
    expect(current.pixelSkip).toBe(2);
  });

  it('accepts every value the settings page can send (bounds of each control)', () => {
    // Settings.tsx converts seconds (x1000) and minutes (x60000) to ms.
    const uiValues: Record<string, unknown[]> = {
      pixelSkip: [1, 2, 4, 8, 16, 32, 64, 128], // <select> options
      accountCooldown: [0, 1 * 1000, 600 * 1000], // number input, min 0 (0 = no wait)
      purchaseCooldown: [0, 5 * 1000, 600 * 1000], // number input, min 0
      antiGriefStandby: [1 * 60000, 10 * 60000, 24 * 60 * 60000], // minutes, min 1
      dropletReserve: [0, 10_000, 5_000_000], // number input, min 0, no max
      chargeThreshold: [0, 0.5, 1], // percent / 100
      drawingDirection: ['ttb', 'btt', 'ltr', 'rtl', 'center_out', 'random'],
      drawingOrder: ['linear', 'color'],
      proxyRotationMode: ['sequential', 'random'],
    };
    for (const [field, values] of Object.entries(uiValues)) {
      for (const value of values) {
        const result = applySettingsUpdate(fresh(), { [field]: value });
        expect({ field, value, ok: result.ok }).toEqual({ field, value, ok: true });
      }
    }
  });

  it('rejects invalid values and leaves the settings untouched', () => {
    for (const body of [
      { drawingDirection: 'diagonal' },
      { drawingOrder: 'randomColor' },
      { accountCooldown: 'fast' },
      { accountCooldown: -1 },
      { chargeThreshold: 2 },
      { pixelSkip: 0 },
      { pixelSkip: 3 },
      { pixelSkip: 256 },
    ]) {
      const current = fresh();
      const result = applySettingsUpdate(current, body);
      expect(result.ok).toBe(false);
      expect(current).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('rejects a valid field mixed with an invalid one, atomically', () => {
    const current = fresh();
    const result = applySettingsUpdate(current, { accountCooldown: 12345, drawingDirection: 'diagonal' });
    expect(result.ok).toBe(false);
    expect(current.accountCooldown).toBe(DEFAULT_SETTINGS.accountCooldown);
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, 'x', 42, [1, 2]]) {
      expect(applySettingsUpdate(fresh(), body).ok).toBe(false);
    }
  });

  it('reports field paths in issues', () => {
    const result = applySettingsUpdate(fresh(), { drawingDirection: 'diagonal' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].path).toBe('drawingDirection');
  });
});

describe('sanitizeLoadedSettings', () => {
  it('keeps valid values and replaces invalid ones by defaults', () => {
    const { settings, rejected } = sanitizeLoadedSettings(
      { accountCooldown: 12345, drawingDirection: 'diagonal', keepAliveCooldown: 10, legacyField: true },
      DEFAULT_SETTINGS
    );
    expect(settings.accountCooldown).toBe(12345);
    expect(settings.drawingDirection).toBe(DEFAULT_SETTINGS.drawingDirection);
    expect(settings.keepAliveCooldown).toBe(DEFAULT_SETTINGS.keepAliveCooldown);
    expect(settings).not.toHaveProperty('legacyField');
    expect(rejected.sort()).toEqual(['drawingDirection', 'keepAliveCooldown']);
  });

  it('returns defaults for a non-object file content', () => {
    expect(sanitizeLoadedSettings([1, 2], DEFAULT_SETTINGS)).toEqual({ settings: DEFAULT_SETTINGS, rejected: ['<root>'] });
  });
});
