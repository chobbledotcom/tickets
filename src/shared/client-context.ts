/**
 * Request-scoped client IP.
 *
 * The IP is resolved once at the request boundary (where the server context is
 * available) and stashed here so deeper layers — e.g. API-key authentication,
 * which doesn't receive the server context — can rate-limit by IP without
 * threading it through every call.
 */

import { createScopedValue } from "#shared/request-scoped.ts";

const clientIp = createScopedValue(() => "direct");

/** Run a function with the given client IP bound to the current request scope. */
export const runWithClientIp = <T>(ip: string, fn: () => T): T =>
  clientIp.run(ip, fn);

/** The current request's client IP, or "direct" when not in a request scope. */
export const getRequestClientIp = (): string => clientIp.read();
