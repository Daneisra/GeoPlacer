/* Read-only contracts. Fingerprints identify public code; no placement function is executed. */
const GeoPlacerPageReader = (() => {
  const digest = async (text) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')))),
      (n) => n.toString(16).padStart(2, '0')
    ).join('');
  let maxModelPixels=16777216;
  let previousIdentity = null,
    session = crypto.randomUUID(),
    lastCapture = null,
    lastContract = null,
    lastProject = null,
    decodedCache = GeoPlacerCapture.createReadCache?.(),
    decodedIdentity = null;
  const identity = () => (typeof userID === 'undefined' ? '' : String(userID));
  const filters = () =>
    typeof ghostActivePaletteColors === 'undefined' ? '' : [...ghostActivePaletteColors].sort().join('|');
  const eventScripts = () =>
    [...document.scripts].some((s) => /\/event[-Llayers]*.*\.js/i.test(new URL(s.src || location.href).pathname));
  async function contract() {
    if (typeof getSelectedEventId === 'function') {
      const selected = getSelectedEventId();
      return {
        id: 'event-layers-74783af-getter',
        layer: selected === null ? 'base' : Number.isSafeInteger(selected) && selected > 0 ? 'event' : 'unknown',
      };
    }
    if (typeof activeEvent !== 'undefined') {
      const supported = activeEvent === null || typeof activeEvent === 'number' || (typeof activeEvent === 'string' && (activeEvent === '' || /^\d+$/.test(activeEvent)));
      const id = supported ? (activeEvent === null || activeEvent === '' ? 0 : Number(activeEvent)) : NaN;
      return {
        id: 'event-layers-74783af-state',
        layer: Number.isSafeInteger(id) && id === 0 ? 'base' : Number.isSafeInteger(id) && id > 0 ? 'event' : 'unknown',
      };
    }
    const placeHash =
      typeof placePixels === 'function' ? await digest(Function.prototype.toString.call(placePixels)) : null;
    const mapHash =
      typeof getMapPixelHex === 'function' ? await digest(Function.prototype.toString.call(getMapPixelHex)) : null;
    // Legacy frontend before Event Layers: both exact function fingerprints and absence of event interfaces required.
    const legacy =
      placeHash === '046cded7e9792f2e3a3c7cf87f6f1a6343f2183b1dfc5fc4bdf0c61cb88794f2' &&
      mapHash === '4d7fadb08c6b8bb77dbb4e596c2e67926574a283f4c702e1ef4b79177c865b87' &&
      !eventScripts();
    return {
      id: legacy ? 'base-only-8367389' : 'unidentified',
      layer: legacy ? 'base' : 'unknown',
      placeHash,
      mapHash,
    };
  }
  const available = () =>
    typeof ghostImageOriginalData !== 'undefined' &&
    ghostImageOriginalData &&
    typeof ghostImageTopLeft !== 'undefined' &&
    ghostImageTopLeft &&
    typeof tileImageCache !== 'undefined' &&
    typeof tileImageCache.get === 'function';
  async function inspect() {
    const c = await contract();
    let cacheInfo = '';
    if (available()) {
      const tile = GeoPlacerCapture.tileAt(ghostImageTopLeft.gridX, ghostImageTopLeft.gridY);
      const entry = tileImageCache.get(`${tile.tileX},${tile.tileY}`),
        bitmap = entry?.colorBitmap;
      const tileSize =
        typeof SYNC_TILE_SIZE === 'number' && Number.isSafeInteger(SYNC_TILE_SIZE) ? SYNC_TILE_SIZE : 'indisponible';
      let readable = 'non testé';
      if (bitmap) {
        try {
          const canvas = new OffscreenCanvas(1, 1),
            ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, tile.localX, tile.localY, 1, 1, 0, 0, 1, 1);
          const rgba = ctx.getImageData(0, 0, 1, 1).data;
          readable = `oui (alpha ${rgba[3]})`;
        } catch (error) {
          readable = `non (${error.name})`;
        }
      }
      const issues = [];
      const enginePixel = GeoPlacerCapture.readRegion(
        {
          gridX: ghostImageTopLeft.gridX,
          gridY: ghostImageTopLeft.gridY,
          width: ghostImageOriginalData.width,
          height: ghostImageOriginalData.height,
        },
        { x: ghostImageTopLeft.gridX, y: ghostImageTopLeft.gridY, width: 1, height: 1 },
        tileImageCache,
        (w, h) => new OffscreenCanvas(w, h),
        (reason) => issues.push(reason)
      )[0];
      cacheInfo = ` Taille de tuile : ${tileSize}. Entrées : ${tileImageCache.size ?? 'indisponible'}. Tuile du coin : ${entry ? 'présente' : 'absente'}. Bitmap : ${bitmap ? `${bitmap.width} × ${bitmap.height}` : 'absent'}. Lecture 1 px : ${readable}. Lecture moteur : ${enginePixel === -2 ? 'inconnue' : enginePixel === -1 ? 'transparente' : '#' + enginePixel.toString(16).padStart(6, '0')}. Motif : ${issues.join(', ') || 'aucune erreur'}.`;
    }
    return (
      `Origine : ${location.origin}. Contrat : ${c.id}. Couche : ${c.layer}. Modèle/position/cache : ${available() ? 'disponibles' : 'indisponibles'}. Canvas : ${typeof OffscreenCanvas === 'function' ? 'disponible' : 'indisponible'}.` +
      (c.layer === 'unknown'
        ? ` Empreinte placePixels : ${c.placeHash ?? 'absente'}. Empreinte carte : ${c.mapHash ?? 'absente'}.`
        : '') +
      cacheInfo
    );
  }
  async function observe(send, connected, region = null, cancelled = () => false, initial = false) {
    const c = await contract();
    if (c.layer !== 'base')
      throw new Error(
        c.layer === 'event'
          ? 'Couche événementielle non prise en charge'
          : 'Couche indéterminée : aucune observation produite. Utiliser Diagnostiquer.'
      );
    if (!available() || typeof OffscreenCanvas !== 'function')
      throw new Error('Fantôme positionné, cache ou canvas indisponible');
    const account = identity();
    if (account !== previousIdentity) {
      session = crypto.randomUUID();
      previousIdentity = account;
    }
    const data = ghostImageOriginalData,
      topLeft = { ...ghostImageTopLeft },
      palette = filters();
    if (!Number.isSafeInteger(data.width*data.height) || data.width*data.height > maxModelPixels) throw new Error('Image au-delà du budget mémoire négocié avec GeoPlacer.');
    const project = await GeoPlacerCapture.identity(data, topLeft, palette);
    const unchanged = () =>
      available() &&
      ghostImageOriginalData === data &&
      ghostImageTopLeft.gridX === topLeft.gridX &&
      ghostImageTopLeft.gridY === topLeft.gridY &&
      filters() === palette &&
      identity() === account;
    const resources = GeoPlacerCapture.resources(
      typeof userData === 'undefined' ? null : userData,
      typeof Colors === 'undefined' ? null : Colors
    );
    const cacheStats = { known: 0, unknown: 0, transparent: 0 };
    const area=region ?? {x:0,y:0,width:initial?Math.min(256,project.width):project.width,height:initial?Math.min(256,project.height):project.height};
    if(area.width>65536)throw new Error('Lecture complète trop large pour un paquet : utiliser le mode autonome par régions.');
    if(![area.x,area.y,area.width,area.height].every(Number.isSafeInteger) || area.x<0 || area.y<0 || area.width<1 || area.height<1 || area.x+area.width>project.width || area.y+area.height>project.height)
      throw new Error('Région hors du modèle');
    const cacheIdentity=JSON.stringify([project,session,c.id]);
    if(cacheIdentity!==decodedIdentity) { decodedCache?.clear(); decodedIdentity=cacheIdentity; }
    decodedCache?.begin(tileImageCache);
    // Only immutable native bitmaps may survive between captures; source time remains unknown.
    const decoded = decodedCache ?? new Map(), captureId = crypto.randomUUID();
    const rowsPerBand = Math.max(1, Math.floor(65536 / area.width));
    const bandCount = Math.ceil(area.height / rowsPerBand);
    let bandIndex = 0;
    for (let row = 0; row < area.height;) {
      if(cancelled()) { const error=new Error('Capture interrompue volontairement');error.name='AbortError';error.captureId=captureId;throw error; }
      if (!connected() || !unchanged() || (await contract()).id !== c.id || (await contract()).layer !== 'base')
        throw new Error('Modèle, position, palette, couche ou session modifié pendant la lecture');
      const height = Math.min(area.height - row, rowsPerBand);
      const rect = { x: project.gridX+area.x, y: project.gridY-area.y-row-height+1, width: area.width, height };
      const capturedAt = Date.now();
      const pixels = GeoPlacerCapture.readRegion(project, rect, tileImageCache, (w, h) => new OffscreenCanvas(w, h), () => {}, decoded);
      for (const value of pixels) {
        if (value === -2) cacheStats.unknown++;
        else {
          cacheStats.known++;
          if (value === -1) cacheStats.transparent++;
        }
      }
      await send({
        type: 'observation',
        session,
        project,
        capturedAt,
        // Initial bootstrap is a partial observation, never a claim of a complete image capture.
        ...(initial ? {} : {capture: { id: captureId, index: bandIndex++, count: bandCount, ...(region ? {region} : {}) }}),
        ...(typeof GeoPlacerTiles==='undefined'?{}:{cacheCoverage:GeoPlacerTiles.coverage(project)}),
        tiles: typeof GeoPlacerTiles === 'undefined' ? [] : GeoPlacerTiles.inspect(rect),
        observedAt: null,
        rect,
        pixels,
        resources,
      });
      row += height;
    }
    lastCapture = unchanged;
    lastContract = c.id;
    lastProject = project;
    return { project, contract: c.id, cacheStats };
  }
  return {
    ready: available,
    setLimits: (limits) => {if(!Number.isSafeInteger(limits?.maxModelPixels)||limits.maxModelPixels<1||limits.maxModelPixels>=2**32)throw new Error('Budget mémoire invalide');maxModelPixels=limits.maxModelPixels;},
    targetColor: (x, y) => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || typeof ghostImageOriginalData === 'undefined') return null;
      const d = ghostImageOriginalData;
      if (!d || x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
      const i = (y * d.width + x) * 4;
      return d.data[i + 3] === 255 ? (d.data[i] << 16) | (d.data[i + 1] << 8) | d.data[i + 2] : null;
    },
    contract,
    project: () => lastProject,
    inspect,
    observe,
    reset: () => {
      lastCapture = null;
      lastProject = null;
      lastContract = null;
      decodedCache?.clear(); decodedIdentity=null;
    },
    unchanged: async () =>
      lastCapture === null ||
      (lastCapture() && (await contract()).id === lastContract && (await contract()).layer === 'base'),
  };
})();
