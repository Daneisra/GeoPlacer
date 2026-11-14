/**
 * Compact color table for color-by-color: open addressing in typed arrays,
 * from a 32-bit pixel value to a dense id (0, 1, 2… in order of first
 * appearance). Replaces a Map lookup per pixel (Phase 1B.4 optimization).
 *
 * Load factor at most 1/2, multiplicative hashing on the high bits, linear
 * probing. A quantized template has a few dozen colors, so the table stays
 * in the CPU cache.
 */

const EMPTY = -1;

export class ColorIdTable {
  private keys: Uint32Array;
  private ids: Int32Array;
  private bits: number;
  /** Colors by id. */
  private byId: Uint32Array;
  private count = 0;

  constructor(expectedColors = 32) {
    this.bits = 4;
    while (1 << this.bits < expectedColors * 2) this.bits++;
    this.keys = new Uint32Array(1 << this.bits);
    this.ids = new Int32Array(1 << this.bits).fill(EMPTY);
    this.byId = new Uint32Array(1 << (this.bits - 1));
  }

  get size(): number {
    return this.count;
  }

  colorOf(id: number): number {
    return this.byId[id]!;
  }

  /** Id of `color`, or -1 when absent. */
  find(color: number): number {
    const mask = (1 << this.bits) - 1;
    for (let h = Math.imul(color, 0x9e3779b1) >>> (32 - this.bits); ; h = (h + 1) & mask) {
      const id = this.ids[h]!;
      if (id === EMPTY || this.keys[h] === color) return id;
    }
  }

  /** Id of `color`, inserting it with the next id when absent. */
  idOf(color: number): number {
    const mask = (1 << this.bits) - 1;
    let h = Math.imul(color, 0x9e3779b1) >>> (32 - this.bits);
    for (;;) {
      const id = this.ids[h]!;
      if (id === EMPTY) break;
      if (this.keys[h] === color) return id;
      h = (h + 1) & mask;
    }
    const id = this.count++;
    this.keys[h] = color;
    this.ids[h] = id;
    if (id >= this.byId.length) {
      const grown = new Uint32Array(this.byId.length * 2);
      grown.set(this.byId);
      this.byId = grown;
    }
    this.byId[id] = color;
    if (this.count * 2 > 1 << this.bits) this.grow();
    return id;
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldIds = this.ids;
    this.bits++;
    this.keys = new Uint32Array(1 << this.bits);
    this.ids = new Int32Array(1 << this.bits).fill(EMPTY);
    const mask = (1 << this.bits) - 1;
    for (let k = 0; k < oldIds.length; k++) {
      const id = oldIds[k]!;
      if (id === EMPTY) continue;
      const color = oldKeys[k]!;
      let h = Math.imul(color, 0x9e3779b1) >>> (32 - this.bits);
      while (this.ids[h] !== EMPTY) h = (h + 1) & mask;
      this.keys[h] = color;
      this.ids[h] = id;
    }
  }
}
