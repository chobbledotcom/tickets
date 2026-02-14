/**
 * QR code SVG generation utility
 * Wraps the qrcode npm package to produce inline SVG strings
 */

import QRCodeDefault from "qrcode";

/** QR code module shape (subset of the qrcode npm package API) */
type QRCodeModule = { toString(text: string, opts: { type: string; margin?: number }): Promise<string> };

const QRCode: QRCodeModule = QRCodeDefault;

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): Promise<string> =>
  QRCode.toString(text, { type: "svg", margin: 1 });
