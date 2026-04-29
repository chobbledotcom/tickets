/**
 * Health check route
 */

import { encodeBody } from "#routes/response.ts";

const HEALTH_RESPONSE = encodeBody(JSON.stringify({ status: "ok" }));

/**
 * Handle health check request - returns JSON status
 */
export const handleHealthCheck = (): Response =>
  new Response(HEALTH_RESPONSE, {
    headers: { "content-type": "application/json" },
  });
