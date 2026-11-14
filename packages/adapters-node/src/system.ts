import { randomUUID } from 'node:crypto';
import type { IdSource, TemplateId, TimeSource } from '@geoplacer/core';

/** Random UUID v4 (lower-case, matches the core id pattern). */
export const randomIdSource: IdSource = {
  newTemplateId: () => randomUUID() as TemplateId,
};

export const systemClock: TimeSource = {
  now: () => Date.now(),
};
