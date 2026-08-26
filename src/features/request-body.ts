/**
 * Request body buffering for the Bunny Edge runtime.
 */

/** A step that returns a request, possibly a fresh one backed by buffered bytes
 * (see `bufferRequestBody`). The shared shape of the request-buffering helpers. */
export type RequestTransform = (request: Request) => Promise<Request>;

/**
 * The Bunny Edge runtime can garbage-collect a request's body resource during
 * the awaits between the request arriving and its body being read. The read
 * then throws "BadResource: Cannot read body as underlying resource
 * unavailable", logged as a generic `E_CDN_REQUEST`.
 *
 * Buffering the bytes up front closes that window. The booking and quote flow
 * is the most exposed, because it reads its body only after that work.
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
