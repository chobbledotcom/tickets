/**
 * Public JSON API routes
 *
 * Exposes listing listing, details, availability, and booking
 * with the same data and validation as the web UI.
 * The route handlers and helpers live in single-purpose modules beside this
 * one; this file only wires them into the route map.
 */

import { handleBook } from "#routes/api/booking.ts";
import { handleOptions } from "#routes/api/cors.ts";
import {
  handleCheckAvailability,
  handleGetListing,
  handleListListings,
} from "#routes/api/listings.ts";
import { handleBookPackage, handleGetPackage } from "#routes/api/packages.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";

export const apiRoutes = defineRoutes({
  "GET /api/listings": handleListListings,
  "GET /api/listings/:slug": handleGetListing,
  "GET /api/listings/:slug/availability": handleCheckAvailability,
  "GET /api/packages/:slug": handleGetPackage,
  "OPTIONS /api/listings": handleOptions,
  "OPTIONS /api/listings/:slug": handleOptions,
  "OPTIONS /api/listings/:slug/availability": handleOptions,
  "OPTIONS /api/listings/:slug/book": handleOptions,
  "OPTIONS /api/packages/:slug": handleOptions,
  "OPTIONS /api/packages/:slug/book": handleOptions,
  "POST /api/listings/:slug/book": handleBook,
  "POST /api/packages/:slug/book": handleBookPackage,
});

export const routeApi = createRouter(apiRoutes);
