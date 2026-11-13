/**
 * SVG ticket generator
 * Composes a QR code SVG with listing and booking data into a standalone SVG ticket.
 * The ticket goes in an email body or an email attachment. It contains no PII: only
 * listing details and booking metadata.
 */

import { escapeHtml } from "#jsx/escape-html.ts";
import type { WalletPassData } from "#routes/tickets/token-utils.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import { generateQrSvg } from "#shared/qr.ts";

/** Non-PII ticket data for the SVG, with its values already formatted. */
export type SvgTicketData = Pick<
  WalletPassData,
  | "listingName"
  | "listingDate"
  | "listingLocation"
  | "attendeeDate"
  | "quantity"
  | "checkinUrl"
> & { pricePaid: string; currency: string; purchaseOnly?: boolean };

/** SVG dimensions */
const WIDTH = 400;
const HEADER_Y = 40;
const LINE_HEIGHT = 22;
const QR_SIZE = 180;
const MARGIN = 24;

/** Extract the inner content of an SVG element (strip the outer <svg> wrapper) */
export const extractSvgContent = (svg: string): string => {
  const innerMatch = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  return innerMatch?.[1] ?? "";
};

/** Extract the viewBox from an SVG element to compute its coordinate space */
export const extractViewBox = (
  svg: string,
): { width: number; height: number } => {
  const match = svg.match(/viewBox="([^"]+)"/);
  if (!match) return { height: QR_SIZE, width: QR_SIZE };
  const parts = match[1]!.split(/\s+/).map(Number);
  return { height: parts[3] ?? QR_SIZE, width: parts[2] ?? QR_SIZE };
};

/** Build info lines from ticket data (non-PII listing and booking details) */
export const buildInfoLines = (data: SvgTicketData): string[] => {
  const lines: string[] = [];

  if (data.listingDate) {
    lines.push(formatDatetimeLabel(data.listingDate));
  }

  if (data.listingLocation) {
    lines.push(data.listingLocation);
  }

  if (data.attendeeDate) {
    lines.push(`Booking: ${formatDateLabel(data.attendeeDate)}`);
  }

  lines.push(`Qty: ${data.quantity}`);

  const price = Number(data.pricePaid);
  if (price > 0) {
    lines.push(`Price: ${formatCurrency(price)}`);
  }

  return lines;
};

/**
 * Generate a standalone SVG ticket with QR code and listing/booking details.
 * Returns a complete SVG document string.
 */
export const generateSvgTicket = async (
  data: SvgTicketData,
): Promise<string> => {
  const infoLines = buildInfoLines(data);
  const infoHeight = infoLines.length * LINE_HEIGHT;
  const escapedName = escapeHtml(data.listingName);
  const linesSvg = infoLines
    .map(
      (line, i) =>
        `<text x="${MARGIN}" y="${
          HEADER_Y + (i + 1) * LINE_HEIGHT
        }" font-family="sans-serif" font-size="13" fill="#555">${escapeHtml(
          line,
        )}</text>`,
    )
    .join("\n    ");

  let qrSection = "";
  let totalHeight = HEADER_Y + infoHeight + MARGIN;

  if (!data.purchaseOnly) {
    const qrSvg = await generateQrSvg(data.checkinUrl);
    const qrViewBox = extractViewBox(qrSvg);
    const qrContent = extractSvgContent(qrSvg);
    const scale = QR_SIZE / qrViewBox.width;
    const qrY = HEADER_Y + infoHeight + 16;
    const qrX = (WIDTH - QR_SIZE) / 2;
    totalHeight = qrY + QR_SIZE + MARGIN;
    qrSection = `\n  <g transform="translate(${qrX}, ${qrY}) scale(${scale})">\n    ${qrContent}\n  </g>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}" viewBox="0 0 ${WIDTH} ${totalHeight}">
  <rect width="${WIDTH}" height="${totalHeight}" rx="8" fill="#fff" stroke="#ddd" stroke-width="1"/>
  <text x="${MARGIN}" y="${HEADER_Y}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#333">${escapedName}</text>
    ${linesSvg}${qrSection}
</svg>`;
};

/** An XML declaration is valid only at the start of a document. */
const XML_DECLARATION = /^<\?xml[^>]*\?>\s*/;

/** A body copy must fit the reader's screen. The attached file keeps the
 * document sizes, so the style belongs to the body copy alone. */
const BODY_SVG_STYLE = "display:block;max-width:100%;height:auto";

/** Turn a generated ticket SVG into its HTML body copy. */
const bodySvgCopy = (svg: string): string => {
  const copy = svg.replace(XML_DECLARATION, "");
  if (!copy.startsWith("<svg ")) {
    throw new Error("Ticket SVG does not start with an <svg> element");
  }
  return copy.replace("<svg ", `<svg style="${BODY_SVG_STYLE}" `);
};

/** Wrap a generated ticket SVG as a block for an HTML email body. */
export const ticketSvgBlock = (svg: string): string =>
  `<div style="margin:24px 0;max-width:${WIDTH}px">${bodySvgCopy(svg)}</div>`;
