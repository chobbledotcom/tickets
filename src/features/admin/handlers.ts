import type { RouteHandlerFn, TypedRouteHandler } from "#routes/router.ts";
import type { AdminAreaId } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";

type RouteForArea<Area extends AdminAreaId> = Extract<
  (typeof ADMIN_SURFACE.routes)[number],
  { readonly area: Area }
>;

export type AdminHandlers<Area extends AdminAreaId> = {
  [Route in RouteForArea<Area> as Route["id"]]: TypedRouteHandler<`${Route["method"]} ${Route["pattern"]}`>;
};

/** Type-check one lazy area's handlers against every route the surface owns. */
export const handlersFor =
  <Area extends AdminAreaId>(_area: Area) =>
  (handlers: AdminHandlers<Area>): AdminHandlers<Area> =>
    handlers;

/** Restore the router's method/path map only at its generic dispatch boundary. */
export const routeMapForArea = (
  area: AdminAreaId,
  handlers: Record<string, (...args: never[]) => unknown>,
): Record<string, RouteHandlerFn> => {
  const runtimeHandlers = handlers as Record<string, RouteHandlerFn>;
  return Object.fromEntries(
    ADMIN_SURFACE.routes
      .filter((route) => route.area === area)
      .map((route) => [
        `${route.method} ${route.pattern}`,
        // Every lazy module passes through handlersFor before this runtime boundary.
        runtimeHandlers[route.id]!,
      ]),
  );
};
