/* Private userscript scope. Only fixed loopback operations, never a page-provided URL. */
const GeoPlacerHttpTransport = (address, request) => {
  const url = new URL(address);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Adresse attendue : http://127.0.0.1:PORT');
  if (typeof request !== 'function')
    throw new Error('GM_xmlhttpRequest indisponible : réinstaller le lecteur avec ses permissions.');
  const base = url.origin + '/api/v1/connector/privileged/';
  let capability = null,
    active = false,
    sequence = 0,
    busy = false, features = null;
  let latencyMs = null;
  async function post(operation, body, authenticated = true) {
    if (
      ![
        'claim',
        'renew',
        'status',
        'observations',
        'disconnect',
        'pixel-claim',
        'pixel-check',
        'pixel-result',
        'batch-claim',
        'batch-check',
        'batch-result',
        'upgrade-claim',
        'upgrade-check',
        'upgrade-result',
      ].includes(operation)
    )
      throw new Error('Opération interdite');
    if (authenticated && !capability) throw new Error('Canal non couplé');
    const data = JSON.stringify(body);
    if (new TextEncoder().encode(data).length > 768 * 1024) throw new Error('Lot trop volumineux');
    // Server-paced replies: page timers may be throttled to one wake-up/minute in a hidden tab.
    return new Promise((resolve, reject) => {
      let completed = false,
        handle;
      const start = performance.now();
      const finish = (error, result) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (error) {
          error.transient = /locale absente|privilégié indisponible|Transport GM_xmlhttpRequest/.test(error.message);
          reject(error);
        }
        else {
          latencyMs = Math.round(performance.now() - start);
          resolve(result);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('Réponse locale absente ou expirée'));
        handle?.abort();
      }, 8_000);
      try {
        handle = request({
          method: 'POST',
          url: base + operation,
          data,
          anonymous: true,
          redirect: 'error',
          timeout: 8000,
          headers: {
            'Content-Type': 'application/json',
            ...(authenticated ? { Authorization: 'Bearer ' + capability } : {}),
          },
          onload: (response) => {
            try {
              if (
                response.status !== 200 ||
                (response.finalUrl && response.finalUrl !== base + operation) ||
                response.responseText.length > (operation==='batch-claim'?128*1024:8192)
              )
                throw new Error('Requête refusée : vérifier approbation, révocation et expiration.');
              finish(null, JSON.parse(response.responseText));
            } catch (error) {
              finish(error);
            }
          },
          onerror: () =>
            finish(new Error('Transport privilégié indisponible : vérifier serveur et autorisation Tampermonkey.')),
          ontimeout: () => finish(new Error('Réponse locale absente ou expirée')),
          onabort: () => finish(new Error('Requête locale interrompue')),
        });
      } catch {
        finish(new Error('Transport GM_xmlhttpRequest refusé'));
      }
    });
  }
  return {
    async pair(code, origin, pending) {
      if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('Code de couplage invalide');
      const claimed = await post('claim', { protocol: 1, origin, code }, false);
      if (
        !/^[a-f0-9]{64}$/.test(claimed.capability) ||
        !/^[a-f0-9]{64}$/.test(claimed.requestId) ||
        !/^[a-f0-9]{12}$/.test(claimed.fingerprint)
      )
        throw new Error('Réponse de couplage invalide');
      capability = claimed.capability;
      pending(claimed.fingerprint);
      for (let i = 0; i < 60; i++) {
        const state = await post('status', { protocol: 1, readerVersion: 10, waitMs: 5000 });
        if (state.approved === true && state.lastSequence === 0) {
          if (state.pacing !== 'server-50ms' || state.regionalProtocol !== 1 || state.batchProtocol !== 6)
            throw new Error('Serveur incompatible : mettre à jour GeoPlacer et refaire le couplage.');
          features = state.limits;
          active = true;
          return;
        }
        if (state.approved !== false) throw new Error('État de couplage invalide');
      }
      throw new Error('Confirmation du dashboard expirée');
    },
    async send(observation) {
      if (!active || busy) throw new Error('Canal indisponible ou envoi concurrent');
      busy = true;
      const next = sequence + 1;
      const payload = { protocol: 1, observations: [{ ...observation, sequence: next }] };
      try {
        let answer;
        try {
          answer = await post('observations', payload);
        } catch (error) {
          if (!String(error.message).includes('absente') && !String(error.message).includes('indisponible'))
            throw error;
          // Exact same observation only: server deduplicates its sequence AND content digest.
          answer = await post('observations', payload);
        }
        if (answer.accepted !== true || answer.sequence !== next) throw new Error('Observation non confirmée');
        sequence = next;
      } catch (error) {
        active = false; // Two missing observation ACKs leave the sequence uncertain: fail closed.
        throw error;
      } finally {
        busy = false;
      }
    },
    async heartbeat(monitoring) {
      if (!active || busy) return;
      const answer = await post('status', {
        protocol: 1,
        readerVersion: 10,
        ...(monitoring ? { monitoring } : {}),
      });
      if (answer.approved !== true || answer.lastSequence !== sequence) {
        active = false;
        throw new Error('Canal expiré ou séquence incertaine');
      }
      return answer;
    },
    async poll(monitoring, abortedCapture, writerResources) {
      if (!active) throw new Error('Canal non couplé');
      const answer = await post('status', {
        protocol: 1,
        readerVersion: 10,
        waitMs: 5000,
        ...(writerResources ? { writerResources } : {}),
        ...(abortedCapture ? { abortedCapture } : {}),
        ...(monitoring ? { monitoring } : {}),
      });
      // A manual observation may overlap a held status response. Old status is not an observation ACK.
      if (
        answer.approved !== true ||
        !Number.isSafeInteger(answer.lastSequence) ||
        answer.lastSequence > sequence + (busy ? 1 : 0)
      ) {
        active = false;
        throw new Error('Canal expiré ou séquence incertaine');
      }
      return answer;
    },
    features: () => features,
    async renew() {
      const nonce=crypto.randomUUID();let answer;
      try {answer=await post('renew',{protocol:1,nonce});}
      catch(error){if(!error.transient)throw error;answer=await post('renew',{protocol:1,nonce});}
      if(answer.nonce!==nonce || !/^[a-f0-9]{64}$/.test(answer.capability))throw new Error('Rotation de capacité invalide');
      capability=answer.capability; // The next authenticated request commits possession; no work permission changes.
    },
    waitForRetry: () => new Promise(resolve=>setTimeout(resolve,1000)),
    // Single delivery. In particular, NEVER retry a command claim or a site operation.
    async claimPixel() {
      if (!active) throw new Error('Canal non couplé');
      return (await post('pixel-claim', { protocol: 1 })).command;
    },
    async pixelAllowed(attemptId) {
      if (!active) return false;
      return (await post('pixel-check', { protocol: 1, attemptId })).allowed === true;
    },
    async pixelResult(attemptId, result) {
      return post('pixel-result', { protocol: 1, attemptId, result });
    },
    async claimUpgrade(){return (await post('upgrade-claim',{protocol:1})).command;},
    async upgradeAllowed(id){return active && (await post('upgrade-check',{protocol:1,id})).allowed===true;},
    async upgradeResult(id,result){return post('upgrade-result',{protocol:1,id,result});},
    async claimBatch() {
      if (!active) throw new Error('Canal non couplé');
      return (await post('batch-claim', { protocol: 1 })).command;
    },
    async batchAllowed(batchId, attemptId) {
      return active && (await post('batch-check', { protocol: 1, batchId, attemptId })).allowed === true;
    },
    async batchResult(batchId, attemptId, result) {
      return post('batch-result', { protocol: 1, batchId, attemptId, result });
    },
    async disconnect() {
      active = false;
      try {
        if (capability) await post('disconnect', { protocol: 1 });
      } finally {
        capability = null;
      }
    },
    connected: () => active,
    latency: () => latencyMs,
  };
};
