(() => {
  'use strict';
  if (!['https://geopixels.net', 'https://www.geopixels.net'].includes(location.origin)) return;
  let transport = null,
    heartbeat = null,
    generation = 0,
    observing = false;
  const panel = document.createElement('aside');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:99999;background:#17212b;color:white;padding:12px;max-width:340px;font:14px sans-serif;border:1px solid #669;border-radius:8px';
  const title = document.createElement('strong');
  title.textContent = `GeoPlacer — lecteur HTTP ${GeoPlacerReaderVersion}`;
  const status = document.createElement('p');
  status.textContent = 'Déconnecté. Lecture seule ; aucun placement ni achat.';
  const connect = document.createElement('button');
  connect.textContent = 'Coupler';
  const sync = document.createElement('button');
  sync.textContent = 'Observer le modèle';
  sync.disabled = true;
  const disconnect = document.createElement('button');
  disconnect.textContent = 'Déconnecter';
  const diagnose = document.createElement('button');
  diagnose.textContent = 'Diagnostiquer';
  diagnose.onclick = async () => {
    try {
      status.textContent = await GeoPlacerPageReader.inspect();
    } catch {
      status.textContent = 'Diagnostic du contexte de page indisponible';
    }
  };
  panel.append(title, status, connect, sync, disconnect, diagnose);
  document.body.append(panel);
  async function close(message = 'Déconnecté') {
    generation++;
    clearInterval(heartbeat);
    heartbeat = null;
    const previous = transport;
    transport = null;
    observing = false;
    sync.disabled = true;
    connect.disabled = false;
    status.textContent = message;
    try {
      await previous?.disconnect();
    } catch {
      /* Revocation/expiry also closes the server session. */
    }
  }
  disconnect.onclick = () => close();
  connect.onclick = async () => {
    await close();
    const current = generation;
    const address = prompt('Adresse locale GeoPlacer (127.0.0.1 uniquement)', 'http://127.0.0.1:3000');
    if (!address) return;
    let code = prompt('Code temporaire du couplage HTTP affiché par GeoPlacer (pas la clé privée d’approbation)');
    if (!code) return;
    connect.disabled = true;
    try {
      const next = GeoPlacerHttpTransport(address, typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
      transport = next;
      await next.pair(code, location.origin, (fingerprint) => {
        code = null;
        if (current === generation)
          status.textContent = `Demande ${fingerprint} : comparer cette empreinte et confirmer dans le dashboard local.`;
      });
      code = null;
      if (current !== generation) {
        await next.disconnect();
        return;
      }
      GeoPlacerPageReader.reset?.();
      status.textContent = 'Couplé par HTTP privilégié, en lecture seule';
      sync.disabled = false;
      heartbeat = setInterval(async () => {
        if (observing || current !== generation) return;
        try {
          if (!(await GeoPlacerPageReader.unchanged()))
            throw new Error('Modèle, position, palette, couche ou session modifié : nouveau couplage nécessaire.');
          await next.heartbeat();
        } catch (error) {
          if (current === generation) await close(error.message);
        }
      }, 5000);
    } catch (error) {
      code = null;
      if (current === generation) await close(error.message);
    }
  };
  sync.onclick = async () => {
    if (observing || !transport?.connected()) return;
    const current = generation,
      channel = transport;
    observing = true;
    sync.disabled = true;
    try {
      const result = await GeoPlacerPageReader.observe(
        (o) => channel.send(o),
        () => current === generation && channel.connected()
      );
      if (current === generation)
        status.textContent = `Observation confirmée (${result.contract}). Cache non daté.${result.cacheStats ? ` Valeurs extraites : ${result.cacheStats.known} connues (dont ${result.cacheStats.transparent} transparentes), ${result.cacheStats.unknown} inconnues.` : ''} Dernier accusé : ${channel.latency()} ms.`;
    } catch (error) {
      if (current === generation) await close(error.message);
    } finally {
      if (current === generation) {
        observing = false;
        sync.disabled = !transport?.connected();
      }
    }
  };
})();
