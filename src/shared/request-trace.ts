/**
 * Which request an error report belongs to.
 *
 * An error is reported from deep inside a request, long after the route and the
 * log-correlation id are out of reach. Recording them once at the request
 * boundary lets the report name the route it happened on, and lets a reader
 * find the console lines that were printed beside it.
 */

import { redactPath } from "#shared/redact-path.ts";
import { createScopedValue } from "#shared/request-scoped.ts";

/** The safe-to-report identity of one request. */
export type RequestTrace = {
  /** The public host the visitor asked for. */
  host: string;
  method: string;
  /** The path with its secrets removed. Names the route, never the person. */
  route: string;
};

const requestTrace = createScopedValue<RequestTrace | null>(() => null);

/** Record the request being served, for as long as it is being served. */
export const runWithRequestTrace = <T>(request: Request, fn: () => T): T => {
  const url = new URL(request.url);
  return requestTrace.run(
    { host: url.host, method: request.method, route: redactPath(url.pathname) },
    fn,
  );
};

/** The request being served, or null when nothing is being served. */
export const getRequestTrace = (): RequestTrace | null => requestTrace.read();

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
