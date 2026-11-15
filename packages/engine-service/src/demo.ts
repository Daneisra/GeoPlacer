/**
 * Demonstration (Phase 1B.10): an ORIGINAL example template, drawn by code
 * (no download, no binary file in the repository), freely redistributable
 * with GeoPlacer (AGPL-3.0-only), and synthetic settings made to watch the
 * simulation for about two minutes.
 *
 * The picture: a landscape at sunset (sky bands, sun, two mountains with
 * snow, a lake, a house with a roof and a door, a tree, grass), with only
 * colors that the demo agent has unlocked, so that the run can finish.
 */

import type { Rgb } from '@geoplacer/core';
import { DEMO_COLORS } from './settings.js';

export const DEMO_TEMPLATE_NAME = 'Démonstration — paysage';
export const DEMO_WIDTH = 96;
export const DEMO_HEIGHT = 64;
export const DEMO_POSITION = { x: 16, y: 16 } as const;
export const DEMO_STRATEGY = 'center-out';

/** Synthetic demo settings: a small canvas, fast regeneration (40 energy per second), enough to try upgrades. */
export const DEMO_SETTINGS = {
  simulator: { width: 128, height: 96, costPerPixel: 1, capacity: 400, regenIntervalMs: 25, writeLatencyMs: 30 },
  agent: { startEnergy: 400, startCurrency: 1500 },
  run: { maxBatchSize: 40, minBatchSize: 10 },
} as const;

const C = (i: number): Rgb => DEMO_COLORS[i]!;
const BLACK = C(0);
const WHITE = C(1);
const GREY = C(2);
const LIGHT_GREY = C(3);
const RED = C(4);
const ORANGE = C(5);
const YELLOW = C(6);
const GREEN = C(7);
const BLUE = C(8);
const DARK_BLUE = C(9);
const PURPLE = C(10);
const BROWN = C(11);
const PINK = C(12);
const GOLD = C(13);
const LIME = C(14);
const SKY = C(15);

/** The demo picture, 0xRRGGBB per pixel (no transparency: a full rectangle). */
export function demoPixels(): Uint32Array {
  const w = DEMO_WIDTH;
  const h = DEMO_HEIGHT;
  const px = new Uint32Array(w * h);
  const set = (x: number, y: number, c: Rgb) => {
    if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c;
  };
  // Sky: sunset bands.
  const bands = [PURPLE, PINK, ORANGE, GOLD, SKY];
  for (let y = 0; y < 34; y++) for (let x = 0; x < w; x++) set(x, y, bands[Math.min(bands.length - 1, Math.floor(y / 7))]!);
  // Sun.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - 70) ** 2 + (y - 14) ** 2 <= 49) set(x, y, YELLOW);
  // Mountains with snow.
  const mountain = (cx: number, top: number, half: number, color: Rgb) => {
    for (let y = top; y < 40; y++) {
      const span = Math.floor(((y - top) * half) / (40 - top));
      for (let x = cx - span; x <= cx + span; x++) set(x, y, y < top + 5 ? WHITE : color);
    }
  };
  mountain(24, 12, 26, GREY);
  mountain(52, 18, 22, LIGHT_GREY);
  // Ground and lake.
  for (let y = 40; y < h; y++) for (let x = 0; x < w; x++) set(x, y, (x + y) % 9 === 0 ? LIME : GREEN);
  for (let y = 44; y < h; y++) for (let x = 0; x < w; x++) if (((x - 26) / 20) ** 2 + ((y - 54) / 7) ** 2 <= 1) set(x, y, y % 3 === 0 ? BLUE : DARK_BLUE);
  // House: walls, roof, door, window.
  for (let y = 40; y < 56; y++) for (let x = 62; x < 82; x++) set(x, y, WHITE);
  for (let y = 30; y < 40; y++) for (let x = 60 + (y - 30); x < 84 - (y - 30); x++) set(x, y, RED);
  for (let y = 47; y < 56; y++) for (let x = 70; x < 75; x++) set(x, y, BROWN);
  for (let y = 43; y < 47; y++) for (let x = 64; x < 68; x++) set(x, y, SKY);
  // Tree.
  for (let y = 44; y < 58; y++) for (let x = 88; x < 90; x++) set(x, y, BROWN);
  for (let y = 32; y < 48; y++) for (let x = 82; x < 96; x++) if ((x - 89) ** 2 + (y - 40) ** 2 <= 36) set(x, y, (x + y) % 4 === 0 ? LIME : GREEN);
  // Frame.
  for (let x = 0; x < w; x++) {
    set(x, 0, BLACK);
    set(x, h - 1, BLACK);
  }
  for (let y = 0; y < h; y++) {
    set(0, y, BLACK);
    set(w - 1, y, BLACK);
  }
  return px;
}

/** The demo picture as RGBA bytes (for the PNG encoder). */
export function demoRgba(): Uint8Array {
  const px = demoPixels();
  const out = new Uint8Array(px.length * 4);
  for (let i = 0; i < px.length; i++) {
    const c = px[i]!;
    out.set([(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 255], i * 4);
  }
  return out;
}
