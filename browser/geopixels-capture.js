/* GeoPlacer original adapter. Contracts: GeoPixelsFront@74783af, ghost.js/getMapPixelHex.
 * Passive cache reader only. No fetch hooks, service requests or session credentials. */
globalThis.GeoPlacerCapture = (() => {
  const TILE = 1000;
  function tileAt(x, y) {
    const tileX = Math.floor(x / TILE) * TILE,
      tileY = Math.floor(y / TILE) * TILE;
    return { tileX, tileY, localX: x - tileX, localY: y - tileY };
  }
  function readRegion(project, rect, cache, createCanvas, report = () => {}) {
    const pixels = new Array(rect.width * rect.height).fill(-2);
    const decoded = new Map();
    for (let y = 0; y < rect.height; y++)
      for (let x = 0; x < rect.width; x++) {
        const gx = rect.x + x,
          gy = rect.y + y;
        if (gx < project.gridX || gx >= project.gridX + project.width || gy > project.gridY || gy <= project.gridY - project.height)
          continue;
        const t = tileAt(gx, gy),
          key = `${t.tileX},${t.tileY}`;
        if (!decoded.has(key)) {
          const bitmap = cache.get(key)?.colorBitmap;
          let data = null;
          if (bitmap && bitmap.width === TILE && bitmap.height === TILE) {
            try {
              const canvas = createCanvas(TILE, TILE),
                ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
              ctx.drawImage(bitmap, 0, 0);
              data = ctx.getImageData(0, 0, TILE, TILE).data;
            } catch (error) {
              report(`decode-error:${error.name}`);
              /* Merging, closed or tainted bitmap is unknown, never an empty tile. */
            }
          }
          if (!bitmap) report('missing-bitmap');
          else if (bitmap.width !== TILE || bitmap.height !== TILE) report('invalid-bitmap-size');
          decoded.set(key, data);
        }
        const data = decoded.get(key);
        if (!data) continue;
        const i = (t.localY * TILE + t.localX) * 4;
        pixels[y * rect.width + x] = data[i + 3] === 0 ? -1 : data[i + 3] === 255 ? (data[i] << 16) | (data[i + 1] << 8) | data[i + 2] : -2;
      }
    return pixels;
  }
  function resources(src, colors) {
    if (!src || Object.keys(src).length === 0) return null;
    const safe = (n) => (Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : null);
    const parsed = Array.isArray(colors)
      ? [...new Set(colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map((c) => parseInt(c.slice(1), 16)))]
      : null;
    return {
      observedAt: Number.isSafeInteger(src.checkedTick) && src.checkedTick >= 0 ? src.checkedTick * 1000 : null,
      energy: safe(src.energy),
      capacity: safe(src.maxEnergy),
      currency: safe(src.pixels),
      regenIntervalMs: safe(src.energyRate * 1000),
      colors: parsed?.length <= 256 ? parsed : null,
    };
  }
  async function identity(data, topLeft, filters = '') {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data.data));
    const id = Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join('');
    const filterDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(filters)));
    return {
      id,
      generation: Array.from(filterDigest, (n) => n.toString(16).padStart(2, '0')).join(''),
      width: data.width,
      height: data.height,
      gridX: topLeft.gridX,
      gridY: topLeft.gridY,
      layer: 'base',
    };
  }
  return { tileAt, readRegion, resources, identity };
})();
