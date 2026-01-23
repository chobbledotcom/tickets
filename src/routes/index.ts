/**
 * Routes module - main exports and router
 */

import { isSetupComplete } from "#lib/config.ts";
import { routeAdmin } from "#routes/admin/index.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  domainRejectionResponse,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "#routes/middleware.ts";
import { handleHome, routeTicket } from "#routes/public.ts";
import { createSetupRouter } from "#routes/setup.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { notFoundResponse, parseRequest, redirect } from "#routes/utils.ts";
import { routePayment } from "#routes/webhooks.ts";

// Re-export middleware functions for testing
export {
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "#routes/middleware.ts";

// Re-export types
export type { ServerContext } from "#routes/types.ts";

// Create setup router with isSetupComplete dependency injected
const routeSetup = createSetupRouter(isSetupComplete);

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

  return notFoundResponse();
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
  const staticResponse = await routeStatic(request, path, method);
  if (staticResponse) return staticResponse;

  // Setup routes
  const setupResponse = await routeSetup(request, path, method);
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
