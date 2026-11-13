/**
 * Default settings (side-effect free so tests can import them).
 */

import type { Settings } from '../types/index.js';
import { MS } from './constants.js';

export const DEFAULT_SETTINGS: Settings = {
  accountCooldown: 20_000,
  purchaseCooldown: 5_000,
  keepAliveCooldown: MS.ONE_HOUR,
  dropletReserve: 0,
  antiGriefStandby: 600_000,
  drawingDirection: 'ttb',
  drawingOrder: 'linear',
  chargeThreshold: 0.5,
  pixelSkip: 1,
  proxyEnabled: false,
  proxyRotationMode: 'sequential',
  logProxyUsage: false,
  openBrowserOnStart: true,
};
