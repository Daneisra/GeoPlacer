import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_COLORS, DEMO_HEIGHT, DEMO_SETTINGS, DEMO_TEMPLATE_NAME, DEMO_WIDTH, EngineService, demoPixels, rulesOf, DEFAULT_SETTINGS } from '../src/index.js';
import { cleanup, demoPng, tempDir, waitFor } from './helpers.js';

afterEach(cleanup);
const opened: EngineService[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close(2_000)));
});

async function open(dir: string) {
  const service = await EngineService.open({ dataDir: dir, eventIntervalMs: 20 });
  opened.push(service);
  return service;
}

describe('demonstration (Phase 1B.10)', () => {
  it('the example picture is deterministic, varied, opaque, and uses only colors the demo agent has unlocked', () => {
    const a = demoPixels();
    expect([...a]).toEqual([...demoPixels()]);
    expect(a.length).toBe(DEMO_WIDTH * DEMO_HEIGHT);
    const colors = new Set(a);
    expect(colors.size).toBeGreaterThanOrEqual(12);
    const unlocked = new Set<number>(rulesOf({ ...DEFAULT_SETTINGS.simulator, ...DEMO_SETTINGS.simulator }).palette.initialColors);
    for (const c of colors) expect(unlocked.has(c), c.toString(16)).toBe(true);
    for (const c of colors) expect(DEMO_COLORS).toContain(c);
  });

  it('is set up on an empty project: demo settings, demo agent, the example selected; the run starts and waits for regeneration', async () => {
    const dir = await tempDir();
    const service = await open(dir);
    expect(await service.demoAvailability()).toMatchObject({ available: true, active: false });
    const r = await service.setupDemo();
    expect(r.status.selection?.name).toBe(DEMO_TEMPLATE_NAME);
    expect(r.status.settings.simulator).toMatchObject(DEMO_SETTINGS.simulator);
    expect(await service.demoAvailability()).toMatchObject({ available: false, active: true });
    const resources = await service.resourcesView();
    expect(resources.energy).toBe(DEMO_SETTINGS.agent.startEnergy);
    expect(resources.currency).toBe(DEMO_SETTINGS.agent.startCurrency);
    await service.start();
    await waitFor(service, (s) => s.state === 'waiting-resources' && (s.scheduler?.applied ?? 0) >= 390, 30_000);
    // Regeneration at 40 energy per second: more pixels within a second or two.
    const before = service.status().scheduler!.applied;
    await waitFor(service, (s) => (s.scheduler?.applied ?? 0) > before + 20, 10_000);
    await service.stop();
  });

  it('is refused on a project that has data, and changes nothing', async () => {
    const dir = await tempDir();
    const service = await open(dir);
    const t = await service.importTemplate({ name: 'Mon modèle', png: await demoPng(8, 8, () => 1), x: 0, y: 0, strategy: 'random' });
    await service.selectTemplate(t.templateId);
    const settingsBefore = await readFile(path.join(dir, 'engine.json'), 'utf8');
    const filesBefore = (await readdir(dir)).sort();
    expect(await service.demoAvailability()).toMatchObject({ available: false });
    await expect(service.setupDemo()).rejects.toMatchObject({ code: 'DEMO_NEEDS_EMPTY_PROJECT' });
    expect(await readFile(path.join(dir, 'engine.json'), 'utf8')).toBe(settingsBefore);
    expect((await readdir(dir)).sort()).toEqual(filesBefore);
    expect((await service.listTemplates()).templates.map((x) => x.name)).toEqual(['Mon modèle']);
    expect(service.status().selection?.templateId).toBe(t.templateId);
  });

  it('is refused while a simulation runs', async () => {
    const dir = await tempDir();
    const service = await open(dir);
    await service.setupDemo();
    await service.start();
    await expect(service.setupDemo()).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    await service.stop();
  });
});
