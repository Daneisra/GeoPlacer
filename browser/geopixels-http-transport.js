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
    busy = false;
  let latencyMs = null,
    lastDispatch = -Infinity;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function post(operation, body, authenticated = true) {
    if (!['claim', 'status', 'observations', 'disconnect'].includes(operation)) throw new Error('Opération interdite');
    if (authenticated && !capability) throw new Error('Canal non couplé');
    const data = JSON.stringify(body);
    if (new TextEncoder().encode(data).length > 768 * 1024) throw new Error('Lot trop volumineux');
    const delay = Math.max(0, lastDispatch + 50 - performance.now());
    lastDispatch = performance.now() + delay;
    if (delay) await pause(delay); // <= 20 requests/s, including heartbeats and exact retries.
    return new Promise((resolve, reject) => {
      let completed = false,
        handle;
      const start = performance.now();
      const finish = (error, result) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (error) reject(error);
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
          headers: {
            'Content-Type': 'application/json',
            ...(authenticated ? { Authorization: 'Bearer ' + capability } : {}),
          },
          onload: (response) => {
            try {
              if (
                response.status !== 200 ||
                (response.finalUrl && response.finalUrl !== base + operation) ||
                response.responseText.length > 8192
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
        const state = await post('status', { protocol: 1, readerVersion: 3 });
        if (state.approved === true && state.lastSequence === 0) {
          active = true;
          return;
        }
        if (state.approved !== false) throw new Error('État de couplage invalide');
        await pause(1000);
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
        active = false;
        throw error;
      } finally {
        busy = false;
      }
    },
    async heartbeat(monitoring) {
      if (!active || busy) return;
      const answer = await post('status', { protocol: 1, readerVersion: 3, ...(monitoring ? { monitoring } : {}) });
      if (answer.approved !== true || answer.lastSequence !== sequence) {
        active = false;
        throw new Error('Canal expiré ou séquence incertaine');
      }
      return answer;
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
