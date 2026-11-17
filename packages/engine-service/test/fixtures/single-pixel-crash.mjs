// Actual process boundary, synthetic observations only. Exit without a graceful engine close.
import { EngineService } from '../../dist/index.js';
const s = await EngineService.open({ dataDir: process.argv[2] });
s.connector.connect('read-only', () => {
    throw new Error('no site operation');
});
s.connector.observe({
    type: 'observation',
    sequence: 1,
    session: 'crash-fixture',
    project: {
        id: 'single-pixel-ghost',
        generation: '1',
        width: 3,
        height: 2,
        gridX: -1001,
        gridY: 1001,
        layer: 'base',
    },
    capturedAt: Date.now(),
    observedAt: Date.now(),
    rect: { x: -1001, y: 1000, width: 3, height: 2 },
    pixels: new Array(6).fill(-1),
    resources: null,
});
await s.bindConnector();
const prepared = await s.singlePixelWriter.prepare('real');
await s.singlePixelWriter.confirm(prepared.destination.attemptId, prepared.destination);
await s.singlePixelWriter.claim(); // durable started intent, no result
process.exit(0);
