/**
 * Request-scoped client IP via AsyncLocalStorage.
 *
 * The IP is resolved once at the request boundary (where the server context is
 * available) and stashed here so deeper layers — e.g. API-key authentication,
 * which doesn't receive the server context — can rate-limit by IP without
 * threading it through every call.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const clientIpStore = new AsyncLocalStorage<string>();

/** Run a function with the given client IP bound to the current request scope. */
export const runWithClientIp = <T>(ip: string, fn: () => T): T =>
  clientIpStore.run(ip, fn);

/** The current request's client IP, or "direct" when not in a request scope. */
export const getRequestClientIp = (): string =>
  clientIpStore.getStore() ?? "direct";
