import { readOnlyGetRoutePatterns } from "#shared/admin-pages.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { routePathPatternToRegex } from "#shared/route-pattern.ts";

const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

const READ_ONLY_ADMIN_OPERATIONS = ADMIN_SURFACE.routes
  .filter((route) => route.method !== "GET" && route.readOnly === "allow")
  .map((route) => ({
    method: route.method,
    pattern: routePathPatternToRegex(route.pattern),
  }));

const READ_ONLY_SAFE_PATHS = [
  /^\/renew$/,
  /^\/pay\/[^/]+$/,
  /^\/payment\/webhook$/,
  /^\/v1\/devices\/[^/]+\/registrations\/[^/]+\/[^/]+$/,
  /^\/v1\/log$/,
  /^\/sms\/webhook$/,
  /^\/join\/[^/]+$/,
  /^\/unsubscribe$/,
  /^\/contact$/,
  /^\/instance\/site-credentials$/,
  /^\/scheduled$/,
  /^\/checkin\/[^/]+$/,
];

const isMutatingMethod = (method: string): boolean =>
  method === "DELETE" ||
  method === "PATCH" ||
  method === "POST" ||
  method === "PUT";

const isAdminMutation = (path: string, method: string): boolean =>
  isMutatingMethod(method) && (path === "/admin" || path.startsWith("/admin/"));

const isAllowedAdminOperation = (path: string, method: string): boolean =>
  READ_ONLY_ADMIN_OPERATIONS.some(
    (route) => route.method === method && route.pattern.test(path),
  );

/**
 * Decide whether read-only mode blocks one request. The caller handles the
 * response, keeping environment and request-context reads out of this module.
 */
export const readOnlyBlock = (
  path: string,
  method: string,
): "api" | "page" | null => {
  if (path.startsWith("/api/") && isMutatingMethod(method)) {
    return "api";
  }

  if (
    method === "GET" &&
    READ_ONLY_GET_PATTERNS.some((pattern) => pattern.test(path))
  ) {
    return "page";
  }

  if (isAdminMutation(path, method)) {
    return isAllowedAdminOperation(path, method) ? null : "page";
  }

  if (!isMutatingMethod(method)) return null;
  return READ_ONLY_SAFE_PATHS.some((pattern) => pattern.test(path))
    ? null
    : "page";
};
