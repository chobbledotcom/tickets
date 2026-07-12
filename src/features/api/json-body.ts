/** Reads a request's body into a plain record, or returns a failure Response
 * when the body is missing or malformed. Both the cookie-auth JSON parser and
 * the public API JSON parser answer this one shape, so they spell it once. */
export type JsonBodyReader = (
  request: Request,
) => Promise<Record<string, unknown> | Response>;
