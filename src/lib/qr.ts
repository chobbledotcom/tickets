/**
 * QR code SVG generation utility
 * Wraps the qrcode npm package to produce inline SVG strings
 */

// deno-lint-ignore no-explicit-any
const QRCode: { toString(text: string, opts: { type: string; margin?: number }): Promise<string> } = (await import("qrcode" as string)).default as any;

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): Promise<string> =>
  QRCode.toString(text, { type: "svg", margin: 1 });
