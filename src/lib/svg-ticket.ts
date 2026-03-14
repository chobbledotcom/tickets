/**
 * SVG ticket generator
 * Composes a QR code SVG with event and booking data into a standalone SVG ticket
 * suitable for email attachment. Contains no PII — only event details and booking metadata.
 */

import { formatCurrency } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { escapeHtml } from "#templates/layout.tsx";

/** Non-PII ticket data for SVG rendering */
export type SvgTicketData = {
  eventName: string;
  eventDate: string;
  eventLocation: string;
  attendeeDate: string | null;
  quantity: number;
  pricePaid: string;
  currency: string;
  checkinUrl: string;
};

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
  if (!match) return { width: QR_SIZE, height: QR_SIZE };
  const parts = match[1]!.split(/\s+/).map(Number);
  return { width: parts[2] ?? QR_SIZE, height: parts[3] ?? QR_SIZE };
};

/** Build info lines from ticket data (non-PII event and booking details) */
export const buildInfoLines = (data: SvgTicketData): string[] => {
  const lines: string[] = [];

  if (data.eventDate) {
    lines.push(formatDatetimeLabel(data.eventDate));
  }

  if (data.eventLocation) {
    lines.push(data.eventLocation);
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
 * Generate a standalone SVG ticket with QR code and event/booking details.
 * Returns a complete SVG document string.
 */
export const generateSvgTicket = async (
  data: SvgTicketData,
): Promise<string> => {
  const qrSvg = await generateQrSvg(data.checkinUrl);
  const qrViewBox = extractViewBox(qrSvg);
  const qrContent = extractSvgContent(qrSvg);
  const scale = QR_SIZE / qrViewBox.width;

  const infoLines = buildInfoLines(data);
  const infoHeight = infoLines.length * LINE_HEIGHT;

  const qrY = HEADER_Y + infoHeight + 16;
  const totalHeight = qrY + QR_SIZE + MARGIN;
  const qrX = (WIDTH - QR_SIZE) / 2;

  const escapedName = escapeHtml(data.eventName);
  const linesSvg = infoLines.map((line, i) =>
    `<text x="${MARGIN}" y="${
      HEADER_Y + (i + 1) * LINE_HEIGHT
    }" font-family="sans-serif" font-size="13" fill="#555">${
      escapeHtml(line)
    }</text>`
  ).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}" viewBox="0 0 ${WIDTH} ${totalHeight}">
  <rect width="${WIDTH}" height="${totalHeight}" rx="8" fill="#fff" stroke="#ddd" stroke-width="1"/>
  <text x="${MARGIN}" y="${HEADER_Y}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#333">${escapedName}</text>
    ${linesSvg}
  <g transform="translate(${qrX}, ${qrY}) scale(${scale})">
    ${qrContent}
  </g>
</svg>`;
};
