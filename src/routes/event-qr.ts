/**
 * Public event QR code route
 * Generates a QR code SVG for an event's public registration URL
 */

import { getAllowedDomain } from "#lib/config.ts";
import { getEvent } from "#lib/db/events.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Return an SVG response with correct content type */
const svgResponse = (svg: string): Response =>
  new Response(svg, {
    headers: { "content-type": "image/svg+xml" },
  });

/** Handle GET /event/:id/qr */
export const handleEventQrGet = async (
  _request: Request,
  { id }: { id: number },
): Promise<Response> => {
  const event = await getEvent(id);
  if (!event) return notFoundResponse();

  const ticketUrl = `https://${getAllowedDomain()}/ticket/${event.slug}`;
  const svg = await generateQrSvg(ticketUrl);
  return svgResponse(svg);
};

/** Event QR routes */
const eventQrRoutes = defineRoutes({
  "GET /event/:id/qr": handleEventQrGet,
});

/** Route event QR requests */
export const routeEventQr = createRouter(eventQrRoutes);
