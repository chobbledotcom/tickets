/**
 * SVG ticket generator
 * Composes a QR code SVG with listing and booking data into a standalone SVG ticket.
 * The email attaches the SVG file and shows a block with the facts and a QR
 * PNG. The ticket contains no PII: only listing details and booking metadata.
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

/** The ticket block in the buyer's HTML email. A mail reader that cannot draw
 * SVG (Gmail, Outlook, Yahoo) shows the QR picture in the block instead. */
export const ticketBodyBlock = (
  data: SvgTicketData,
  qrContentId: string | null,
): string => {
  const info = buildInfoLines(data)
    .map(
      (line) =>
        `<p style="margin:4px 0;font-size:13px;color:#555">${escapeHtml(line)}</p>`,
    )
    .join("");
  const qr =
    qrContentId === null
      ? ""
      : `<img src="cid:${qrContentId}" alt="Ticket QR code" style="display:block;margin:16px auto 0;max-width:100%;height:auto">`;
  return `<div style="margin:24px 0;max-width:${WIDTH}px;border:1px solid #ddd;border-radius:8px;padding:16px"><p style="margin:0 0 8px;font-size:18px;font-weight:bold;color:#333">${escapeHtml(data.listingName)}</p>${info}${qr}</div>`;
};
