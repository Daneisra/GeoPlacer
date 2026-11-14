import { describe, expect, it } from 'vitest';
import type { ColorDistance, Palette, QuantizedImage, Rgb } from '../src/index.js';
import {
  ColorError,
  TRANSPARENT_U32,
  agentColors,
  countColors,
  createPaletteManager,
  createPaletteMatcher,
  missingColors,
  oklabDistance,
  quantizeRgba,
  quantizeWithMatcher,
  rgb,
  rgbEuclideanDistance,
} from '../src/index.js';

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(255, 255, 255);
const RED = rgb(255, 0, 0);
const GREEN = rgb(0, 255, 0);
const BLUE = rgb(0, 0, 255);

function expectColorError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ColorError);
    expect((error as ColorError).code).toBe(code);
    return;
  }
  throw new Error(`expected ColorError ${code}`);
}

/** RGBA buffer from [r, g, b, a] tuples. */
function rgba(...pixels: ReadonlyArray<readonly [number, number, number, number]>): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flat());
}

describe('nearest color', () => {
  it('returns exact palette colors unchanged', () => {
    const matcher = createPaletteMatcher([BLACK, WHITE, RED], oklabDistance);
    expect(matcher.nearest(RED)).toBe(RED);
    expect(matcher.isExact(RED)).toBe(true);
    expect(matcher.isExact(BLUE)).toBe(false);
  });

  it('picks the perceptually closest color for near colors', () => {
    const matcher = createPaletteMatcher([BLACK, WHITE, RED, GREEN, BLUE], oklabDistance);
    expect(matcher.nearest(rgb(250, 5, 5))).toBe(RED);
    expect(matcher.nearest(rgb(3, 3, 3))).toBe(BLACK);
    expect(matcher.nearest(rgb(252, 252, 252))).toBe(WHITE);
    expect(matcher.nearest(rgb(10, 10, 240))).toBe(BLUE);
  });

  it('documents where OKLab and the legacy RGB metric disagree', () => {
    // Mid gray #777777 has OKLab lightness 0.569: perceptually nearer white.
    const gray = rgb(0x77, 0x77, 0x77);
    expect(createPaletteMatcher([BLACK, WHITE], oklabDistance).nearest(gray)).toBe(WHITE);
    expect(createPaletteMatcher([BLACK, WHITE], rgbEuclideanDistance).nearest(gray)).toBe(BLACK);
  });

  it('breaks ties deterministically: the first color in palette order wins', () => {
    // (100,0,0) is exactly 10 away from both (90,0,0) and (110,0,0) in RGB.
    const a = rgb(90, 0, 0);
    const b = rgb(110, 0, 0);
    const source = rgb(100, 0, 0);
    expect(createPaletteMatcher([a, b], rgbEuclideanDistance).nearest(source)).toBe(a);
    expect(createPaletteMatcher([b, a], rgbEuclideanDistance).nearest(source)).toBe(b);
    // A metric where everything is equidistant always yields the first color.
    const flat: ColorDistance = { id: 'flat', distance: (x, y) => (x === y ? 0 : 1) };
    expect(createPaletteMatcher([GREEN, RED, BLUE], flat).nearest(rgb(1, 2, 3))).toBe(GREEN);
  });

  it('deduplicates the palette, keeping the first occurrence', () => {
    const matcher = createPaletteMatcher([RED, BLUE, RED, WHITE, BLUE], oklabDistance);
    expect(matcher.colors).toEqual([RED, BLUE, WHITE]);
    expect(matcher.nearestIndex(WHITE)).toBe(2);
  });

  it('rejects empty and invalid palettes', () => {
    expectColorError(() => createPaletteMatcher([], oklabDistance), 'EMPTY_PALETTE');
    expectColorError(() => createPaletteMatcher([0x1000000 as Rgb], oklabDistance), 'INVALID_RGB');
    expectColorError(() => createPaletteMatcher([-1 as Rgb], oklabDistance), 'INVALID_RGB');
  });

  it('the Euclidean fast path picks exactly what the generic path picks', () => {
    // Same OKLab metric, but without euclideanSpace: forces the generic path.
    const generic: ColorDistance = { id: 'oklab-generic', distance: (a, b) => oklabDistance.distance(a, b) };
    const palette: Rgb[] = [];
    for (const r of [0, 85, 170, 255]) for (const g of [0, 85, 170, 255]) for (const b of [0, 85, 170, 255]) palette.push(rgb(r, g, b));
    const fast = createPaletteMatcher(palette, oklabDistance, 0);
    const slow = createPaletteMatcher(palette, generic, 0);
    let seed = 2024;
    let differences = 0;
    for (let i = 0; i < 50_000; i++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const color = (seed & 0xffffff) as Rgb;
      if (fast.nearestIndex(color) !== slow.nearestIndex(color)) differences++;
    }
    expect(differences).toBe(0);
  });

  it('gives the same answers when its bounded memo is cleared', () => {
    const colors = [BLACK, WHITE, RED, GREEN, BLUE];
    const reference = createPaletteMatcher(colors, oklabDistance);
    const tiny = createPaletteMatcher(colors, oklabDistance, 2);
    for (let v = 0; v < 0xffffff; v += 99_991) {
      expect(tiny.nearest(v as Rgb)).toBe(reference.nearest(v as Rgb));
    }
  });
});

describe('quantization', () => {
  const colors = [BLACK, WHITE, RED];

  it('maps pixels row-major into a compact Uint32Array', () => {
    const { image, stats } = quantizeRgba(
      rgba([255, 0, 0, 255], [250, 10, 10, 255], [0, 0, 0, 255], [255, 255, 255, 255], [1, 1, 1, 255], [0, 0, 0, 0]),
      3,
      2,
      colors,
      oklabDistance,
      { alphaThreshold: 128 }
    );
    expect(image.pixels).toBeInstanceOf(Uint32Array);
    expect([...image.pixels]).toEqual([RED, RED, BLACK, WHITE, BLACK, TRANSPARENT_U32]);
    expect(stats).toEqual({ pixels: 6, transparent: 1, exact: 3, approximated: 2 });
  });

  it('never confuses transparency with black', () => {
    const { image } = quantizeRgba(rgba([0, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 127], [0, 0, 0, 128]), 2, 2, colors, oklabDistance, {
      alphaThreshold: 128,
    });
    expect([...image.pixels]).toEqual([BLACK, TRANSPARENT_U32, TRANSPARENT_U32, BLACK]);
  });

  it('uses the RGB of semi-transparent pixels as is (no blending)', () => {
    const { image } = quantizeRgba(rgba([255, 0, 0, 200]), 1, 1, colors, oklabDistance, { alphaThreshold: 128 });
    expect(image.pixels[0]).toBe(RED);
  });

  it('honours the alpha threshold bounds', () => {
    const buffer = rgba([255, 0, 0, 0], [255, 0, 0, 255]);
    expect([...quantizeRgba(buffer, 2, 1, colors, oklabDistance, { alphaThreshold: 0 }).image.pixels]).toEqual([RED, RED]);
    expect([...quantizeRgba(buffer, 2, 1, colors, oklabDistance, { alphaThreshold: 256 }).image.pixels]).toEqual([
      TRANSPARENT_U32,
      TRANSPARENT_U32,
    ]);
    for (const bad of [-1, 257, 1.5]) {
      expectColorError(() => quantizeRgba(buffer, 2, 1, colors, oklabDistance, { alphaThreshold: bad }), 'INVALID_ALPHA_THRESHOLD');
    }
  });

  it('is deterministic and independent of memo clearing', () => {
    const width = 64;
    const height = 32;
    const buffer = new Uint8ClampedArray(width * height * 4);
    let seed = 42;
    for (let i = 0; i < buffer.length; i++) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      buffer[i] = seed & 0xff;
    }
    const palette = [BLACK, WHITE, RED, GREEN, BLUE, rgb(128, 128, 128)];
    const first = quantizeRgba(buffer, width, height, palette, oklabDistance, { alphaThreshold: 128 });
    const second = quantizeRgba(buffer, width, height, palette, oklabDistance, { alphaThreshold: 128 });
    const tinyMemo = quantizeWithMatcher(buffer, width, height, createPaletteMatcher(palette, oklabDistance, 3), { alphaThreshold: 128 });
    expect([...second.image.pixels]).toEqual([...first.image.pixels]);
    expect([...tinyMemo.image.pixels]).toEqual([...first.image.pixels]);
  });

  it('rejects buffers that do not match the declared size', () => {
    expectColorError(() => quantizeRgba(new Uint8ClampedArray(7), 1, 2, colors, oklabDistance, { alphaThreshold: 128 }), 'INVALID_IMAGE');
    expectColorError(() => quantizeRgba(new Uint8ClampedArray(0), 0, 0, colors, oklabDistance, { alphaThreshold: 128 }), 'INVALID_IMAGE');
  });
});

describe('per-agent palettes and missing colors', () => {
  const catalog: Palette = {
    id: 'catalog',
    colors: [{ rgb: WHITE }, { rgb: BLACK }, { rgb: RED }, { rgb: GREEN }, { rgb: BLUE }],
  };
  const image: QuantizedImage = { width: 3, height: 1, pixels: new Uint32Array([RED, BLUE, TRANSPARENT_U32]) };

  it('builds each agent palette in a deterministic order', () => {
    const custom = rgb(0x12, 0x34, 0x56);
    expect(agentColors(catalog, new Set([BLUE, RED, custom, BLACK]))).toEqual([BLACK, RED, BLUE, custom]);
    expect(agentColors(catalog, new Set([GREEN]))).toEqual([GREEN]);
  });

  it('reports the colors each agent is missing', () => {
    expect([...missingColors(image, new Set([RED, BLUE]))]).toEqual([]);
    expect([...missingColors(image, new Set([RED]))]).toEqual([BLUE]);
    // Ascending numeric order: 0x0000ff before 0xff0000.
    expect([...missingColors(image, new Set())]).toEqual([BLUE, RED]);
  });

  it('quantizes differently for agents with different palettes', () => {
    const buffer = rgba([240, 10, 10, 255], [10, 240, 10, 255]);
    const agentA = agentColors(catalog, new Set([RED, GREEN]));
    const agentB = agentColors(catalog, new Set([BLACK, WHITE]));
    expect([...quantizeRgba(buffer, 2, 1, agentA, oklabDistance, { alphaThreshold: 128 }).image.pixels]).toEqual([RED, GREEN]);
    const forB = [...quantizeRgba(buffer, 2, 1, agentB, oklabDistance, { alphaThreshold: 128 }).image.pixels];
    expect(forB.every((c) => c === BLACK || c === WHITE)).toBe(true);
  });

  it('counts colors without counting transparency', () => {
    expect([...countColors(image)]).toEqual([
      [RED, 1],
      [BLUE, 1],
    ]);
  });
});

describe('PaletteManager contract', () => {
  const manager = createPaletteManager();

  it('implements nearest, quantize and missingColors', () => {
    const palette: Palette = { id: 'p', colors: [{ rgb: BLACK }, { rgb: WHITE }] };
    expect(manager.nearest(rgb(10, 10, 10), [BLACK, WHITE], oklabDistance)).toBe(BLACK);
    const image = manager.quantize(rgba([250, 250, 250, 255], [0, 0, 0, 0]), 2, 1, palette, { distance: oklabDistance, alphaThreshold: 128 });
    expect([...image.pixels]).toEqual([WHITE, TRANSPARENT_U32]);
    expect([...manager.missingColors(image, new Set([BLACK]))]).toEqual([WHITE]);
  });
});
