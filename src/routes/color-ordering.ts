/**
 * Color ordering routes
 */

import { Router, Request, Response } from 'express';
import path from 'node:path';
import { palette, DATA_DIR, HTTP_STATUS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { readJsonWithRecovery, writeJsonAtomic } from '../utils/json-store.js';
import { reportJsonLoad } from '../utils/helpers.js';

const router = Router();

// Default color order sorted by id
const defaultColorOrder = Object.values(palette).sort((a, b) => a - b);

// Store color orders
let colorOrdering: { global: number[]; templates: Record<string, number[]> } = {
  global: [...defaultColorOrder],
  templates: {},
};

// Load color ordering from disk
function loadColorOrdering(): void {
  const orderingPath = path.join(DATA_DIR, 'color_ordering.json');

  const result = readJsonWithRecovery<{ global?: number[]; templates?: Record<string, number[]> } | null>(
    orderingPath,
    () => null
  );
  reportJsonLoad(orderingPath, result);
  if (result.data) {
    colorOrdering = {
      global: result.data.global || [...defaultColorOrder],
      templates: result.data.templates || {},
    };
  }
}

// Save color ordering to disk
function saveColorOrdering(): void {
  const orderingPath = path.join(DATA_DIR, 'color_ordering.json');

  try {
    writeJsonAtomic(orderingPath, colorOrdering);
    logger.info('Color ordering saved successfully');
  } catch (e: any) {
    logger.error('Error saving color ordering:', e.message);
    throw e;
  }
}

// Helper to get color order for specific context
function getColorOrder(templateId: string | null = null): number[] {
  return templateId && colorOrdering.templates[templateId]
    ? colorOrdering.templates[templateId]
    : colorOrdering.global;
}

// Helper to set color order for specific context
function setColorOrder(order: number[], templateId: string | null = null): void {
  if (templateId) {
    colorOrdering.templates[templateId] = [...order];
  } else {
    colorOrdering.global = [...order];
  }
  saveColorOrdering();
}

const validateColorIds = (order: number[]): number[] => {
  const validIds = new Set(Object.values(palette));
  return order.filter((id) => Number.isInteger(id) && validIds.has(id));
};

// Load color ordering on module init
loadColorOrdering();

router.get('/color-ordering', (_req: Request, res: Response) => {
  res.json(colorOrdering);
});

router.get('/color-ordering/global', (_req: Request, res: Response) => {
  res.json(colorOrdering.global);
});

router.get('/color-ordering/template/:templateId', (req: Request, res: Response) => {
  const { templateId } = req.params;
  const order = getColorOrder(templateId);
  res.json(order);
});

router.put('/color-ordering/global', (req: Request, res: Response): void => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    res.status(HTTP_STATUS.BAD_REQ).json({ error: 'Invalid order format' });
    return;
  }
  const validOrder = validateColorIds(order);
  setColorOrder(validOrder, null);
  res.status(HTTP_STATUS.OK).json({ success: true });
});

router.put('/color-ordering/template/:templateId', (req: Request, res: Response): void => {
  const { templateId } = req.params;
  const { order } = req.body;
  if (!Array.isArray(order)) {
    res.status(HTTP_STATUS.BAD_REQ).json({ error: 'Invalid order format' });
    return;
  }
  const validOrder = validateColorIds(order);
  setColorOrder(validOrder, templateId);
  res.status(HTTP_STATUS.OK).json({ success: true });
});

router.delete('/color-ordering/template/:templateId', (req: Request, res: Response): void => {
  const { templateId } = req.params;
  delete colorOrdering.templates[templateId];
  saveColorOrdering();
  res.status(HTTP_STATUS.OK).json({ success: true });
});

export { getColorOrder };
export default router;
