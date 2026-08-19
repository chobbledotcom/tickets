/* jscpd:ignore-start -- imports */

import { DatabaseBusyError } from "#db/client.ts";
import {
  MigrationInProgressError,
  MissingSettingsTableError,
} from "#db/migrations/errors.ts";
import { enableQueryLog } from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { assertSettingsReadsDeclared } from "#db/settings-audit.ts";
import { once } from "#fp";
import { withMessageGroups } from "#i18n";
import { SETUP_MESSAGE_GROUPS } from "#locales/groups.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  isEmbeddablePath,
  isValidContentType,
} from "#routes/middleware.ts";
import { requestScopedHandler } from "#routes/request-scopes.ts";
import {
  databaseBusyResponse,
  migrationInProgressResponse,
  redirectResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
  withCookie,
} from "#routes/response.ts";
import { getPrefix, settingsForPath } from "#routes/settings-bundles.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { parseCookies, parseRequest } from "#routes/url.ts";
import {
  loadEffectiveDomain,
  seedEffectiveDomainHost,
} from "#shared/config.ts";
import {
  clearFlashCookie,
  clearSessionCookie,
  parseFlashValue,
} from "#shared/cookies.ts";
import { hasFlash, setFlashContext } from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { takeForm } from "#shared/form-stash.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import {
  createRequestTimer,
  ErrorCode,
  formatRequestError,
  logError,
  logRequest,
} from "#shared/logger.ts";
import { reportMaintenanceFailure } from "#shared/maintenance/report.ts";
import { SessionKeyError } from "#shared/session-private-key.ts";
import { getRethrowErrors } from "#shared/test-overrides.ts";
import { defineAppRoute, routeMainApp } from "./routes.ts";
import {
  bufferRequestIfNeeded,
  ensureCustomCssResponse,
  isSetupPath,
  runOrganicMaintenanceWhenDue,
  shouldLogQueries,
  shouldPrefetchSettings,
  shouldRetryBusyRequest,
  trackingRedirectLocation,
} from "./rules.ts";

/* jscpd:ignore-end */

const loadSetupRoutes = once(async () =>
  (await import("#routes/setup.ts")).createSetupRouter(
    settings.setup.isComplete,
  ),
);

const handleRequestInternal = defineAppRoute(
  async ({ request, path, method, server }) => {
    if (isSetupPath(path)) {
      const setupResponse = await withMessageGroups(
        SETUP_MESSAGE_GROUPS,
        async () => {
          const routeSetup = await loadSetupRoutes();
          return await routeSetup(request, path, method);
        },
      );
      if (setupResponse) return setupResponse;
    }

    if (!(await settings.setup.isComplete())) {
      return isSetupPath(path)
        ? redirectResponse("/setup")
        : siteNotActivatedResponse();
    }

    return routeMainApp({ method, path, request, server });
  },
);

const initializeDatabaseForPath = async (
  path: string,
): Promise<Response | null> => {
  try {
    const { initDb } = await import("#db/migrations.ts");
    await initDb({ allowMissingSettings: isSetupPath(path) });
    return null;
  } catch (error) {
    if (error instanceof MissingSettingsTableError) {
      return siteNotActivatedResponse();
    }
    if (error instanceof MigrationInProgressError) {
      return migrationInProgressResponse();
    }
    throw error;
  }
};

const logAndReturn = (
  response: Response,
  method: string,
  path: string,
  getElapsed: () => number,
): Response => {
  logRequest({
    durationMs: getElapsed(),
    method,
    path,
    status: response.status,
  });
  return response;
};

const applyFlashFromCookie = (request: Request, url: URL): string | null => {
  const flashId = url.searchParams.get("flash");
  const flashRaw = flashId
    ? parseCookies(request).get(`flash_${flashId}`)
    : null;
  const flash = flashRaw ? parseFlashValue(flashRaw) : null;
  if (flash) setFlashContext(flash);

  if (flash?.formToken) {
    const stashed = takeForm(flash.formToken);
    if (stashed) setSavedFormData(new FormParams(stashed));
  }
  return flash ? flashId : null;
};

const prepareRequestEnvironment = async (
  url: URL,
  path: string,
  method: string,
): Promise<void> => {
  if (shouldLogQueries(method, getPrefix(path))) enableQueryLog();

  await settings.loadKeys(settingsForPath(path));

  loadEffectiveDomain(url);
};

const runOrganicMaintenanceAfterResponse = (
  method: string,
  path: string,
  response: Response,
): Promise<void> =>
  runOrganicMaintenanceWhenDue(method, path, response.status, async () => {
    try {
      const [{ MAINTENANCE_TASKS }, { maintenance }] = await Promise.all([
        import("#shared/maintenance/registry.ts"),
        import("#shared/maintenance/runner.ts"),
      ]);
      await maintenance.runOrganic(MAINTENANCE_TASKS);
    } catch (error) {
      reportMaintenanceFailure("organic maintenance failed", error);
    }
  });

const routeAndFinalize = async (
  request: Request,
  url: URL,
  path: string,
  method: string,
  server: ServerContext | undefined,
): Promise<Response> => {
  const embeddable = isEmbeddablePath(path);
  const consumedFlashId = applyFlashFromCookie(request, url);
  const response = await handleRequestInternal(request, path, method, server);

  if (consumedFlashId && hasFlash()) {
    withCookie(response, clearFlashCookie(consumedFlashId));
  }
  return applySecurityHeaders(response, embeddable);
};

const handleRoutingError = (
  error: unknown,
  method: string,
  path: string,
): Response => {
  if (error instanceof DatabaseBusyError) {
    logError({
      code: ErrorCode.DB_BUSY,
      detail: formatRequestError(method, path, error),
      error,
    });
    return databaseBusyResponse(shouldRetryBusyRequest(method));
  }

  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: formatRequestError(method, path, error),
    error,
  });
  if (
    getRethrowErrors() &&
    !(error instanceof SessionKeyError) &&
    !Deno.env.get("TEST_EXPECT_ERROR")
  ) {
    throw error;
  }
  if (error instanceof SessionKeyError) {
    return redirectResponse("/admin", clearSessionCookie());
  }
  return temporaryErrorResponse();
};

/** Run the application request pipeline. */
const processRequest = async (
  request: Request,
  server: ServerContext | undefined,
): Promise<Response> => {
  const { url, path, method } = parseRequest(request);
  const getElapsed = createRequestTimer();
  detectIframeMode(url);
  clearSavedFormData();

  const finish = (response: Response): Response =>
    logAndReturn(
      ensureCustomCssResponse(path, response),
      method,
      path,
      getElapsed,
    );

  let response!: Response;
  try {
    const bufferedRequest = await bufferRequestIfNeeded(request);

    const staticResponse = await routeStatic(bufferedRequest, path, method);
    if (staticResponse) {
      return finish(
        await applySecurityHeaders(staticResponse, isEmbeddablePath(path)),
      );
    }

    seedEffectiveDomainHost(url);

    const cleanLocation = trackingRedirectLocation(url, method);
    if (cleanLocation) {
      return finish(
        new Response(null, {
          headers: { location: cleanLocation },
          status: 301,
        }),
      );
    }

    if (shouldPrefetchSettings(path)) settings.prefetchVersion();

    const unavailable = await initializeDatabaseForPath(path);
    if (unavailable) return finish(unavailable);

    await prepareRequestEnvironment(url, path, method);

    if (!isValidContentType(bufferedRequest, path)) {
      return finish(contentTypeRejectionResponse());
    }

    response = finish(
      await routeAndFinalize(bufferedRequest, url, path, method, server),
    );
    assertSettingsReadsDeclared(`${method} ${path}`);
  } catch (error) {
    response = finish(handleRoutingError(error, method, path));
  }
  await runOrganicMaintenanceAfterResponse(method, path, response);
  return response;
};

/** Handle one request inside every request-scoped store. */
export const handleRequest = requestScopedHandler(processRequest);
