/**
 * QR code SVG generation utility
 * Uses uqr (zero-dep, ESM, ~4KB) with a minimal SVG renderer
 */

import { encode } from "uqr";

const renderSvg = (matrix: boolean[][], margin: number): string => {
  const size = matrix.length + margin * 2;
  const paths: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y]!.length; x++) {
      if (matrix[y]![x]) paths.push(`M${x + margin},${y + margin}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#ffffff" d="M0,0h${size}v${size}H0z"/><path fill="#000000" d="${paths.join("")}"/></svg>\n`;
};

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): string => {
  const { data } = encode(text);
  return renderSvg(data, 1);
};
