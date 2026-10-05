import { parseAcceptLanguage } from "#i18n";
import { runWithCsrfContext } from "#shared/csrf.ts";
import { runWithFlashContext } from "#shared/flash-context.ts";
import { runWithSavedFormContext } from "#shared/forms/saved-data.ts";
import { runWithRequestContext } from "#shared/request-context.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { runWithSubrequestBudget } from "#shared/subrequest-budget.ts";
import { runWithAdminFooterContext } from "#templates/admin/footer.tsx";

/**
 * Run one response builder inside every request-scoped store. The one request
 * context carries the facts the request sets once. The scopes below it still
 * hold their own stores until their layers land. The subrequest budget wraps
 * the context. Queued pending work flushes as the context unwinds, and the
 * wrap keeps that flush inside the request's allowance.
 */
export const runWithRequestScopes = (
  request: Request,
  clientIp: string,
  fn: () => Promise<Response>,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));
  const scopes: ((next: () => Promise<Response>) => Promise<Response>)[] = [
    runWithFlashContext,
    runWithSessionContext,
    runWithCsrfContext,
    runWithSavedFormContext,
    runWithAdminFooterContext,
  ];

  return runWithSubrequestBudget(async () =>
    runWithRequestContext(request, { clientIp, locale }, () =>
      scopes.reduceRight<() => Promise<Response>>(
        (next, scope) => () => scope(next),
        fn,
      )(),
    ),
  );
};

type RequestHandler = (request: Request) => Promise<Response>;

export const requestScopedHandler =
  (handler: RequestHandler) =>
  // An in-process call has no connection, so it records the client IP "direct".
  (request: Request, clientIp = "direct"): Promise<Response> =>
    runWithRequestScopes(request, clientIp, () => handler(request));
