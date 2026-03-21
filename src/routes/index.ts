/**
 * Routes module - main exports and router
 * Uses lazy loading to minimize startup time for edge scripts
 */

import { once } from "#fp";
import { isSetupComplete } from "#lib/config.ts";
import {
  clearFlashCookie,
  clearSessionCookie,
  parseFlashValue,
} from "#lib/cookies.ts";
import { loadCurrencyCode } from "#lib/currency.ts";
import { runWithQueryLogContext } from "#lib/db/query-log.ts";
import { getShowPublicApiFromDb } from "#lib/db/settings.ts";
import {
  hasFlash,
  resetFlashContext,
  setFlashContext,
} from "#lib/flash-context.ts";
import { loadHeaderImage } from "#lib/header-image.ts";
import { detectIframeMode } from "#lib/iframe.ts";
import {
  createRequestTimer,
  ErrorCode,
  formatRequestError,
  logDebug,
  logError,
  logRequest,
  runWithRequestId,
} from "#lib/logger.ts";
import { flushPendingWork } from "#lib/pending-work.ts";
import { runWithSessionContext } from "#lib/session-context.ts";
import { loadTheme } from "#lib/theme.ts";
import {
  applySecurityHeaders,
  buildDomainRedirectUrl,
  contentTypeRejectionResponse,
  domainRedirectResponse,
  getCleanUrl,
  getDomainRejectionReason,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
  isWebhookPath,
} from "#routes/middleware.ts";
import { createRouter } from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import {
  notFoundResponse,
  parseCookies,
  parseRequest,
  redirectResponse,
  SessionKeyError,
  temporaryErrorResponse,
  withCookie,
} from "#routes/utils.ts";

/** Router function type - reuse from router.ts */
type RouterFn = ReturnType<typeof createRouter>;

/** Lazy-load admin routes (only needed for authenticated admin requests) */
const loadAdminRoutes = once(async () => {
  const { routeAdmin } = await import("#routes/admin/index.ts");
  return routeAdmin;
});

/** Lazy-load public page handlers (home, events, terms, contact) */
const loadPublicPages = once(async () => {
  const {
    handleHome,
    handlePublicEvents,
    handlePublicTerms,
    handlePublicContact,
  } = await import("#routes/public.ts");
  return {
    handleHome,
    handlePublicEvents,
    handlePublicTerms,
    handlePublicContact,
  };
});

/** Lazy-load ticket reservation router */
const loadTicketRoutes = once(async () => {
  const { routeTicket } = await import("#routes/public.ts");
  return routeTicket;
});

/** Lazy-load setup routes */
const loadSetupRoutes = once(async () => {
  const { createSetupRouter } = await import("#routes/setup.ts");
  return createSetupRouter(isSetupComplete);
});

/** Lazy-load payment/webhook routes */
const loadPaymentRoutes = once(async () => {
  const { routePayment } = await import("#routes/webhooks.ts");
  return routePayment;
});

/** Lazy-load join/invite routes */
const loadJoinRoutes = once(async () => {
  const { routeJoin } = await import("#routes/join.ts");
  return routeJoin;
});

/** Lazy-load ticket view routes */
const loadTicketViewRoutes = once(async () => {
  const { routeTicketView } = await import("#routes/tickets.ts");
  return routeTicketView;
});

/** Lazy-load check-in routes */
const loadCheckinRoutes = once(async () => {
  const { routeCheckin } = await import("#routes/checkin.ts");
  return routeCheckin;
});

/** Lazy-load image proxy routes */
const loadImageRoutes = once(async () => {
  const { routeImage } = await import("#routes/images.ts");
  return routeImage;
});

/** Lazy-load feed routes (ICS, RSS) */
const loadFeedRoutes = once(async () => {
  const { routeFeed } = await import("#routes/feeds.ts");
  return routeFeed;
});

/** Lazy-load demo reset routes */
const loadDemoResetRoutes = once(async () => {
  const { routeDatabaseReset } = await import(
    "#routes/admin/database-reset.ts"
  );
  return routeDatabaseReset;
});

/** Lazy-load attachment download routes */
const loadAttachmentRoutes = once(async () => {
  const { attachmentRoutes } = await import("#routes/attachments.ts");
  return createRouter(attachmentRoutes);
});

/** Lazy-load Apple Wallet pass routes */
const loadWalletRoutes = once(async () => {
  const { routeWallet } = await import("#routes/wallet.ts");
  return routeWallet;
});

/** Lazy-load Google Wallet pass routes */
const loadGoogleWalletRoutes = once(async () => {
  const { routeGoogleWallet } = await import("#routes/google-wallet.ts");
  return routeGoogleWallet;
});

/** Lazy-load Apple Wallet web service routes (v1 API for pass updates) */
const loadWalletWebserviceRoutes = once(async () => {
  const { routeWalletWebservice } = await import(
    "#routes/wallet-webservice.ts"
  );
  return routeWalletWebservice;
});

/** Lazy-load public API routes */
const loadApiRoutes = once(async () => {
  const { routeApi } = await import("#routes/api.ts");
  return routeApi;
});

/** Lazy-load admin API routes */
const loadAdminApiRoutes = once(async () => {
  const { adminApiRoutes } = await import("#routes/admin/api.ts");
  return createRouter(adminApiRoutes);
});

export type { PaymentCspConfig } from "#routes/middleware.ts";
// Re-export middleware functions for testing
export {
  buildCspHeader,
  getCleanUrl,
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
  normalizeHostname,
} from "#routes/middleware.ts";

// Re-export types
export type { ServerContext } from "#routes/types.ts";

/** Extract first path segment for O(1) prefix dispatch */
const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};

/** Create a lazy-loaded route handler (prefix already matched by dispatch map) */
const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

/** Prefix dispatch table — O(1) lookup replaces the sequential ?? chain */
const prefixHandlers: Record<string, RouterFn> = {
  // Exact-match public pages
  "": async (_request, path, method) => {
    if (path !== "/" || method !== "GET") return null;
    const { handleHome } = await loadPublicPages();
    return handleHome();
  },
  events: async (_request, path, method) => {
    if (path !== "/events" || method !== "GET") return null;
    const { handlePublicEvents } = await loadPublicPages();
    return handlePublicEvents();
  },
  terms: async (_request, path, method) => {
    if (path !== "/terms" || method !== "GET") return null;
    const { handlePublicTerms } = await loadPublicPages();
    return handlePublicTerms();
  },
  contact: async (_request, path, method) => {
    if (path !== "/contact" || method !== "GET") return null;
    const { handlePublicContact } = await loadPublicPages();
    return handlePublicContact();
  },
  // Prefix-matched lazy-loaded route groups
  admin: lazyRoute(loadAdminRoutes),
  ticket: lazyRoute(loadTicketRoutes),
  t: lazyRoute(loadTicketViewRoutes),
  checkin: lazyRoute(loadCheckinRoutes),
  image: lazyRoute(loadImageRoutes),
  attachment: lazyRoute(loadAttachmentRoutes),
  payment: lazyRoute(loadPaymentRoutes),
  join: lazyRoute(loadJoinRoutes),
  feeds: lazyRoute(loadFeedRoutes),
  wallet: lazyRoute(loadWalletRoutes),
  gwallet: lazyRoute(loadGoogleWalletRoutes),
  v1: lazyRoute(loadWalletWebserviceRoutes),
  demo: lazyRoute(loadDemoResetRoutes),
  api: async (request, path, method, server) => {
    // Admin API is always available (auth-protected)
    const adminResult = await (await loadAdminApiRoutes())(
      request,
      path,
      method,
      server,
    );
    if (adminResult) return adminResult;
    // Public API requires feature flag
    return (await getShowPublicApiFromDb())
      ? (await loadApiRoutes())(request, path, method, server)
      : null;
  },
};

/**
 * Route main application requests (after setup is complete)
 * Uses prefix dispatch for O(1) route group lookup instead of sequential matching
 */
const routeMainApp: RouterFn = async (request, path, method, server) => {
  const prefix = getPrefix(path);
  if (!Object.hasOwn(prefixHandlers, prefix)) return notFoundResponse();
  return (
    (await prefixHandlers[prefix]!(request, path, method, server)) ??
    notFoundResponse()
  );
};

/**
 * Handle incoming requests (internal, without security headers)
 * Uses path-based lazy loading to minimize cold start time
 */
const handleRequestInternal = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response> => {
  // Static routes always available (minimal overhead)
  const staticResponse = await routeStatic(request, path, method);
  if (staticResponse) return staticResponse;

  // Setup routes - only load for /setup paths
  if (path === "/setup" || path.startsWith("/setup/")) {
    const routeSetup = await loadSetupRoutes();
    const setupResponse = await routeSetup(request, path, method);
    if (setupResponse) return setupResponse;
  }

  // Require setup before accessing other routes
  if (!(await isSetupComplete())) {
    return redirectResponse("/setup");
  }

  await loadCurrencyCode();
  await loadTheme();
  await loadHeaderImage();
  return (await routeMainApp(request, path, method, server))!;
};

/** Log request and return response */
const logAndReturn = (
  response: Response,
  method: string,
  path: string,
  getElapsed: () => number,
): Response => {
  logRequest({
    method,
    path,
    status: response.status,
    durationMs: getElapsed(),
  });
  return response;
};

/**
 * Handle incoming requests with security headers and domain validation
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  // Buffer webhook body BEFORE entering async context wrappers. The Bunny Edge
  // runtime can garbage-collect the underlying request body resource during
  // awaits, so we must capture it while the resource is still alive.
  const { pathname } = new URL(request.url);
  const webhookBody =
    request.method === "POST" && isWebhookPath(pathname)
      ? new Uint8Array(await request.arrayBuffer())
      : undefined;
  const effectiveRequest = webhookBody
    ? new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: webhookBody,
      })
    : request;

  return runWithRequestId(() =>
    runWithQueryLogContext(() =>
      runWithSessionContext(async () => {
        const { url, path, method } = parseRequest(effectiveRequest);
        const getElapsed = createRequestTimer();
        detectIframeMode(effectiveRequest.url);

        try {
          // Strip tracking parameters (fbclid, utm_*, etc.) to avoid CDN caching issues
          if (method === "GET") {
            const cleanUrl = getCleanUrl(url);
            if (cleanUrl) {
              return logAndReturn(
                new Response(null, {
                  status: 301,
                  headers: { location: cleanUrl },
                }),
                method,
                path,
                getElapsed,
              );
            }
          }

          // Domain validation: redirect requests from unauthorized domains to the allowed domain
          if (!isValidDomain(effectiveRequest)) {
            const redirectUrl = buildDomainRedirectUrl(effectiveRequest);
            logDebug(
              "Domain",
              `Redirecting to ${redirectUrl} (${getDomainRejectionReason(effectiveRequest)})`,
            );
            return logAndReturn(
              domainRedirectResponse(redirectUrl),
              method,
              path,
              getElapsed,
            );
          }

          const embeddable = isEmbeddablePath(path);

          // Content-Type validation: reject POST requests without proper Content-Type
          // (webhook endpoints accept JSON, all others require form-urlencoded)
          if (!isValidContentType(effectiveRequest, path)) {
            return logAndReturn(
              contentTypeRejectionResponse(),
              method,
              path,
              getElapsed,
            );
          }

          try {
            // Populate flash context from keyed cookie (flash ID in URL)
            const flashId = new URL(effectiveRequest.url).searchParams.get(
              "flash",
            );
            const flashRaw = flashId
              ? parseCookies(effectiveRequest).get(`flash_${flashId}`)
              : null;
            const flash = flashRaw ? parseFlashValue(flashRaw) : null;
            if (flash) setFlashContext(flash);

            const response = await handleRequestInternal(
              effectiveRequest,
              path,
              method,
              server,
            );

            // Clear keyed flash cookie if one was consumed
            if (flashId && flash && hasFlash()) {
              withCookie(response, clearFlashCookie(flashId));
            }
            resetFlashContext();

            return logAndReturn(
              await applySecurityHeaders(response, embeddable),
              method,
              path,
              getElapsed,
            );
          } catch (error) {
            logError({
              code: ErrorCode.CDN_REQUEST,
              detail: formatRequestError(method, path, error),
            });
            if (error instanceof SessionKeyError) {
              return logAndReturn(
                redirectResponse("/admin", clearSessionCookie()),
                method,
                path,
                getElapsed,
              );
            }
            return logAndReturn(
              temporaryErrorResponse(),
              method,
              path,
              getElapsed,
            );
          }
        } finally {
          await flushPendingWork();
        }
      }),
    ),
  );
};
