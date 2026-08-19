/**
 * Spreadable route-table factories for admin sections.
 *
 * A section's route table spreads these instead of hand-typing the standard
 * entries; a section with one bespoke step spreads the standard set and
 * restates just that key (e.g. a custom `:id/edit` POST).
 */

import type { EntityPage } from "#routes/admin/entity-pages.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import type { RouteParamNames } from "#shared/route-pattern.ts";

/** The two GET routes every entity page owns: the declared detail path (its
 * default tab) and the `/:tab` variant beneath it. */
export type EntityTabRoutes<Pattern extends string> = {
  [K in `GET ${Pattern}` | `GET ${Pattern}/:tab`]: TypedRouteHandler<K>;
};

/** The id parameter a detail path ends with. It must keep the router's
 * numeric-param convention (`id` or `…Id`) so the page receives a number. */
const idParamOf = (pattern: string): string => {
  const marker = pattern.lastIndexOf("/:");
  const name = marker === -1 ? "" : pattern.slice(marker + 2);
  if (name === "" || name.includes("/")) {
    throw new Error(`Entity detail path names no record: ${pattern}`);
  }
  return name;
};

/** Bind an entity page's two GET routes under the path its destination
 * declares, ready to spread into the area's route table. */
export const entityTabRoutes = <Pattern extends string>(
  pattern: Pattern,
  page: Pick<EntityPage<never>, "renderTab">,
): EntityTabRoutes<Pattern> => {
  const name = idParamOf(pattern) as RouteParamNames<Pattern>;
  const idOf = (params: Record<RouteParamNames<Pattern>, number>): number =>
    params[name];
  return {
    [`GET ${pattern}`]: (
      request: Request,
      params: Record<RouteParamNames<Pattern>, number>,
    ) => page.renderTab(request, idOf(params), ""),
    [`GET ${pattern}/:tab`]: (
      request: Request,
      params: Record<RouteParamNames<Pattern>, number> & { tab: string },
    ) => page.renderTab(request, idOf(params), params.tab),
  } as EntityTabRoutes<Pattern>;
};

/** The handler bundle a CRUD factory returns, bindable via
 * {@link crudRoutes} or one key at a time. */
export interface CrudHandlers {
  createPost: RequestRoute;
  deleteGet: IdRouteHandler;
  deletePost: IdRouteHandler;
  editPost: IdRouteHandler;
  listGet: RequestRoute;
  newGet: RequestRoute;
}

/** The six routes a standard CRUD section binds. */
export type CrudRoutes<Base extends string> = {
  [K in
    | `GET ${Base}`
    | `GET ${Base}/new`
    | `GET ${Base}/:id/delete`
    | `POST ${Base}`
    | `POST ${Base}/:id/delete`
    | `POST ${Base}/:id/edit`]: TypedRouteHandler<K>;
};

/** Bind a CRUD handler bundle under its section's six standard routes, ready
 * to spread into the route table. */
export const crudRoutes = <Base extends string>(
  base: Base,
  crud: CrudHandlers,
): CrudRoutes<Base> =>
  ({
    [`GET ${base}`]: crud.listGet,
    [`GET ${base}/new`]: crud.newGet,
    [`GET ${base}/:id/delete`]: crud.deleteGet,
    [`POST ${base}`]: crud.createPost,
    [`POST ${base}/:id/delete`]: crud.deletePost,
    [`POST ${base}/:id/edit`]: crud.editPost,
  }) as CrudRoutes<Base>;
