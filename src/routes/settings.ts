/**
 * Settings management routes
 */

import { Router, Request, Response } from 'express';
import { HTTP_STATUS } from '../config/constants.js';
import type { Settings } from '../types/index.js';
import { applySettingsUpdate } from '../config/settings-update.js';

let currentSettings: Settings;
let saveSettings: () => void;
let loadedProxies: string[] = [];

export function setSettingsState(s: Settings): void {
  currentSettings = s;
}

export function setSaveSettings(fn: () => void): void {
  saveSettings = fn;
}

export function setLoadedProxies(proxies: string[]): void {
  loadedProxies = proxies;
}

const router = Router();

router.get('/settings', (_req: Request, res: Response) => {
  res.json({ ...currentSettings, proxyCount: loadedProxies.length });
});

router.put('/settings', (req: Request, res: Response): void => {
  // Validate, then mutate the shared settings object in place so that the
  // persistence function and the engine context see the same values.
  const result = applySettingsUpdate(currentSettings, req.body);
  if (!result.ok) {
    res.status(HTTP_STATUS.BAD_REQ).json({ error: 'Validation failed', issues: result.issues });
    return;
  }
  saveSettings();
  res.status(HTTP_STATUS.OK).json({ ok: true, changed: result.changed });
});

export default router;
