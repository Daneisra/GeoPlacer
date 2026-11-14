/**
 * Directional strategies, in image space (as the user sees the template):
 *
 *   top-to-bottom   rows from the top (iy ascending), each row left to right
 *   bottom-to-top   rows from the bottom (iy descending), each row left to right
 *   left-to-right   columns from the left (ix ascending), each column top to bottom
 *   right-to-left   columns from the right (ix descending), each column top to bottom
 *
 * Lazy scans of the eligible region: no allocation, the first batch costs
 * only the pixels it reads. A canvas whose y axis points up does not change
 * the order: "top" is always the top of the image as displayed.
 */

import type { DrawingOrderCursor, ImageRect, TemplateImage } from '../contracts/index.js';
import { TRANSPARENT_U32 } from '../contracts/index.js';
import { defineStrategy } from './common.js';

/** Rows of the region (top-down or bottom-up), each scanned left to right. */
function rowCursor(image: TemplateImage, r: ImageRect, bottomUp: boolean): DrawingOrderCursor {
  const { width, pixels } = image;
  const x0 = r.ix;
  const x1 = r.ix + r.width;
  let row = 0;
  let ix = x0;
  return {
    next(out) {
      let n = 0;
      while (n < out.length && row < r.height) {
        const base = (bottomUp ? r.iy + r.height - 1 - row : r.iy + row) * width;
        while (ix < x1 && n < out.length) {
          const i = base + ix++;
          if (pixels[i] !== TRANSPARENT_U32) out[n++] = i;
        }
        if (ix >= x1) {
          ix = x0;
          row++;
        }
      }
      return n;
    },
  };
}

/** Columns of the region (left-right or right-left), each scanned top to bottom. */
function columnCursor(image: TemplateImage, r: ImageRect, rightToLeft: boolean): DrawingOrderCursor {
  const { width, pixels } = image;
  const y0 = r.iy;
  const y1 = r.iy + r.height;
  let column = 0;
  let iy = y0;
  return {
    next(out) {
      let n = 0;
      while (n < out.length && column < r.width) {
        const ix = rightToLeft ? r.ix + r.width - 1 - column : r.ix + column;
        while (iy < y1 && n < out.length) {
          const i = iy++ * width + ix;
          if (pixels[i] !== TRANSPARENT_U32) out[n++] = i;
        }
        if (iy >= y1) {
          iy = y0;
          column++;
        }
      }
      return n;
    },
  };
}

export const topToBottom = defineStrategy('top-to-bottom', 1, (image, _config, r) => rowCursor(image, r, false));
export const bottomToTop = defineStrategy('bottom-to-top', 1, (image, _config, r) => rowCursor(image, r, true));
export const leftToRight = defineStrategy('left-to-right', 1, (image, _config, r) => columnCursor(image, r, false));
export const rightToLeft = defineStrategy('right-to-left', 1, (image, _config, r) => columnCursor(image, r, true));
