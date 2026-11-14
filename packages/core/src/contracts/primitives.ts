/**
 * Shared primitives: branded identifiers, colors, time and cancellation.
 * Layer 0 — imports nothing.
 */

declare const brand: unique symbol;
/** Nominal typing: a TemplateId cannot be passed where an AgentId is expected. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TemplateId = Brand<string, 'TemplateId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type AgentId = Brand<string, 'AgentId'>;
/** Stable pixel-task key derived from (templateId, revision, x, y, color). */
export type TaskId = Brand<string, 'TaskId'>;
/** Stable attempt key, also used as the provider's idempotency key. */
export type AttemptId = Brand<string, 'AttemptId'>;

/** 24-bit color 0xRRGGBB. */
export type Rgb = Brand<number, 'Rgb'>;

/** Transparent pixel at the API level (TemplatePixel, CanvasPixel). */
export const TRANSPARENT = -1;
/** Canvas pixel that could not be read (outside bounds, not loaded). */
export const UNKNOWN = -2;
/** Storage sentinel for a transparent pixel inside TemplateImage.pixels (outside the 24-bit range). */
export const TRANSPARENT_U32 = 0xffffffff;

export type TemplatePixel = Rgb | typeof TRANSPARENT;
export type CanvasPixel = Rgb | typeof TRANSPARENT | typeof UNKNOWN;

/** Epoch milliseconds. */
export type Timestamp = number;

/** Minimal abort signal, structurally compatible with the DOM/Node AbortSignal. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/** Injected time source: every time-dependent rule is testable with a virtual clock. */
export interface Clock {
  now(): Timestamp;
  sleep(ms: number, signal?: AbortSignalLike): Promise<void>;
}
