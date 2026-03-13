/**
 * QR code SVG generation utility
 * Wraps the qrcode npm package to produce inline SVG strings
 */

import { once } from "#fp";

/** QR code module shape (subset of the qrcode npm package API) */
type QRCodeModule = {
  toString(
    text: string,
    opts: { type: string; margin?: number },
  ): Promise<string>;
};

const loadQRCode = once(async (): Promise<QRCodeModule> => {
  const { default: QRCode } = await import("qrcode");
  return QRCode;
});

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = async (text: string): Promise<string> => {
  const QRCode = await loadQRCode();
  return QRCode.toString(text, { type: "svg", margin: 1 });
};
