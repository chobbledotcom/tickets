/**
 * Declarative router with pattern matching and typed route params
 */

import { reduce } from "#fp";
import type { ServerContext } from "#routes/types.ts";

// =============================================================================
// Type-level route param inference
// =============================================================================

/** Extract path part from "METHOD /path" pattern */
type ExtractPath<S extends string> = S extends `${string} ${infer Path}` ? Path : S;

/** Recursively extract param names from a URL path pattern */
type ExtractParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

/** Infer runtime type from param name (mirrors isNumericParam convention) */
type InferParamType<Name extends string> =
  Name extends `${string}Id` ? number :
  Name extends "id" ? number :
  string;

/** Build typed params object from a route pattern string */
export type RouteParamsFor<Pattern extends string> = {
  [K in ExtractParamNames<ExtractPath<Pattern>>]: InferParamType<K>;
};

/** Route handler with params inferred from the route pattern */
export type TypedRouteHandler<Pattern extends string> = (
  request: Request,
  params: RouteParamsFor<Pattern>,
  server?: ServerContext,
) => Response | Promise<Response>;

// =============================================================================
// Runtime types
// =============================================================================

/** Route parameters extracted from URL patterns (ID params are auto-parsed to numbers) */
export type RouteParams = Record<string, string | number | undefined>;

/** Route handler function signature (used internally by createRouter) */
export type RouteHandlerFn = (
  request: Request,
  params: RouteParams,
  server?: ServerContext,
) => Response | Promise<Response>;

/** Compiled route with regex */
type CompiledRoute = {
  regex: RegExp;
  paramNames: string[];
  numericParams: Set<string>;
  handler: RouteHandlerFn;
};

/** Check if a param name refers to a numeric ID */
const isNumericParam = (name: string): boolean =>
  name.endsWith("Id") || name === "id";

/** Param patterns by type - name ending determines pattern */
const getParamPattern = (name: string): string => {
  // Params ending in Id match digits only (e.g., eventId, attendeeId)
  if (isNumericParam(name)) return "(\\d+)";
  // Slugs match lowercase alphanumeric with hyphens
  if (name === "slug") return "([a-z0-9]+(?:-[a-z0-9]+)*)";
  // Default: match any non-slash characters
  return "([^/]+)";
};

/**
 * Compile a route pattern into a regex
 * Supports :param syntax for path parameters
 * All paths are normalized to strip trailing slashes before matching
 * Examples:
 *   "GET /admin" -> matches /admin
 *   "GET /admin/event/:id" -> extracts id param from /admin/event/123
 *   "GET /ticket/:slug" -> extracts slug param like /ticket/my-event-2024
 */
const compilePattern = (
  pattern: string,
): CompiledRoute["regex"] & { paramNames: string[]; numericParams: Set<string> } => {
  const paramNames: string[] = [];
  const numericParams = new Set<string>();

  // Escape special regex chars except : which we use for params
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      if (isNumericParam(name)) numericParams.add(name);
      return getParamPattern(name);
    });

  const regex = new RegExp(`^${regexStr}$`) as RegExp & {
    paramNames: string[];
    numericParams: Set<string>;
  };
  regex.paramNames = paramNames;
  regex.numericParams = numericParams;
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
): Map<string, CompiledRoute[]> =>
  reduce(
    (compiled: Map<string, CompiledRoute[]>, [pattern, handler]: [string, RouteHandlerFn]) => {
      const { method, path } = parseRoutePattern(pattern);
      const regex = compilePattern(path);
      const methodRoutes = compiled.get(method) ?? [];
      methodRoutes.push({
        regex,
        paramNames: regex.paramNames,
        numericParams: regex.numericParams,
        handler,
      });
      compiled.set(method, methodRoutes);
      return compiled;
    },
    new Map<string, CompiledRoute[]>(),
  )(Object.entries(routes));

/**
 * Extract params from regex match using param names
 */
const extractParams = (
  paramNames: string[],
  numericParams: Set<string>,
  match: RegExpMatchArray,
): RouteParams => {
  const params: RouteParams = {};
  for (let i = 0; i < paramNames.length; i++) {
    const name = paramNames[i];
    const value = match[i + 1];
    if (name !== undefined && value !== undefined) {
      params[name] = numericParams.has(name) ? Number(value) : value;
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
    params: extractParams(route.paramNames, route.numericParams, match),
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

  return (request, path, method, server) => {
    const match = matchRequest(compiled, method, path);
    if (!match) return Promise.resolve(null);
    return Promise.resolve(match.handler(request, match.params, server));
  };
};

/**
 * Define routes with typed params inferred from route pattern strings.
 * Params ending in "Id" or named "id" are typed as number; all others as string.
 */
export const defineRoutes = <T extends string>(
  routes: { [K in T]: TypedRouteHandler<K> },
): Record<string, RouteHandlerFn> => routes as unknown as Record<string, RouteHandlerFn>;
