/**
 * Health check route
 */

const HEALTH_RESPONSE = JSON.stringify({ status: "ok" });

/**
 * Handle health check request - returns JSON status
 */
export const handleHealthCheck = (): Response =>
  new Response(HEALTH_RESPONSE, {
    headers: { "content-type": "application/json" },
  });
