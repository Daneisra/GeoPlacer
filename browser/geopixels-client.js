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
  panel.id = 'geoplacer-reader-panel';
  const css = `
#geoplacer-reader-panel { all:initial!important; position:fixed!important; bottom:12px!important; right:12px!important; z-index:2147483647!important; display:grid!important; gap:10px!important; box-sizing:border-box!important; width:340px!important; max-width:calc(100vw - 24px)!important; max-height:calc(100vh - 24px)!important; overflow:auto!important; padding:16px!important; background:#111c2d!important; color:#f1f5f9!important; border:1px solid #526580!important; border-radius:12px!important; box-shadow:0 8px 30px #0006!important; font:14px/1.5 system-ui,sans-serif!important; text-align:left!important; direction:ltr!important; }
#geoplacer-reader-panel * { box-sizing:border-box!important; font-family:system-ui,sans-serif!important; font-size:14px!important; line-height:1.5!important; color:inherit!important; margin:0!important; }
#geoplacer-reader-panel strong { display:block!important; font-weight:700!important; font-size:16px!important; }
#geoplacer-reader-panel p { display:block!important; overflow-wrap:anywhere!important; }
#geoplacer-reader-panel button { all:unset!important; box-sizing:border-box!important; display:block!important; width:100%!important; padding:9px 12px!important; border:1px solid #526580!important; border-radius:7px!important; background:#24344c!important; color:#fff!important; font:600 14px/1.4 system-ui,sans-serif!important; text-align:center!important; cursor:pointer!important; }
#geoplacer-reader-panel button:disabled { opacity:.45!important; cursor:default!important; }
#geoplacer-reader-panel button:focus-visible { outline:2px solid #7dd3fc!important; outline-offset:2px!important; }
#geoplacer-reader-panel button:active:not(:disabled) { transform:scale(.98)!important; }
#geoplacer-reader-panel button:last-of-type { border-color:#38bdf8!important; }
#geoplacer-reader-panel details { display:block!important; border-top:1px solid #526580!important; padding-top:8px!important; }
#geoplacer-reader-panel summary { display:list-item!important; cursor:pointer!important; color:#cbd5e1!important; }
#geoplacer-reader-panel details button { margin-top:8px!important; }
@media (hover:hover) and (pointer:fine) { #geoplacer-reader-panel button:hover:not(:disabled) { background:#344965!important; } }
`;
  // Privileged style insertion is scoped to our panel; never change the site's CSP.
  if (typeof GM_addElement === 'function') GM_addElement('style', { textContent: css });
  else {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head ?? document.body).append(style);
  }
  const title = document.createElement('strong');
  title.textContent = `GeoPlacer — lecteur HTTP ${GeoPlacerReaderVersion}`;
  const status = document.createElement('p');
  const watchStatus = document.createElement('p');
  watchStatus.textContent = 'Cache chargé uniquement · fraîcheur non vérifiée.';
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
  const pixel = document.createElement('button');
  pixel.textContent = 'Placer le pixel préparé';
  pixel.onclick = async (event) => {
    if (!event.isTrusted || !transport?.connected()) return;
    const channel = transport,
      current = generation;
    pixel.disabled = true;
    try {
      const command = await channel.claimPixel();
      if (!command) {
        status.textContent = 'Aucun pixel autorisé dans le dashboard.';
        return;
      }
      const result = await GeoPlacerPageWriter.execute(
        command,
        (id) => (current === generation && channel.connected() ? channel.pixelAllowed(id) : false),
        true
      );
      const ack = await channel.pixelResult(command.attemptId, result);
      status.textContent =
        result === 'confirmed' && ack.state === 'finished'
          ? 'Envoi unique confirmé par GeoPixels. Observer à nouveau pour mesurer la progression ; recharger avant un nouvel essai.'
          : result === 'not-sent' && ack.state === 'failed'
            ? 'Pixel non envoyé : ' + (GeoPlacerPageWriter.reason?.() ?? 'vérification locale refusée.')
            : 'Résultat incertain. Aucun renvoi ; réconciliation nécessaire.';
    } catch {
      status.textContent =
        'Réponse absente : résultat potentiellement incertain. Consulter le dashboard ; aucun renvoi.';
    } finally {
      pixel.disabled = false;
    }
  };
  diagnose.onclick = async () => {
    try {
      status.textContent = (await GeoPlacerPageReader.inspect()) + ' ' + (GeoPlacerPageWriter.inspect?.() ?? '') + ' ' + GeoPlacerEnergy.inspect();
    } catch {
      status.textContent = 'Diagnostic du contexte de page indisponible';
    }
  };
  const options = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Options du lecteur';
  options.append(summary, pixel, disconnect, diagnose);
  panel.append(title, status, watchStatus, connect, sync, options);
  document.body.append(panel);
  async function close(message = 'Déconnecté', reason = 'manual') {
    GeoPlacerPageWriter.stop();
    GeoPlacerShop.stop();
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
      await previous?.disconnect(reason);
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
      lastOnce = 0;
      abortedCapture = null;
      status.textContent = 'Couplé par HTTP privilégié, en lecture seule';
      sync.disabled = false;
      async function pulse() {
        while (current === generation && next.connected()) {
          try {
            if (!observing && !(await GeoPlacerPageReader.unchanged()))
              throw new Error('Modèle, position, palette, couche ou session modifié : nouveau couplage nécessaire.');
            const answer = await next.poll(
              monitoring ? { revision: monitoring.revision, state: monitoring.state } : undefined,
              abortedCapture,
              GeoPlacerEnergy.snapshot()
            );
            abortedCapture = null;
            if(answer?.renewRequired){await next.renew();continue;}
            if (current !== generation) return;
            if (!observing && !(await GeoPlacerPageReader.unchanged()))
              throw new Error('Modèle, position, palette, couche ou session modifié : nouveau couplage nécessaire.');
            await GeoPlacerEnergy.refresh(!!answer?.workAuthorized);
            if(!observing && answer?.upgrades?.commandReady){
              const command=await next.claimUpgrade();
              if(command){
                const result=await GeoPlacerShop.execute(command,id=>current===generation && next.connected()?next.upgradeAllowed(id):false);
                await next.upgradeResult(command.id,result);
                status.textContent=result==='accepted'
                  ? 'Amélioration acceptée : vérification du solde et de l’effet en attente.'
                  : result==='uncertain' ? 'Achat incertain : aucun renvoi.' : 'Achat refusé avant exécution ou par le service.';
              }
              continue;
            }
            const batch = answer?.batch;
            if (!observing && batch?.commandReady && batch.grant) {
              const command = await next.claimBatch();
              if (command) {
                const result = await GeoPlacerPageWriter.executeBatch(
                  command,
                  (id) => (current === generation && next.connected() ? next.batchAllowed(command.batchId, id) : false),
                  batch.grant
                );
                const ack = await next.batchResult(command.batchId, command.attemptId, result);
                status.textContent =
                  result === 'confirmed' && !['stopped', 'blocked'].includes(ack.state)
                    ? `Lot : ${ack.acceptedRequests} requête(s) acceptée(s), ${ack.confirmed} cible(s) couverte(s) par cet accusé. Progression mesurée séparément.`
                    : result === 'rejected-size' ? 'Groupe refusé (HTTP 413) : taille réduite ; attente de ressources natives.' : result === 'waiting-resources'
                      ? 'Dessin suspendu : attente d’une nouvelle observation native de l’énergie.'
                    : result === 'not-sent'
                      ? 'Lot en pause : ' + (GeoPlacerPageWriter.reason?.() ?? 'pixel refusé avant envoi.')
                      : 'Lot interrompu, résultat incertain. Aucun renvoi.';
              }
            }
            ticking = true;
            const m = answer?.monitoring;
            if (m) {
              if (
                !Number.isSafeInteger(m.revision) ||
                !['running', 'paused', 'stopped'].includes(m.state) ||
                !Number.isSafeInteger(m.intervalMs) ||
                m.intervalMs < 5000 ||
                m.intervalMs > 60000
              )
                throw new Error('Commande de surveillance invalide');
              if (
                m.region &&
                (!/^[a-z][a-z0-9_-]{0,31}$/.test(m.region.id) ||
                  !['x', 'y', 'width', 'height', 'revision'].every((k) => Number.isSafeInteger(m.region[k])))
              )
                throw new Error('Région reçue invalide');
              if (!monitoring || m.revision >= monitoring.revision) {
                if (!monitoring || m.revision > monitoring.revision) nextDue = 0;
                monitoring = m;
              }
            }
            watchStatus.textContent = `Surveillance : ${monitoring?.state === 'running' ? 'active' : monitoring?.state === 'paused' ? 'en pause' : 'arrêtée'}. Fraîcheur du cache non vérifiée.`;
            sync.disabled = observing || monitoring?.state === 'running';
            const once = monitoring?.once;
            if (
              !observing &&
              ((monitoring?.state === 'running' && Date.now() >= nextDue) || (once && once.serial > lastOnce))
            ) {
              if (once) lastOnce = once.serial;
              // Held control polling stays active during large captures; two captures never overlap.
              const captureDelay = monitoring?.sweepMore ? 0 : monitoring?.intervalMs ?? 5000;
              void observe(true, monitoring?.region ?? null).finally(() => {
                if (current === generation && monitoring) nextDue = Date.now() + captureDelay;
              });
            }
          } catch (error) {
            if (current === generation) {
              if(error.transient && next.connected()){status.textContent='Transport temporairement interrompu : aucun nouvel envoi, tentative de reconnexion au même canal.';await next.waitForRetry();}
              else await close(error.message, /Modèle, position, palette/.test(error.message) ? 'context' : 'transport');
            }
          } finally {
            ticking = false;
          }
        }
      }
      const limits=next.features?.();
      if(limits){GeoPlacerPageReader.setLimits(limits);GeoPlacerPageWriter.setLimits?.(limits);}
      void pulse();
      if(limits?.autonomous && GeoPlacerPageReader.ready?.())void observe(false,null,true);
    } catch (error) {
      code = null;
      if (current === generation) await close(error.message);
    }
  };
  async function observe(fromWatch = false, region = null, initial = false) {
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
        () => fromWatch && monitoring?.revision !== startedRevision,
        initial
      );
      if (current === generation)
        status.textContent = `Observation confirmée${result.cacheStats ? ` : ${result.cacheStats.known} pixels connus, ${result.cacheStats.unknown} inconnus.` : '.'}`;
    } catch (error) {
      if (current === generation) {
        if (error.name === 'AbortError') {
          abortedCapture = error.captureId;
          status.textContent = 'Capture interrompue ; bandes partielles conservées avec leurs dates.';
        } else if (channel.connected() && await GeoPlacerPageReader.unchanged()) {
          status.textContent = 'Capture interrompue : ' + error.message + ' Le couplage est conservé.';
        } else await close(error.message, channel.connected() ? 'context' : 'observation');
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
