/**
 * QR code SVG generation utility
 * Uses uqr (zero-dep, ESM, ~4KB)
 */

import { renderSVG } from "uqr";

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): string =>
  renderSVG(text, { border: 1 });
