/**
 * Compile-time guarantees of the contracts. These checks run when the
 * package is type-checked (npm run typecheck): every @ts-expect-error must
 * correspond to a real type error, otherwise the check itself fails.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentId,
  CanvasProvider,
  CanvasReader,
  CanvasSnapshot,
  CanvasWriter,
  ProgressSnapshot,
  ReadOnlyCanvasProvider,
  ReadWriteCanvasProvider,
  Rgb,
  SchedulerDependencies,
  TemplateId,
  RevisionRecordV1,
  TemplateManager,
  TemplateManifestV2,
} from '../src/index.js';

// Type-level stand-ins: never called, only used to build typed values.
const reader = {} as CanvasReader;
const writer = {} as CanvasWriter;

const readOnly: ReadOnlyCanvasProvider = { id: 'snapshot', mode: 'read-only', reader };
const readWrite: ReadWriteCanvasProvider = { id: 'simulator', mode: 'read-write', reader, writer };

describe('canvas capabilities are separated', () => {
  it('a read-only provider has no writer', () => {
    // @ts-expect-error a read-only provider exposes no writer
    void readOnly.writer;
    expectTypeOf(readWrite.writer).toEqualTypeOf<CanvasWriter>();
  });

  it('the scheduler only accepts a writable provider', () => {
    expectTypeOf<SchedulerDependencies['canvas']>().toEqualTypeOf<ReadWriteCanvasProvider>();
    const deps: Pick<SchedulerDependencies, 'canvas'> = { canvas: readWrite };
    void deps;
    // @ts-expect-error a read-only snapshot provider cannot be given to the scheduler
    const wrong: Pick<SchedulerDependencies, 'canvas'> = { canvas: readOnly };
    void wrong;
  });

  it('writing requires narrowing a CanvasProvider to read-write', () => {
    const provider = readOnly as CanvasProvider;
    // @ts-expect-error the writer is only reachable after checking the mode
    void provider.writer;
    if (provider.mode === 'read-write') expectTypeOf(provider.writer).toEqualTypeOf<CanvasWriter>();
  });
});

describe('snapshots carry their origin and age', () => {
  it('a snapshot must declare source and observedAt', () => {
    expectTypeOf<CanvasSnapshot['source']>().toEqualTypeOf<'simulated' | 'imported-snapshot'>();
    expectTypeOf<CanvasSnapshot['observedAt']>().toEqualTypeOf<number>();
    // @ts-expect-error source and observedAt are mandatory
    const incomplete: CanvasSnapshot = { rect: { minX: 0, minY: 0, width: 1, height: 1 }, get: () => -1 };
    void incomplete;
  });

  it('progress keeps the basis it was measured on', () => {
    expectTypeOf<ProgressSnapshot['basis']['source']>().toEqualTypeOf<'simulated' | 'imported-snapshot'>();
  });
});

describe('nominal identifiers and colors', () => {
  it('identifiers of different kinds are not interchangeable', () => {
    const templateId = 'tpl' as TemplateId;
    // @ts-expect-error a TemplateId is not an AgentId
    const agent: AgentId = templateId;
    void agent;
    // @ts-expect-error a plain string is not a TemplateId
    const plain: TemplateId = 'tpl';
    void plain;
  });

  it('a plain number is not an Rgb color', () => {
    // @ts-expect-error colors must be created explicitly
    const color: Rgb = 0xff0000;
    void color;
  });
});

describe('template manifest (PNG blobs + JSON)', () => {
  it('pins the schema version and carries the required metadata', () => {
    expectTypeOf<TemplateManifestV2['schemaVersion']>().toEqualTypeOf<2>();
    expectTypeOf<TemplateManifestV2['numbering']>().toEqualTypeOf<'legacy' | 'reserved'>();
    for (const key of ['templateId', 'projectId', 'name', 'drawingStrategy', 'createdAt', 'updatedAt', 'currentRevision', 'generation', 'extensions'] as const) {
      expectTypeOf<TemplateManifestV2>().toHaveProperty(key);
    }
  });

  it('keeps the content of each revision in an immutable record', () => {
    for (const key of [
      'revision', 'width', 'height', 'placement', 'coordinateSystem', 'palette', 'alphaThreshold',
      'quantizationMethod', 'sourceImageHash', 'quantizedImageHash', 'quantizedFileHash', 'createdAt',
    ] as const) {
      expectTypeOf<RevisionRecordV1>().toHaveProperty(key);
    }
    expectTypeOf<RevisionRecordV1['sourceImageHash']>().toEqualTypeOf<string>();
  });

  it('exposes an asynchronous template manager', () => {
    expectTypeOf<ReturnType<TemplateManager['create']>>().toExtend<Promise<unknown>>();
    expectTypeOf<ReturnType<TemplateManager['load']>>().toExtend<Promise<unknown>>();
  });
});
