/**
 * Declarative router with pattern matching
 */

import type { ServerContext } from "./types.ts";

/** Route parameters extracted from URL patterns */
export type RouteParams = Record<string, string | undefined>;

/** Route handler function signature */
export type RouteHandlerFn = (
  request: Request,
  params: RouteParams,
  server?: ServerContext,
) => Response | Promise<Response>;

/** Compiled route with regex */
type CompiledRoute = {
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandlerFn;
};

/**
 * Compile a route pattern into a regex
 * Supports :param syntax for path parameters
 * Examples:
 *   "GET /admin/" -> matches exact path
 *   "GET /admin/event/:id" -> extracts id param
 *   "POST /admin/event/:eventId/attendee/:attendeeId/delete" -> extracts both params
 */
const compilePattern = (
  pattern: string,
): CompiledRoute["regex"] & { paramNames: string[] } => {
  const paramNames: string[] = [];

  // Escape special regex chars except : which we use for params
  let regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "(\\d+)"; // Capture digits for ID params
    });

  // Handle trailing slash optionality for paths ending in /
  if (regexStr.endsWith("/")) {
    regexStr = `${regexStr.slice(0, -1)}/?`;
  }

  const regex = new RegExp(`^${regexStr}$`) as RegExp & {
    paramNames: string[];
  };
  regex.paramNames = paramNames;
  return regex;
};

/**
 * Parse route pattern "METHOD /path" into method and path parts
 */
const parseRoutePattern = (
  pattern: string,
): { method: string; path: string } => {
  const spaceIndex = pattern.indexOf(" ");
  return {
    method: pattern.slice(0, spaceIndex),
    path: pattern.slice(spaceIndex + 1),
  };
};

/**
 * Compile all routes for efficient matching
 */
const compileRoutes = (
  routes: Record<string, RouteHandlerFn>,
): Map<string, CompiledRoute[]> => {
  const compiled = new Map<string, CompiledRoute[]>();

  for (const [pattern, handler] of Object.entries(routes)) {
    const { method, path } = parseRoutePattern(pattern);
    const regex = compilePattern(path);

    const methodRoutes = compiled.get(method) ?? [];
    methodRoutes.push({
      regex,
      paramNames: regex.paramNames,
      handler,
    });
    compiled.set(method, methodRoutes);
  }

  return compiled;
};

/**
 * Extract params from regex match using param names
 */
const extractParams = (
  paramNames: string[],
  match: RegExpMatchArray,
): RouteParams => {
  const params: RouteParams = {};
  for (let i = 0; i < paramNames.length; i++) {
    const name = paramNames[i];
    const value = match[i + 1];
    if (name !== undefined && value !== undefined) {
      params[name] = value;
    }
  }
  return params;
};

/**
 * Try to match a single route against a path
 */
const tryMatchRoute = (
  route: CompiledRoute,
  path: string,
): { handler: RouteHandlerFn; params: RouteParams } | null => {
  const match = path.match(route.regex);
  if (!match) return null;
  return {
    handler: route.handler,
    params: extractParams(route.paramNames, match),
  };
};

/**
 * Match a request against compiled routes
 */
const matchRequest = (
  compiledRoutes: Map<string, CompiledRoute[]>,
  method: string,
  path: string,
): { handler: RouteHandlerFn; params: RouteParams } | null => {
  const methodRoutes = compiledRoutes.get(method);
  if (!methodRoutes) return null;

  for (const route of methodRoutes) {
    const result = tryMatchRoute(route, path);
    if (result) return result;
  }

  return null;
};

/**
 * Create a router function from route definitions
 */
export const createRouter = (
  routes: Record<string, RouteHandlerFn>,
): ((
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
) => Promise<Response | null>) => {
  const compiled = compileRoutes(routes);

  return async (request, path, method, server) => {
    const match = matchRequest(compiled, method, path);
    if (!match) return null;
    return match.handler(request, match.params, server);
  };
};

/**
 * Helper to define routes with type safety
 */
export const defineRoutes = (
  routes: Record<string, RouteHandlerFn>,
): Record<string, RouteHandlerFn> => routes;
