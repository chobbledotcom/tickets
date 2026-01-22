/**
 * Routes module - main exports and router
 */

import { isSetupComplete } from "#lib/config.ts";
import { notFoundPage } from "#templates";
import { routeAdmin } from "./admin.ts";
import { handleHealthCheck } from "./health.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  corsRejectionResponse,
  isEmbeddablePath,
  isValidContentType,
  isValidOrigin,
} from "./middleware.ts";
import { handleHome, routeTicket } from "./public.ts";
import { routeSetup } from "./setup.ts";
import type { ServerContext } from "./types.ts";
import { htmlResponse, redirect } from "./utils.ts";
import { routePayment } from "./webhooks.ts";

// Re-export middleware functions for testing
export {
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidOrigin,
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
 * Handle incoming requests (internal, without security headers)
 */
const handleRequestInternal = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health check always available
  if (path === "/health") {
    const healthResponse = handleHealthCheck(method);
    if (healthResponse) return healthResponse;
  }

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
 * Handle incoming requests with security headers and CORS protection
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname;
  const embeddable = isEmbeddablePath(path);

  // CORS protection: reject cross-origin POST requests
  if (!isValidOrigin(request)) {
    return corsRejectionResponse();
  }

  // Content-Type validation: reject POST requests without proper Content-Type
  if (!isValidContentType(request)) {
    return contentTypeRejectionResponse();
  }

  const response = await handleRequestInternal(request, server);
  return applySecurityHeaders(response, embeddable);
};
