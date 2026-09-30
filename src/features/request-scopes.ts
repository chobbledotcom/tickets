import { runWithQueryLogContext } from "#db/query-log.ts";
import { runWithSettingsAudit } from "#db/settings-audit.ts";
import { parseAcceptLanguage, runWithLocale } from "#i18n";
import { runWithClientIp } from "#shared/client-context.ts";
import { runWithCsrfContext } from "#shared/csrf.ts";
import { runWithFlashContext } from "#shared/flash-context.ts";
import { runWithSavedFormContext } from "#shared/forms/saved-data.ts";
import { runWithIframeContext } from "#shared/iframe.ts";
import { runWithRequestId } from "#shared/logger.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { runWithRequestTrace } from "#shared/request-trace.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { runWithSubrequestBudget } from "#shared/subrequest-budget.ts";
import { runWithAdminFooterContext } from "#templates/admin/footer.tsx";

/** Run one response builder inside every request-scoped store. An in-process
 * call has no connection, so it records the client IP `direct`. */
export const runWithRequestScopes = (
  request: Request,
  clientIp: string | undefined,
  fn: () => Promise<Response>,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));
  const scopes: ((next: () => Promise<Response>) => Promise<Response>)[] = [
    (next) => runWithLocale(locale, next),
    (next) => runWithClientIp(clientIp ?? "direct", next),
    runWithSubrequestBudget,
    runWithRequestId,
    (next) => runWithRequestTrace(request, next),
    runWithRequestCache,
    runWithQueryLogContext,
    runWithFlashContext,
    runWithSessionContext,
    runWithIframeContext,
    runWithCsrfContext,
    runWithSavedFormContext,
    runWithSettingsAudit,
    runWithAdminFooterContext,
  ];

  return scopes.reduceRight<() => Promise<Response>>(
    (next, scope) => () => scope(next),
    fn,
  )();
};

type RequestHandler = (request: Request) => Promise<Response>;

export const requestScopedHandler =
  (handler: RequestHandler) =>
  (request: Request, clientIp?: string): Promise<Response> =>
    runWithRequestScopes(request, clientIp, () => handler(request));
