import { parseAcceptLanguage, runWithLocale } from "#i18n";
import { processRequest } from "#routes/app/request.ts";
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

/** Handle one request inside every request-scoped store. */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));
  const scopes: ((fn: () => Promise<Response>) => Promise<Response>)[] = [
    (fn) => runWithLocale(locale, fn),
    (fn) => runWithClientIp(getClientIp(request, server), fn),
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
    () => processRequest(request, server),
  )();
};
