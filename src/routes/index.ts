/**
 * Routes module - main exports and router
 */

import { isSetupComplete } from "#lib/config.ts";
import { notFoundPage } from "#templates";
import { routeAdmin } from "./admin.ts";
import { handleFavicon } from "./favicon.ts";
import { handleHealthCheck } from "./health.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  domainRejectionResponse,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "./middleware.ts";
import { handleHome, routeTicket } from "./public.ts";
import { routeSetup } from "./setup.ts";
import type { ServerContext } from "./types.ts";
import { htmlResponse, parseRequest, redirect } from "./utils.ts";
import { routePayment } from "./webhooks.ts";

// Re-export middleware functions for testing
export {
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "./middleware.ts";

// Re-export types
export type { ServerContext } from "./types.ts";

/**
 * Route main application requests (after setup is complete)
 */
const routeMainApp = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response> => {
  if (path === "/" && method === "GET") {
    return handleHome();
  }

  const adminResponse = await routeAdmin(request, path, method, server);
  if (adminResponse) return adminResponse;

  const ticketResponse = await routeTicket(request, path, method);
  if (ticketResponse) return ticketResponse;

  const paymentResponse = await routePayment(request, path, method);
  if (paymentResponse) return paymentResponse;

  return htmlResponse(notFoundPage(), 404);
};

/**
 * Route static assets (health check, favicon) - always available
 */
const routeStatic = (path: string, method: string): Response | null => {
  if (path === "/health") return handleHealthCheck(method);
  if (path === "/favicon.ico") return handleFavicon(method);
  return null;
};

/**
 * Handle incoming requests (internal, without security headers)
 */
const handleRequestInternal = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const { path, method } = parseRequest(request);

  // Static routes always available
  const staticResponse = routeStatic(path, method);
  if (staticResponse) return staticResponse;

  // Setup routes
  const setupResponse = await routeSetup(
    request,
    path,
    method,
    isSetupComplete,
  );
  if (setupResponse) return setupResponse;

  // Require setup before accessing other routes
  if (!(await isSetupComplete())) {
    return redirect("/setup/");
  }

  return routeMainApp(request, path, method, server);
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
