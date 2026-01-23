/**
 * Health check route
 */

import { staticGetRoute } from "./utils.ts";

/**
 * Handle health check request
 */
export const handleHealthCheck = staticGetRoute(
  JSON.stringify({ status: "ok" }),
  "application/json",
);
