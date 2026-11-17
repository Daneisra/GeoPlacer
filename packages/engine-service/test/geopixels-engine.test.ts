import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EngineService, STRATEGIES, createBackup, verifyBackup, restoreBackup } from '../src/index.js';
import type { BrowserCommand } from '../src/geopixels/provider.js';
import { cleanup, demoPng, openFast, tempDir, waitFor } from './helpers.js';

const opened: EngineService[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  await cleanup();
});
async function prepare(w = 8, h = 8, strategy = 'top-to-bottom') {
  const dir = await tempDir();
  const { service: s } = await openFast(dir);
  opened.push(s);
  const t = await s.importTemplate({
    name: 'Local contract fixture',
    png: await demoPng(w, h, (x, y) => ((x + y) % 7 === 0 ? null : 0)),
    x: 2,
    y: 3,
    strategy,
  });
  await s.selectTemplate(t.templateId);
  await s.selectSource('geopixels');
  return { s, dir, t };
}
function browser(s: EngineService, width: number, height: number, opts: { lost?: boolean; pending?: boolean } = {}) {
  const pixels = new Array<number>(width * height).fill(-1);
  const commands: BrowserCommand[] = [];
  let sequence = 0;
  let current = s;
  const project = { id: 'durable-ghost', generation: '1', width, height, gridX: -1001, gridY: 1001, layer: 'base' };
  function observe() {
    const r = current.settings.simulator;
    const now = Date.now();
    const colors = [0, 0xffffff];
    // Tests use the first palette color; obtain actual palette, not a fabricated account palette.
    return current.connectorView().then((view) => {
      const rules = view.rules!;
      const palette = [...rules.palette.initialColors, ...rules.palette.unlockable.map((c) => c.color)];
      current.connector.observe({
        type: 'observation',
        sequence: ++sequence,
        session: 'browser-session',
        project,
        capturedAt: now,
        observedAt: now,
        rect: { x: project.gridX, y: project.gridY - height + 1, width, height },
        pixels: Array.from({ length: pixels.length }, (_, i) => pixels[(height - 1 - Math.floor(i / width)) * width + (i % width)]),
        resources: {
          observedAt: now,
          energy: 100_000,
          capacity: r.capacity,
          currency: 5000,
          regenIntervalMs: r.regenIntervalMs,
          colors: palette.length ? palette : colors,
        },
      });
    });
  }
  function connect(target = s) {
    current = target;
    sequence = 0;
    current.connector.connect('local-fake', (command) => {
      commands.push(command);
      if (opts.pending) return;
      for (const w of command.writes) pixels[(project.gridY - w.gridY) * width + w.gridX - project.gridX] = w.color;
      if (opts.lost) {
        opts.lost = false;
        current.connector.disconnect('lost response');
        return;
      }
      void observe().then(() =>
        current.connector.result({
          type: 'result',
          id: command.id,
          attemptId: command.attemptId,
          session: 'browser-session',
          outcomes: command.writes.map((w) => ({ taskId: w.taskId, status: 'applied' })),
        })
      );
    });
    return observe();
  }
  return { pixels, commands, project, connect, observe };
}

describe('Existing scheduler through GeoPixels browser provider', () => {
  it('persists region configuration but restores neither observations nor live authority', async () => {
    const {s,dir}=await prepare(8,5);
    const project={id:'regional-fixture',generation:'palette',width:8,height:5,gridX:999,gridY:1001,layer:'base'};
    const attach=async(service:EngineService)=>{
      service.connector.connect('read-only',()=>{throw new Error('read only');});
      service.connector.monitoring.capabilities(true,true);
      service.connector.observe({type:'observation',sequence:1,session:'new-private-context',project,capturedAt:Date.now(),observedAt:null,resources:null,
        rect:{x:project.gridX,y:project.gridY-4,width:8,height:5},pixels:new Array(40).fill(-2)});
      await service.bindConnector();
    };
    await attach(s);
    const regions=[{id:'left',name:'Left',x:0,y:0,width:4,height:5,priority:'primary',enabled:true}];
    await s.configureConnectorRegions(regions);
    expect((await s.connectorView()).monitoring.configuredRegions).toEqual(regions);
    await s.close();opened.splice(opened.indexOf(s),1);
    const restored=await EngineService.open({dataDir:dir});opened.push(restored);
    expect((await restored.connectorView())).toMatchObject({connected:false,savedRegionConfiguration:{available:true,matching:false,count:1},monitoring:{state:'stopped',configuredRegions:[]}});
    await expect(restored.configureConnectorRegions([],true)).rejects.toThrow();
    await attach(restored);
    expect((await restored.connectorView()).savedRegionConfiguration.matching).toBe(true);
    await restored.configureConnectorRegions([],true);
    expect(restored.connector.monitoring.view().configuredRegions).toEqual(regions);
    restored.connector.disconnect('new session');
    project.gridX++;
    await attach(restored);
    await expect(restored.configureConnectorRegions([],true)).rejects.toThrow(/another model or position/);
    expect(restored.connector.canWrite()).toBe(false);
  });
  it('records real-reader progress using core rules and restores history without restarting monitoring', async () => {
    const {s,dir,t}=await prepare(8,5);
    s.connector.connect('read-only',()=>{ throw new Error('must never execute'); });
    const project={id:'real-reader-fixture',generation:'palette',width:8,height:5,gridX:999,gridY:1001,layer:'base'};
    let sequence=0;
    const observe=(pixels:number[])=>s.connector.observe({type:'observation',sequence:++sequence,session:'opaque',project,capturedAt:Date.now(),observedAt:null,resources:null,
      rect:{x:999,y:997,width:8,height:5},pixels,capture:{id:`capture-${sequence}`,index:0,count:1}});
    observe(new Array(40).fill(-1)); await s.bindConnector();
    s.connector.monitoring.capabilities(true);s.connector.monitoring.command('start',5000);
    observe(new Array(40).fill(0));
    const correct=await s.connectorView();
    expect(correct.progress).toMatchObject({incorrect:0,unknown:0});
    expect(correct.progress!.correct).toBeGreaterThan(0);
    observe(new Array(40).fill(0xffffff));
    expect((await s.connectorView()).progress!.incorrect).toBe(correct.progress!.total);
    observe(new Array(40).fill(-1));
    expect((await s.connectorView()).progress!.missing).toBe(correct.progress!.total);
    await Promise.resolve();
    expect(s.connector.monitoring.view().lastCapture?.changedKnown).toBe(40);
    expect(s.connector.canWrite()).toBe(false);
    await s.close(); opened.splice(opened.indexOf(s),1);
    const restored=await EngineService.open({dataDir:dir});opened.push(restored);
    const history=restored.connector.monitoring.view();
    expect(history.history).toHaveLength(4);
    expect(history.history[3]!.templateId).toBe(t.templateId);
    expect(history.state).toBe('stopped');expect(history.supported).toBe(false);
    expect(restored.connector.status().connected).toBe(false);
    expect(restored.status().journal.openAttempts).toBe(0);
  });
  it('backs up and restores the provider domain without restoring a live pairing', async () => {
    const { s, dir } = await prepare(2, 2);
    const b = browser(s, 2, 2); await b.connect(); await s.bindConnector();
    await s.start(); expect((await s.done()).state).toBe('completed');
    await s.close();
    const backupRoot = await tempDir('gp-connector-backup-');
    const saved = await createBackup(dir, backupRoot);
    const manifest = await verifyBackup(saved.dir);
    expect(manifest.files.some((f) => f.path.startsWith('providers/geopixels/journal/'))).toBe(true);
    expect(manifest.files.some((f) => f.path === 'connector-binding.json')).toBe(true);
    const destination = path.join(await tempDir(), 'restored');
    await restoreBackup(saved.dir, destination);
    const restored = await EngineService.open({ dataDir: destination }); opened.push(restored);
    expect(restored.status().mode).toBe('geopixels');
    expect(restored.status().journal.openAttempts).toBe(0);
    expect(restored.connector.status().connected).toBe(false);
    expect(restored.pairing.acceptsOrigin('https://www.geopixels.net')).toBe(false);
    await b.connect(restored); await restored.bindConnector();
    expect((await restored.connectorView()).progress!.incorrect).toBe(0);
  });

  it.each(STRATEGIES)('keeps strategy %s and transparent pixels with the same planner', async (strategy) => {
    const { s } = await prepare(8, 8, strategy);
    const b = browser(s, 8, 8);
    await b.connect();
    await s.bindConnector();
    const view = await s.connectorView();
    expect(view.progress!.unknown).toBe(0);
    expect(view.progress!.excluded.transparent).toBeGreaterThan(0);
    await s.start();
    const final = await s.done();
    expect(final.state).toBe('completed');
    expect((await s.connectorView()).progress!.incorrect).toBe(0);
    expect(b.commands.flatMap((c) => c.writes).length).toBe(view.progress!.total);
    expect((await s.canvasRegion({ minX: 2, minY: 3, width: 8, height: 8 })).data).not.toBe(''); // Simulation remains a separate readable world.
    await s.selectSource('simulation');
    expect(s.status().mode).toBe('simulation');
    await s.start();
    expect((await s.done()).state).toBe('completed');
  });
  it('recovers a lost response after server and browser restart without replaying its pixels', async () => {
    const { s, dir } = await prepare(1, 2);
    const b = browser(s, 1, 2, { lost: true });
    await b.connect();
    await s.bindConnector();
    await s.start();
    await waitFor(s, (v) => v.state === 'error');
    expect(s.status().journal.openAttempts).toBe(1);
    expect(b.commands).toHaveLength(1);
    const journal = await readFile(path.join(dir, 'providers/geopixels/journal/attempts.log'), 'utf8');
    expect(journal).toContain('started');
    await s.close();
    await new Promise((r) => setTimeout(r, 10));
    const restarted = await EngineService.open({ dataDir: dir });
    opened.push(restarted);
    expect(restarted.status().mode).toBe('geopixels');
    expect(restarted.status().journal.openAttempts).toBe(1);
    await b.connect(restarted);
    await restarted.bindConnector();
    await restarted.start();
    expect((await restarted.done()).state).toBe('completed');
    expect(b.commands).toHaveLength(1);
    expect(restarted.status().journal.openAttempts).toBe(0);
  });
  it('refuses source changes and mismatched project reconciliation while an attempt is uncertain', async () => {
    const { s } = await prepare(1, 2);
    const b = browser(s, 1, 2, { lost: true });
    await b.connect();
    await s.bindConnector();
    await s.start();
    await waitFor(s, (v) => v.state === 'error');
    await expect(s.selectSource('simulation')).rejects.toThrow(/reconcile/);
    s.connector.connect('local-fake', () => {});
    s.connector.observe({
      type: 'observation',
      sequence: 1,
      session: 'new-browser',
      project: { ...b.project, gridX: 40 },
      capturedAt: Date.now(),
      observedAt: Date.now(),
      rect: { x: 40, y: 1000, width: 1, height: 2 },
      pixels: [-1, -1],
      resources: null,
    });
    await expect(s.bindConnector()).rejects.toThrow(/another browser project/);
  });
  it('stops during an operation and retains its durable intent', async () => {
    const { s } = await prepare(1, 2);
    const b = browser(s, 1, 2, { pending: true });
    await b.connect();
    await s.bindConnector();
    await s.start();
    await waitFor(s, () => b.commands.length === 1);
    await s.stop({ abort: true });
    expect(s.status().journal.openAttempts).toBe(1);
    expect(b.commands).toHaveLength(1);
  });
  it('supports controlled pause and resume through the same scheduler', async () => {
    const { s } = await prepare();
    const b = browser(s, 8, 8, { pending: true });
    await b.connect();
    await s.bindConnector();
    await s.start();
    await waitFor(s, () => b.commands.length === 1);
    const pausing = s.pause();
    const c = b.commands[0]!;
    s.connector.result({
      type: 'result',
      id: c.id,
      attemptId: c.attemptId,
      session: 'browser-session',
      outcomes: c.writes.map((w) => ({ taskId: w.taskId, status: 'unknown' })),
    });
    await pausing;
    expect(s.status().state).toBe('paused');
    s.resume();
    await s.stop({ abort: true });
  });
  it('never starts a writer on the read-only channel or modifies simulated resources', async () => {
    const { s } = await prepare();
    s.connector.connect('read-only', () => {});
    s.connector.observe({
      type: 'observation',
      sequence: 1,
      session: 'readonly',
      project: { id: 'r', generation: '1', width: 8, height: 8, gridX: 0, gridY: 8, layer: 'base' },
      capturedAt: Date.now(),
      observedAt: null,
      rect: { x: 0, y: 1, width: 8, height: 8 },
      pixels: new Array(64).fill(0),
      resources: null,
    });
    await s.bindConnector();
    await expect(s.start()).rejects.toThrow(/unavailable/);
    expect(s.status().journal.openAttempts).toBe(0);
    await expect(s.resetAgent()).rejects.toThrow(/simulation source/);
  });
});
