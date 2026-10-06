/**
 * Which request an error report belongs to.
 *
 * An error is reported from deep inside a request, long after the route and the
 * log-correlation id are out of reach. The request context records the trace
 * once at the boundary (see src/shared/request-context.ts). These helpers read
 * it for the report, and let a reader find the console lines that were printed
 * beside it.
 */

import { getRequestTrace, type RequestTrace } from "#shared/request-context.ts";

/**
 * Read one fact off the request being served. Undefined when none is, which is
 * what the reporter wants for a field it should leave off the report.
 */
const fromTrace =
  <T>(read: (trace: RequestTrace) => T) =>
  (): T | undefined => {
    const trace = getRequestTrace();
    return trace ? read(trace) : undefined;
  };

/**
 * The route name an error report is grouped under, or nothing outside one.
 * Reads like the request log line: `GET /admin/listings/[id]`.
 */
export const getTracedRoute: () => string | undefined = fromTrace(
  (trace) => `${trace.method} ${trace.route}`,
);

/**
 * The public URL an error report happened on, with every secret removed. The
 * query string is dropped whole, because it carries tokens on some routes.
 */
export const getTracedUrl: () => string | undefined = fromTrace(
  (trace) => `https://${trace.host}${trace.route}`,
);
