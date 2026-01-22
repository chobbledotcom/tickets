/**
 * Health check route
 */

/**
 * Handle health check request
 */
export const handleHealthCheck = (method: string): Response | null => {
  if (method !== "GET") return null;
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "content-type": "application/json" },
  });
};
