import { describe, expect, it } from 'vitest';
import type { Rgb, StrategyConfig, TemplateImage } from '../src/index.js';
import { StrategyError, colorByColor, colorRanking, isOutlinePixel, outlineFirst } from '../src/index.js';
import { art, coords, drainWith, image, inRegion, paintable, testRandom } from './helpers/strategy.js';

const C = (ch: string): Rgb => ch.charCodeAt(0) as Rgb; // art() colors are char codes
const byColor = (img: TemplateImage, config: Partial<StrategyConfig> = {}) => coords(img, colorByColor.order(img, { id: 'color-by-color', ...config }));
const outline = (img: TemplateImage) => coords(img, outlineFirst.order(img, { id: 'outline-first' }));

describe('color-by-color', () => {
  //   a a b
  //   c c c
  //   . a b      counts: a 3, b 2, c 3
  const img = art(['aab', 'ccc', '.ab']);

  it('paints the least frequent colors first, ties by RGB value, each color top to bottom', () => {
    expect(colorRanking(img, { id: 'color-by-color' })).toEqual({ colors: [C('b'), C('a'), C('c')], counts: [2, 3, 3] });
    expect(byColor(img)).toEqual(['2,0', '2,2', '0,0', '1,0', '1,2', '0,1', '1,1', '2,1']);
  });

  it('follows colorOrder first, ignores absent colors, then ranks the others', () => {
    expect(byColor(img, { colorOrder: [C('c'), C('z')] })).toEqual(['0,1', '1,1', '2,1', '2,0', '2,2', '0,0', '1,0', '1,2']);
    expect(byColor(img, { colorOrder: [C('a'), C('c'), C('b')] })).toEqual(['0,0', '1,0', '1,2', '0,1', '1,1', '2,1', '2,0', '2,2']);
  });

  it('handles a single color, 1 x 1 and fully transparent images', () => {
    expect(byColor(art(['xx', 'xx']))).toEqual(['0,0', '1,0', '0,1', '1,1']);
    expect(byColor(art(['x']))).toEqual(['0,0']);
    expect(byColor(art(['..']))).toEqual([]);
  });

  it('ranks colors on the whole image, not on the eligible region', () => {
    // In the region (right column) b is the most frequent, yet keeps its whole-image rank.
    const r = { ix: 2, iy: 0, width: 1, height: 3 };
    const full = [...colorByColor.order(img, { id: 'color-by-color' })];
    expect([...colorByColor.order(img, { id: 'color-by-color' }, r)]).toEqual(full.filter((i) => inRegion(img, r, i)));
  });

  it('groups every color contiguously on random images (counting sort, no pixel sort)', () => {
    const pick = testRandom(3);
    for (let t = 0; t < 30; t++) {
      const img2 = image(1 + pick(40), 1 + pick(40), () => (pick(6) === 0 ? null : 0x100000 * pick(5)));
      const order = [...colorByColor.order(img2, { id: 'color-by-color' })];
      const { colors } = colorRanking(img2, { id: 'color-by-color' });
      const expected = colors.flatMap((c) => paintable(img2).filter((i) => img2.pixels[i] === c));
      expect(order).toEqual(expected);
    }
  });

  it('rejects duplicate or invalid colorOrder entries', () => {
    expect(() => colorByColor.order(img, { id: 'color-by-color', colorOrder: [C('a'), C('a')] as never })).toThrow(StrategyError);
    expect(() => colorByColor.order(img, { id: 'color-by-color', colorOrder: [0x1000000] as never })).toThrow(StrategyError);
  });
});

describe('outline-first', () => {
  it('paints the border of a filled shape first, then its interior', () => {
    const square = art(['xxxx', 'xxxx', 'xxxx', 'xxxx']);
    const order = outline(square);
    expect(order.slice(0, 12)).toEqual(['0,0', '1,0', '2,0', '3,0', '0,1', '3,1', '0,2', '3,2', '0,3', '1,3', '2,3', '3,3']);
    expect(order.slice(12)).toEqual(['1,1', '2,1', '1,2', '2,2']);
  });

  it('treats transparent neighbours (holes) and other colors as edges', () => {
    // 5 x 5 square with a transparent hole: the ring around the hole is an outline too.
    const holed = art(['xxxxx', 'xxxxx', 'xx.xx', 'xxxxx', 'xxxxx']);
    const order = outline(holed);
    const interior = ['1,1', '3,1', '1,3', '3,3'];
    expect(order.slice(order.length - interior.length)).toEqual(interior);
    expect(order).toHaveLength(24);
    // A different color in the middle: it and its 4 neighbours are outline pixels.
    const marked = art(['xxxxx', 'xxxxx', 'xxyxx', 'xxxxx', 'xxxxx']);
    expect(outline(marked).slice(-4)).toEqual(interior);
    expect(isOutlinePixel(marked, 2, 2)).toBe(true);
    expect(isOutlinePixel(marked, 1, 1)).toBe(false);
  });

  it('handles thin shapes, 1 x 1 and fully transparent images', () => {
    expect(outline(art(['xxx']))).toEqual(['0,0', '1,0', '2,0']); // every pixel touches the image edge
    expect(outline(art(['x']))).toEqual(['0,0']);
    expect(outline(art(['...']))).toEqual([]);
  });

  it('matches the definition on random images, and filters by region without new outlines', () => {
    const pick = testRandom(5);
    for (let t = 0; t < 30; t++) {
      const img = image(1 + pick(30), 1 + pick(30), () => (pick(4) === 0 ? null : pick(3)));
      const all = paintable(img);
      const isEdge = (i: number) => isOutlinePixel(img, i % img.width, Math.floor(i / img.width));
      const expected = [...all.filter(isEdge), ...all.filter((i) => !isEdge(i))];
      const full = [...outlineFirst.order(img, { id: 'outline-first' })];
      expect(full).toEqual(expected);
      const r = { ix: pick(img.width), iy: pick(img.height), width: 0, height: 0 };
      const region = { ...r, width: pick(img.width - r.ix + 1), height: pick(img.height - r.iy + 1) };
      expect([...outlineFirst.order(img, { id: 'outline-first' }, region)]).toEqual(full.filter((i) => inRegion(img, region, i)));
      expect(drainWith(outlineFirst.cursor(img, { id: 'outline-first' }), [1, 4, 9])).toEqual(full);
    }
  });
});
