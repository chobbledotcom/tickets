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

/** Turn a JSON responder into an error responder: the returned function wraps
 * a message in the shared `{ error: message }` envelope (400 unless told
 * otherwise), so every API error body is spelled in one place. */
const jsonError =
  (respond: (data: unknown, status?: number) => Response) =>
  (message: string, status = 400): Response =>
    respond({ error: message }, status);

/** JSON `{ error: message }` response with CORS headers */
export const apiError = jsonError(apiResponse);

/** JSON `{ error: message }` response for API endpoints (no CORS headers).
 * Lives here rather than in the CRUD API module so lightweight edge routes
 * (e.g. the SMS webhook) can build error envelopes without evaluating the
 * admin CRUD/auth import graph. */
export const apiErrorResponse = jsonError(jsonResponse);

/** CORS preflight response */
export const handleOptions = (): Response =>
  new Response(null, { headers: CORS_HEADERS, status: 204 });
