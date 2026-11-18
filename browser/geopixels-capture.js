/* GeoPlacer original adapter. Contracts: GeoPixelsFront@74783af, ghost.js/getMapPixelHex.
 * Passive cache reader only. No fetch hooks, service requests or session credentials. */
globalThis.GeoPlacerCapture = (() => {
  const TILE = 1000;
  function tileAt(x, y) {
    const tileX = Math.floor(x / TILE) * TILE,
      tileY = Math.floor(y / TILE) * TILE;
    return { tileX, tileY, localX: x - tileX, localY: y - tileY };
  }
  // Native ImageBitmap has no pixel mutator. Canvas-like objects are reused only within one capture.
  function createReadCache(maxBytes = 32 * 1024 * 1024) {
    const entries = new Map();
    let bytes = 0;
    const remove = key => { const e = entries.get(key); if (e) bytes -= e.data?.byteLength ?? 0; entries.delete(key); };
    return {
      begin(source) {
        for (const [key, e] of entries) {
          const bitmap = source.get(key)?.colorBitmap;
          if (!(typeof ImageBitmap === 'function' && e.bitmap instanceof ImageBitmap) || bitmap !== e.bitmap || source.get(key)?.timestamp !== e.cursor || bitmap.width !== TILE || bitmap.height !== TILE)
            remove(key);
        }
      },
      has: key => entries.has(key),
      get(key) { const e = entries.get(key); if(e) { entries.delete(key); entries.set(key,e); } return e; },
      set(key, value) {
        remove(key);
        const cost = value.data?.byteLength ?? 0;
        while (bytes + cost > maxBytes && entries.size) remove(entries.keys().next().value);
        if (cost <= maxBytes) { entries.set(key,value); bytes += cost; }
      },
      clear() { entries.clear(); bytes = 0; },
      bytes: () => bytes,
    };
  }
  function readRegion(project, rect, cache, createCanvas, report = () => {}, decoded = new Map()) {
    decoded.begin?.(cache);
    const pixels = new Array(rect.width * rect.height).fill(-2);
    // Walk tile intersections once rather than looking up the same tile for every pixel.
    for(let ty=Math.floor(rect.y/TILE)*TILE;ty<rect.y+rect.height;ty+=TILE)
      for(let tx=Math.floor(rect.x/TILE)*TILE;tx<rect.x+rect.width;tx+=TILE) {
        const key = `${tx},${ty}`, bitmap = cache.get(key)?.colorBitmap;
        let entry = decoded.get(key);
        if (!entry || entry.bitmap !== bitmap || entry.width !== bitmap?.width || entry.height !== bitmap?.height || entry.cursor !== cache.get(key)?.timestamp) {
          let data = null;
          if(bitmap?.width===TILE && bitmap?.height===TILE) {
            try {
              const canvas=createCanvas(TILE,TILE),ctx=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});
              ctx.drawImage(bitmap,0,0);data=ctx.getImageData(0,0,TILE,TILE).data;
            } catch(error) { report(`decode-error:${error.name}`); }
          } else report(bitmap?'invalid-bitmap-size':'missing-bitmap');
          entry={bitmap,cursor:cache.get(key)?.timestamp,width:bitmap?.width,height:bitmap?.height,data};decoded.set(key,entry);
        }
        const data=entry.data;if(!data)continue;
        const x0=Math.max(rect.x,tx,project.gridX),x1=Math.min(rect.x+rect.width,tx+TILE,project.gridX+project.width);
        const y0=Math.max(rect.y,ty,project.gridY-project.height+1),y1=Math.min(rect.y+rect.height,ty+TILE,project.gridY+1);
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
          const i=((y-ty)*TILE+x-tx)*4;
          pixels[(y-rect.y)*rect.width+x-rect.x]=data[i+3]===0?-1:data[i+3]===255?(data[i]<<16)|(data[i+1]<<8)|data[i+2]:-2;
        }
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
      currency: safe(Number.isSafeInteger(src.pixels) ? Math.floor(src.pixels/5) : null),
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
  return { tileAt, readRegion, createReadCache, resources, identity };
})();
