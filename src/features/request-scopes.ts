import { parseAcceptLanguage, runWithLocale } from "#i18n";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp } from "#routes/url.ts";
import { runWithClientIp } from "#shared/client-context.ts";
import { runWithCsrfContext } from "#shared/csrf.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { runWithSettingsAudit } from "#shared/db/settings-audit.ts";
import { runWithFlashContext } from "#shared/flash-context.ts";
import { runWithSavedFormContext } from "#shared/forms/saved-data.ts";
import { runWithIframeContext } from "#shared/iframe.ts";
import { runWithRequestId } from "#shared/logger.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { runWithSubrequestBudget } from "#shared/subrequest-budget.ts";

/** Run one response builder inside every request-scoped store. */
export const runWithRequestScopes = (
  request: Request,
  server: ServerContext | undefined,
  fn: () => Promise<Response>,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));
  const scopes: ((next: () => Promise<Response>) => Promise<Response>)[] = [
    (next) => runWithLocale(locale, next),
    (next) => runWithClientIp(getClientIp(request, server), next),
    runWithSubrequestBudget,
    runWithRequestId,
    runWithRequestCache,
    runWithQueryLogContext,
    runWithFlashContext,
    runWithSessionContext,
    runWithIframeContext,
    runWithCsrfContext,
    runWithSavedFormContext,
    runWithSettingsAudit,
  ];

  return scopes.reduceRight<() => Promise<Response>>(
    (next, scope) => () => scope(next),
    fn,
  )();
};

type RequestHandler = (
  request: Request,
  server?: ServerContext,
) => Promise<Response>;

export const requestScopedHandler =
  (handler: RequestHandler): RequestHandler =>
  (request, server) =>
    runWithRequestScopes(request, server, () => handler(request, server));
