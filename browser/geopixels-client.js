(() => {
  'use strict';
  if (location.origin !== 'https://www.geopixels.net') return;
  let socket = null,
    heartbeat = null,
    sequence = 0;
  let session = crypto.randomUUID(),
    lastSessionIdentity = null;
  const panel = document.createElement('aside');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:99999;background:#17212b;color:white;padding:12px;max-width:300px;font:14px sans-serif;border:1px solid #669;border-radius:8px';
  const title = document.createElement('strong');
  title.textContent = 'GeoPlacer — lecteur expérimental';
  const status = document.createElement('p');
  status.textContent = 'Déconnecté. Aucune écriture disponible.';
  const connect = document.createElement('button');
  connect.textContent = 'Coupler';
  const sync = document.createElement('button');
  sync.textContent = 'Observer le modèle';
  sync.disabled = true;
  const disconnect = document.createElement('button');
  disconnect.textContent = 'Déconnecter';
  panel.append(title, status, connect, sync, disconnect);
  document.body.append(panel);
  function close() {
    clearInterval(heartbeat);
    socket?.close();
    socket = null;
    sync.disabled = true;
    status.textContent = 'Déconnecté';
  }
  disconnect.onclick = close;
  connect.onclick = () => {
    close();
    const address = prompt('Adresse locale du dashboard GeoPlacer', 'http://127.0.0.1:3000');
    if (!address) return;
    let url;
    try {
      url = new URL(address);
      if (
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      status.textContent = 'Adresse locale invalide';
      return;
    }
    let capability = prompt('Code de couplage temporaire affiché par GeoPlacer');
    if (!capability || !/^[0-9a-f]{64}$/.test(capability)) return;
    const ws = new WebSocket(`ws://${url.host}/api/v1/connector/channel`);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'pair', protocol: 1, token: capability }));
      capability = null;
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'paired' && message.mode === 'read-only') {
        status.textContent = 'Couplé en lecture seule';
        sync.disabled = false;
        heartbeat = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat' }));
        }, 5_000);
      } else if (message.type !== 'observed') close(); // No command executor exists here.
    };
    ws.onerror = () => {
      status.textContent = 'Canal refusé ou bloqué par le navigateur';
    };
    ws.onclose = () => {
      if (socket === ws) close();
    };
  };
  sync.onclick = async () => {
    sync.disabled = true;
    try {
      if (typeof getSelectedEventId !== 'function' || getSelectedEventId() !== null)
        throw new Error('Seule la couche de base est prise en charge');
      if (
        typeof ghostImageOriginalData === 'undefined' ||
        !ghostImageOriginalData ||
        typeof ghostImageTopLeft === 'undefined' ||
        !ghostImageTopLeft ||
        typeof tileImageCache === 'undefined' ||
        !(tileImageCache instanceof Map)
      )
        throw new Error('Modèle positionné ou cache compatible indisponible');
      const identity = typeof userID === 'undefined' ? '' : String(userID);
      if (identity !== lastSessionIdentity) {
        session = crypto.randomUUID();
        lastSessionIdentity = identity;
      }
      const data = ghostImageOriginalData;
      if (data.width > 2000 || data.height > 2000) throw new Error('Limite de cette phase : 2000 × 2000');
      const filters = typeof ghostActivePaletteColors === 'undefined' ? '' : [...ghostActivePaletteColors].sort().join('|');
      const project = await GeoPlacerCapture.identity(data, ghostImageTopLeft, filters);
      const ws = socket;
      if (!ws || ws.readyState !== 1) throw new Error('Canal fermé');
      // Cache cursor timestamps are deliberately not reinterpreted as observation dates.
      const res = GeoPlacerCapture.resources(
        typeof userData === 'undefined' ? null : userData,
        typeof Colors === 'undefined' ? null : Colors
      );
      for (let row = 0; row < project.height;) {
        const height = Math.min(project.height - row, Math.floor(65536 / project.width));
        const rect = { x: project.gridX, y: project.gridY - row - height + 1, width: project.width, height };
        while (ws.bufferedAmount > 500_000) {
          await new Promise((r) => setTimeout(r, 100));
          if (ws.readyState !== 1) throw new Error('Canal fermé');
        }
        // Recheck identity after every yield: never mix two positions or two models.
        if (
          ghostImageOriginalData !== data ||
          ghostImageTopLeft.gridX !== project.gridX ||
          ghostImageTopLeft.gridY !== project.gridY ||
          getSelectedEventId() !== null
        )
          throw new Error('Modèle ou position modifié pendant la lecture');
        const pixels = GeoPlacerCapture.readRegion(project, rect, tileImageCache, (w, h) => new OffscreenCanvas(w, h));
        ws.send(
          JSON.stringify({
            type: 'observation',
            sequence: ++sequence,
            session,
            project,
            capturedAt: Date.now(),
            observedAt: null,
            rect,
            pixels,
            resources: res,
          })
        );
        row += height;
      }
      status.textContent = 'Cache observé ; couverture et fraîcheur à vérifier dans GeoPlacer';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      sync.disabled = !socket || socket.readyState !== 1;
    }
  };
})();
