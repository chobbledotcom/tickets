/**
 * Routes module - main exports and router
 * Uses lazy loading to minimize startup time for edge scripts
 */

import { once } from "#fp";
import { isSetupComplete } from "#lib/config.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  domainRejectionResponse,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "#routes/middleware.ts";
import type { createRouter } from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { notFoundResponse, parseRequest, redirect } from "#routes/utils.ts";

/** Router function type - reuse from router.ts */
type RouterFn = ReturnType<typeof createRouter>;

/** Lazy-load admin routes (only needed for authenticated admin requests) */
const loadAdminRoutes = once(async () => {
  const { routeAdmin } = await import("#routes/admin/index.ts");
  return routeAdmin;
});

/** Lazy-load public routes (ticket reservation) */
const loadPublicRoutes = once(async () => {
  const { handleHome, routeTicket } = await import("#routes/public.ts");
  return { handleHome, routeTicket };
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

// Re-export middleware functions for testing
export {
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "#routes/middleware.ts";

// Re-export types
export type { ServerContext } from "#routes/types.ts";

/** Check if path matches a route prefix (paths are normalized to strip trailing slashes) */
const matchesPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Create a lazy-loaded route handler for a path prefix */
const createLazyRoute =
  (prefix: string, loadRoute: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) => {
    if (!matchesPrefix(path, prefix)) return null;
    const route = await loadRoute();
    return route(request, path, method, server);
  };

/** Route home page requests */
const routeHome: RouterFn = async (_, path, method) => {
  if (path !== "/" || method !== "GET") return null;
  const { handleHome } = await loadPublicRoutes();
  return handleHome();
};

/** Lazy-loaded route handlers */
const routeAdminPath = createLazyRoute("/admin", loadAdminRoutes);
const routeTicketPath = createLazyRoute(
  "/ticket",
  async () => (await loadPublicRoutes()).routeTicket,
);
const routePaymentPath = createLazyRoute("/payment", loadPaymentRoutes);

/**
 * Route main application requests (after setup is complete)
 * Routes are loaded lazily based on path prefix
 */
const routeMainApp: RouterFn = async (request, path, method, server) =>
  (await routeHome(request, path, method, server)) ??
  (await routeAdminPath(request, path, method, server)) ??
  (await routeTicketPath(request, path, method, server)) ??
  (await routePaymentPath(request, path, method, server)) ??
  notFoundResponse();

/**
 * Handle incoming requests (internal, without security headers)
 * Uses path-based lazy loading to minimize cold start time
 */
const handleRequestInternal = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const { path, method } = parseRequest(request);

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
    return redirect("/setup");
  }

  return (
    (await routeMainApp(request, path, method, server)) ?? notFoundResponse()
  );
};

/**
 * Handle incoming requests with security headers and domain validation
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  // Domain validation: reject requests to unauthorized domains
  if (!isValidDomain(request)) {
    return domainRejectionResponse();
  }

  const { path } = parseRequest(request);
  const embeddable = isEmbeddablePath(path);

  // Content-Type validation: reject POST requests without proper Content-Type
  if (!isValidContentType(request)) {
    return contentTypeRejectionResponse();
  }

  const response = await handleRequestInternal(request, server);
  return applySecurityHeaders(response, embeddable);
};
