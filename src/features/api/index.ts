/**
 * Public JSON API routes
 *
 * Exposes listing listing, details, availability, and booking
 * with the same data and validation as the web UI.
 * The route handlers and helpers live in single-purpose modules beside this
 * one. This file only wires them into the route map.
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

/** The handlers each public API path serves. */
const endpoints = {
  "GET /api/listings": handleListListings,
  "GET /api/listings/:slug": handleGetListing,
  "GET /api/listings/:slug/availability": handleCheckAvailability,
  "GET /api/packages/:slug": handleGetPackage,
  "POST /api/listings/:slug/book": handleBook,
  "POST /api/packages/:slug/book": handleBookPackage,
} as const;

/** The CORS preflight route for every path the API serves. */
const preflightRoutes = Object.fromEntries(
  Object.keys(endpoints).map((key) => [
    `OPTIONS ${key.slice(key.indexOf(" ") + 1)}`,
    handleOptions,
  ]),
);

export const apiRoutes = defineRoutes({ ...endpoints, ...preflightRoutes });

export const routeApi = createRouter(apiRoutes);
