(() => {
  'use strict';
  if (!['https://geopixels.net', 'https://www.geopixels.net'].includes(location.origin)) return;
  let transport = null,
    generation = 0,
    observing = false,
    ticking = false,
    monitoring = null,
    nextDue = 0,
    abortedCapture = null,
    lastOnce = 0;
  const panel = document.createElement('aside');
  panel.style.cssText =
    'position:fixed;bottom:12px;right:12px;z-index:99999;background:#17212b;color:white;padding:12px;max-width:340px;font:14px sans-serif;border:1px solid #669;border-radius:8px';
  const title = document.createElement('strong');
  title.textContent = `GeoPlacer — lecteur HTTP ${GeoPlacerReaderVersion}`;
  const status = document.createElement('p');
  const watchStatus = document.createElement('p');
  watchStatus.textContent = 'Surveillance arrêtée. Commandes dans le dashboard local.';
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
  panel.append(title, status, watchStatus, connect, sync, disconnect, diagnose);
  document.body.append(panel);
  async function close(message = 'Déconnecté') {
    generation++;
    const previous = transport;
    transport = null;
    observing = false;
    monitoring = null;
    nextDue = 0;
    watchStatus.textContent = 'Surveillance arrêtée. Nouveau couplage si le canal a expiré.';
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
      lastOnce=0; abortedCapture=null;
      status.textContent = 'Couplé par HTTP privilégié, en lecture seule';
      sync.disabled = false;
      async function pulse() {
       while (current === generation && next.connected()) {
        try {
          if (!observing && !(await GeoPlacerPageReader.unchanged()))
            throw new Error('Modèle, position, palette, couche ou session modifié : nouveau couplage nécessaire.');
          const answer = await next.poll(monitoring ? { revision: monitoring.revision, state: monitoring.state } : undefined, abortedCapture);
          abortedCapture = null;
          if (current !== generation) return;
          if (!observing && !(await GeoPlacerPageReader.unchanged()))
            throw new Error('Modèle, position, palette, couche ou session modifié : nouveau couplage nécessaire.');
          ticking = true;
          const m = answer?.monitoring;
          if (m) {
            if (!Number.isSafeInteger(m.revision) || !['running', 'paused', 'stopped'].includes(m.state) ||
                !Number.isSafeInteger(m.intervalMs) || m.intervalMs < 5000 || m.intervalMs > 60000)
              throw new Error('Commande de surveillance invalide');
            if(m.region && (!/^[a-z][a-z0-9_-]{0,31}$/.test(m.region.id) || !['x','y','width','height','revision'].every(k=>Number.isSafeInteger(m.region[k]))))
              throw new Error('Région reçue invalide');
            if (!monitoring || m.revision >= monitoring.revision) {
              if (!monitoring || m.revision > monitoring.revision) nextDue = 0;
              monitoring = m;
            }
          }
          watchStatus.textContent = `Surveillance : ${monitoring?.state === 'running' ? 'active' : monitoring?.state === 'paused' ? 'en pause' : 'arrêtée'}. Cache chargé uniquement ; fraîcheur source non vérifiée.`;
          sync.disabled = observing || monitoring?.state === 'running';
          const once=monitoring?.once;
          if (!observing && ((monitoring?.state === 'running' && Date.now() >= nextDue) || (once && once.serial > lastOnce))) {
            if(once)lastOnce=once.serial;
            // Held control polling stays active during large captures; two captures never overlap.
            void observe(true, monitoring?.region ?? null).finally(() => {
              if(current===generation && monitoring)nextDue=Date.now()+monitoring.intervalMs;
            });
          }
        } catch (error) {
          if (current === generation) await close(error.message);
        } finally { ticking = false; }
       }
      }
      void pulse();
    } catch (error) {
      code = null;
      if (current === generation) await close(error.message);
    }
  };
  async function observe(fromWatch = false, region = null) {
    if (observing || (ticking && !fromWatch) || !transport?.connected()) return;
    const current = generation,
      channel = transport,
      startedRevision = monitoring?.revision;
    observing = true;
    sync.disabled = true;
    try {
      const result = await GeoPlacerPageReader.observe(
        (o) => channel.send(o),
        () => current === generation && channel.connected(),
        region,
        () => fromWatch && monitoring?.revision !== startedRevision
      );
      if (current === generation)
        status.textContent = `Observation confirmée (${result.contract}). Cache non daté.${result.cacheStats ? ` Valeurs extraites : ${result.cacheStats.known} connues (dont ${result.cacheStats.transparent} transparentes), ${result.cacheStats.unknown} inconnues.` : ''} Dernier accusé : ${channel.latency()} ms.`;
    } catch (error) {
      if (current === generation) {
        if(error.name==='AbortError') { abortedCapture=error.captureId;status.textContent='Capture interrompue ; bandes partielles conservées avec leurs dates.'; }
        else await close(error.message);
      }
    } finally {
      if (current === generation) {
        observing = false;
        sync.disabled = !transport?.connected() || monitoring?.state === 'running';
      }
    }
  }
  sync.onclick = () => observe(false);
})();
