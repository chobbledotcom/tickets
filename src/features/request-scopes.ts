import { parseAcceptLanguage } from "#i18n";
import { runWithRequestContext } from "#shared/request-context.ts";
import { runWithSubrequestBudget } from "#shared/subrequest-budget.ts";

/**
 * Run one response builder inside the one request context. The context carries
 * the facts the request sets once. Every per-request store (cache, query log,
 * settings audit, flash, session, CSRF token, saved form, footer marker) is a
 * slot on it. The subrequest budget wraps the context: queued pending work
 * flushes as the context unwinds, and the wrap keeps that flush inside the
 * request's allowance.
 */
export const runWithRequestScopes = (
  request: Request,
  clientIp: string,
  fn: () => Promise<Response>,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));
  return runWithSubrequestBudget(async () =>
    runWithRequestContext(request, { clientIp, locale }, fn),
  );
};

type RequestHandler = (request: Request) => Promise<Response>;

export const requestScopedHandler =
  (handler: RequestHandler) =>
  // An in-process call has no connection, so it records the client IP "direct".
  (request: Request, clientIp = "direct"): Promise<Response> =>
    runWithRequestScopes(request, clientIp, () => handler(request));
