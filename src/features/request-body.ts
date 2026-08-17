/**
 * Request body buffering for the Bunny Edge runtime.
 */

/** A step that returns a request, possibly a fresh one backed by buffered bytes
 * (see `bufferRequestBody`). The shared shape of the request-buffering helpers. */
export type RequestTransform = (request: Request) => Promise<Request>;

/**
 * Read a body-bearing request's body into memory up front and return a fresh
 * Request backed by those bytes, so any later `request.text()` /
 * `request.formData()` reads from the buffer rather than the live edge body
 * resource.
 *
 * The Bunny Edge runtime can garbage-collect the body resource during the
 * awaits between a request arriving and its body being read, after which
 * reading throws "BadResource: Cannot read body as underlying resource
 * unavailable" (logged as a generic `E_CDN_REQUEST`). The booking and quote
 * flow is the most exposed: `/calculate/:slug` and `/ticket/:slug` read their
 * body only after that work, and the running total posts to `/calculate` on
 * every form change. Buffering first closes the window, as `api/webhooks.ts`
 * does for the same reason.
 *
 * GET and HEAD carry no body and are returned unchanged.
 */
export const bufferRequestBody: RequestTransform = async (request) => {
  if (request.method === "GET" || request.method === "HEAD") return request;
  const body = await request.arrayBuffer();
  return new Request(request.url, {
    body,
    headers: request.headers,
    method: request.method,
  });
};
