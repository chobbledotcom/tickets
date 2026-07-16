import { parseAcceptLanguage, runWithLocale, withMessageGroups } from "#i18n";
import { SETUP_MESSAGE_GROUPS } from "#locales/groups.ts";
import { SessionKeyError } from "#routes/auth.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  getCleanUrl,
  isEmbeddablePath,
  isValidContentType,
  lowerContentType,
} from "#routes/middleware.ts";
import {
  emptyCustomCssResponse,
  isCssResponse,
} from "#routes/public/custom-css.ts";
import {
  bufferRequestBody,
  type RequestTransform,
} from "#routes/request-body.ts";
import {
  databaseBusyResponse,
  migrationInProgressResponse,
  redirectResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
  withCookie,
} from "#routes/response.ts";
import { routeLoaders } from "#routes/route-loaders.ts";
import { routeMainApp } from "#routes/route-prefixes.ts";
import { getPrefix, settingsForPath } from "#routes/settings-bundles.ts";
import { routeStatic } from "#routes/static.ts";
import type { PathMethodRoute, ServerContext } from "#routes/types.ts";
import { getClientIp, parseCookies, parseRequest } from "#routes/url.ts";
import { runWithClientIp } from "#shared/client-context.ts";
import {
  loadEffectiveDomain,
  seedEffectiveDomainHost,
} from "#shared/config.ts";
import {
  clearFlashCookie,
  clearSessionCookie,
  parseFlashValue,
} from "#shared/cookies.ts";
import { runWithCsrfContext } from "#shared/csrf.ts";
import { maybeBackfillActivityLog } from "#shared/db/activity-log-backfill.ts";
import { DatabaseBusyError } from "#shared/db/client.ts";
import {
  initDb,
  MigrationInProgressError,
  MissingSettingsTableError,
} from "#shared/db/migrations.ts";
import { maybeRunPrunes } from "#shared/db/prune.ts";
import {
  enableQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assertSettingsReadsDeclared,
  runWithSettingsAudit,
} from "#shared/db/settings-audit.ts";
import {
  hasFlash,
  runWithFlashContext,
  setFlashContext,
} from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { takeForm } from "#shared/form-stash.ts";
import {
  clearSavedFormData,
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms.tsx";
import { detectIframeMode, runWithIframeContext } from "#shared/iframe.ts";
import {
  createRequestTimer,
  ErrorCode,
  formatRequestError,
  logError,
  logRequest,
  runWithRequestId,
} from "#shared/logger.ts";
import { addPendingWork, flushPendingWork } from "#shared/pending-work.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { getRethrowErrors } from "#shared/test-overrides.ts";

const isSetupPath = (path: string): boolean =>
  path === "/setup" || path.startsWith("/setup/");

/** Initialize the database state needed by this path. */
const initializeDatabaseForPath = async (
  path: string,
): Promise<Response | null> => {
  try {
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

const BUFFERED_POST_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "application/json",
] as const;

/** Buffer body-bearing POSTs before the edge runtime can release their body. */
const bufferRequestIfNeeded: RequestTransform = async (request) => {
  if (request.method !== "POST") return request;
  const contentType = lowerContentType(request);
  const needsBuffer = BUFFERED_POST_CONTENT_TYPES.some((type) =>
    contentType.startsWith(type),
  );
  return needsBuffer ? bufferRequestBody(request) : request;
};

/** Redirect tracked GET URLs to a cacheable clean URL. */
const trackingParamRedirect = (url: URL, method: string): Response | null => {
  if (method !== "GET") return null;
  const cleanUrl = getCleanUrl(url);
  if (!cleanUrl) return null;
  return new Response(null, {
    headers: { location: cleanUrl },
    status: 301,
  });
};

/** Populate flash and saved-form context from the keyed flash cookie. */
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

/** Load settings and schedule per-request maintenance before routing. */
const prepareRequestEnvironment = async (
  url: URL,
  path: string,
  method: string,
): Promise<void> => {
  if (method === "GET" && getPrefix(path) === "admin") enableQueryLog();

  await settings.loadKeys(settingsForPath(path));

  if (!(method === "POST" && path === "/admin/privacy/orphans")) {
    addPendingWork(maybeRunPrunes());
  }
  addPendingWork(maybeBackfillActivityLog());
  loadEffectiveDomain(url);
};

/** Route a request after database initialization and settings loading. */
const handleRequestInternal = async (
  ...[request, path, method, server]: Parameters<PathMethodRoute>
): Promise<Response> => {
  if (isSetupPath(path)) {
    const setupResponse = await withMessageGroups(
      SETUP_MESSAGE_GROUPS,
      async () => {
        const routeSetup = await routeLoaders.setup();
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

  return (await routeMainApp(request, path, method, server))!;
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

/** Route the request and attach security headers and flash cookie clearing. */
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

/** Convert a routing error into its public response. */
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
    return databaseBusyResponse(["GET", "HEAD"].includes(method));
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

const CUSTOM_CSS_PATH = "/custom.css";

const isRedirectResponse = (response: Response): boolean =>
  response.status >= 300 && response.status < 400;

/** Run the complete request pipeline inside the per-request contexts. */
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
      path === CUSTOM_CSS_PATH &&
        !isRedirectResponse(response) &&
        !isCssResponse(response)
        ? emptyCustomCssResponse()
        : response,
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

    const trackingRedirect = trackingParamRedirect(url, method);
    if (trackingRedirect) return finish(trackingRedirect);

    if (!isSetupPath(path)) settings.prefetchVersion();

    const notActivated = await initializeDatabaseForPath(path);
    if (notActivated) return finish(notActivated);

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
  } finally {
    await flushPendingWork();
  }
  return response;
};

/** Handle an incoming request with isolated per-request state. */
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
