/**
 * Request body buffering for the Bunny Edge runtime.
 */

/**
 * Read a body-bearing request's body into memory up front and return a fresh
 * Request backed by those bytes, so any later `request.text()` /
 * `request.formData()` reads from the buffer rather than the live edge body
 * resource.
 *
 * The Bunny Edge Scripting runtime can garbage-collect the underlying request
 * body resource during the awaits between a request arriving and its body being
 * read — loading listings, building the page context, signing a CSRF token —
 * after which reading the body throws
 * "BadResource: Cannot read body as underlying resource unavailable" (surfaced
 * in the log as a generic `E_CDN_REQUEST` "CDN request failed" error). The
 * booking/quote flow is the most exposed: `/calculate/:slug` and
 * `/ticket/:slug` parse their form body only after all of that async work, and
 * the running-total enhancement (`src/ui/client/admin/running-total.ts`) fires a
 * `POST /calculate` on every form change. Buffering the bytes before any of that
 * async work closes the window. This mirrors the same guard in
 * `src/features/api/webhooks.ts`, which reads its raw payload bytes first for the
 * identical reason.
 *
 * GET/HEAD requests carry no body and are returned unchanged.
 */
export const bufferRequestBody = async (request: Request): Promise<Request> => {
  if (request.method === "GET" || request.method === "HEAD") return request;
  const body = await request.arrayBuffer();
  return new Request(request.url, {
    body,
    headers: request.headers,
    method: request.method,
  });
};
