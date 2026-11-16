/* Local fake service, deliberately independent of the real GeoPixels writer. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let ws = null,
    timer = null,
    sequence = 0,
    project = null,
    world = null,
    rules = null,
    storageKey = null;
  const session = crypto.randomUUID();
  async function get(path) {
    const r = await fetch(`/api/v1/${path}`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  function save() {
    localStorage.setItem(storageKey, JSON.stringify(world));
  }
  function render() {
    $('state').textContent = ws?.readyState === 1 ? 'Connecté — fournisseur factice' : 'Déconnecté';
    $('details').textContent = JSON.stringify(
      { project, operations: Object.keys(world?.applied ?? {}).length, energy: world?.energy },
      null,
      2
    );
    if (!world) return;
    const c = $('preview');
    c.width = project.width;
    c.height = project.height;
    const ctx = c.getContext('2d'),
      image = ctx.createImageData(c.width, c.height);
    world.pixels.forEach((color, index) => {
      if (color < 0) return;
      const n = index * 4;
      image.data[n] = (color >> 16) & 255;
      image.data[n + 1] = (color >> 8) & 255;
      image.data[n + 2] = color & 255;
      image.data[n + 3] = 255;
    });
    ctx.putImageData(image, 0, 0);
  }
  async function load() {
    if (ws?.readyState === 1) throw new Error('Déconnecter avant de changer de modèle');
    const status = await get('engine/status');
    if (!status.selection) throw new Error('Importer et sélectionner un modèle dans le dashboard de simulation');
    const info = await get(`templates/${status.selection.templateId}/image?s=1`);
    if (info.width > 2000 || info.height > 2000) throw new Error('Limite 2000 × 2000');
    project = {
      id: status.selection.templateId,
      generation: String(status.selection.revision),
      width: info.width,
      height: info.height,
      gridX: -1001,
      gridY: 1001,
      layer: 'base',
    };
    rules = status.settings.simulator;
    storageKey = `geoplacer.fixture.v1.${project.id}.${project.generation}`;
    world = JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? {
      pixels: new Array(project.width * project.height).fill(-1),
      energy: 1_000_000,
      applied: {},
    };
    save();
    render();
  }
  async function observe(partial = false) {
    if (!world || ws?.readyState !== 1) return;
    const heightLimit = partial ? Math.max(1, Math.floor(project.height / 2)) : project.height;
    const state = await get('connector/status');
    const palette = state.rules?.palette;
    const colors = palette ? [...new Set([...palette.initialColors, ...palette.unlockable.map((c) => c.color)])] : [0, 0xffffff];
    for (let row = 0; row < heightLimit;) {
      const height = Math.min(heightLimit - row, Math.floor(65536 / project.width));
      const rect = { x: project.gridX, y: project.gridY - row - height + 1, width: project.width, height };
      const pixels = [];
      for (let y = 0; y < height; y++) {
        const iy = row + height - 1 - y;
        for (let x = 0; x < project.width; x++) pixels.push(world.pixels[iy * project.width + x]);
      }
      const date = Date.now();
      while (ws.bufferedAmount > 500_000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (ws.readyState !== 1) return;
      }
      ws.send(
        JSON.stringify({
          type: 'observation',
          sequence: ++sequence,
          session,
          project,
          capturedAt: date,
          observedAt: date,
          rect,
          pixels,
          resources: {
            observedAt: date,
            energy: world.energy,
            capacity: rules.capacity,
            currency: 1000,
            regenIntervalMs: rules.regenIntervalMs,
            colors,
          },
        })
      );
      row += height;
      await new Promise((resolve) => setTimeout(resolve, 30)); // Bound traffic on the local authenticated channel.
    }
  }
  async function execute(command) {
    if (
      command.type !== 'execute-fake' ||
      command.protocol !== 1 ||
      command.session !== session ||
      JSON.stringify(command.project) !== JSON.stringify(project)
    )
      throw new Error('Commande incompatible');
    const payload = JSON.stringify(command.writes);
    let entry = world.applied[command.attemptId];
    if (entry && entry.payload !== payload) throw new Error('Collision d’identifiant');
    if (!entry) {
      const outcomes = command.writes.map((w) => {
        const x = w.gridX - project.gridX,
          y = project.gridY - w.gridY;
        if (
          !Number.isInteger(x) ||
          !Number.isInteger(y) ||
          x < 0 ||
          y < 0 ||
          x >= project.width ||
          y >= project.height ||
          world.energy < rules.costPerPixel
        )
          throw new Error('Opération factice refusée');
        const index = y * project.width + x,
          correct = world.pixels[index] === w.color;
        if (!correct) {
          world.pixels[index] = w.color;
          world.energy -= rules.costPerPixel;
        }
        return { taskId: w.taskId, status: correct ? 'already-correct' : 'applied' };
      });
      entry = { payload, outcomes };
      world.applied[command.attemptId] = entry;
      save(); // World + operation results in ONE localStorage value, before acknowledging.
    }
    render();
    if ($('cut').checked) {
      $('cut').checked = false;
      ws.close();
      return;
    }
    const lose = $('lose').checked;
    $('lose').checked = false;
    await observe();
    if (!lose && ws?.readyState === 1)
      ws.send(JSON.stringify({ type: 'result', id: command.id, attemptId: command.attemptId, session, outcomes: entry.outcomes }));
  }
  function handle(fn) {
    return () =>
      Promise.resolve()
        .then(fn)
        .catch((e) => {
          $('state').textContent = e.message;
        });
  }
  $('load').onclick = handle(load);
  $('observe').onclick = handle(() => observe());
  $('partial').onclick = handle(() => observe(true));
  $('damage').onclick = handle(async () => {
    if (!world) return;
    const index = world.pixels.findIndex((color) => color >= 0);
    if (index < 0) return;
    world.pixels[index] = world.pixels[index] === 0 ? 0xffffff : 0;
    save();
    render();
    await observe();
  });
  $('disconnect').onclick = () => ws?.close();
  $('connect').onclick = handle(async () => {
    if (!world) await load();
    if (ws && ws.readyState < 2) throw new Error('Canal déjà ouvert');
    let capability = $('capability').value;
    $('capability').value = '';
    if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error('Code invalide');
    ws = new WebSocket(`ws://${location.host}/api/v1/connector/channel`);
    const socket = ws;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'pair', protocol: 1, token: capability }));
      capability = null;
    };
    socket.onmessage = (event) =>
      handle(async () => {
        const m = JSON.parse(event.data);
        if (m.type === 'paired') {
          if (m.mode !== 'local-fake') throw new Error('Couplage factice requis');
          render();
          await observe();
          timer = setInterval(() => {
            if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'heartbeat' }));
          }, 5_000);
        } else if (m.type === 'execute-fake') await execute(m);
      })();
    socket.onclose = () => {
      clearInterval(timer);
      if (ws === socket) render();
    };
    socket.onerror = () => {
      $('state').textContent = 'Couplage refusé';
    };
  });
})();
