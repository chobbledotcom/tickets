import { jsonResponse } from "#routes/response.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "86400",
};

/** JSON response with CORS headers */
export const apiResponse = (data: unknown, status = 200): Response => {
  const response = jsonResponse(data, status);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
};

/** CORS preflight response */
export const handleOptions = (): Response =>
  new Response(null, { headers: CORS_HEADERS, status: 204 });
