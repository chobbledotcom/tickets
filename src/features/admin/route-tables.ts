/**
 * Spreadable route-table factories for admin sections.
 *
 * A section's route table spreads these instead of hand-typing the standard
 * entries. A section with one bespoke step spreads the standard set and
 * restates just that key, for example a custom `:id/edit` POST.
 */

import type { EntityPage } from "#routes/admin/entity-pages.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import {
  defineRoutes,
  type RouteTableFactory,
  type TypedRouteHandler,
} from "#routes/router.ts";
import {
  ADMIN_SURFACE,
  oneServedPath,
  type RecordAreaId,
  type RecordAreaIds,
  type RecordAreaPatterns,
  recordAreaIds,
  recordAreaPatterns,
} from "#shared/admin-surface.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  type RouteParamNames,
  routePathPatternToRegex,
} from "#shared/route-pattern.ts";

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
  if (name.includes("/") || !(name === "id" || name.endsWith("Id"))) {
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

/** The five routes of a record that is created on its list page. */
export type ListCrudRoutes<Base extends string> = {
  [K in
    | `GET ${Base}`
    | `GET ${Base}/:id/delete`
    | `POST ${Base}`
    | `POST ${Base}/:id/delete`
    | `POST ${Base}/:id/edit`]: TypedRouteHandler<K>;
};

/** The six routes a standard CRUD section binds: the five, and the new page. */
export type CrudRoutes<Base extends string> = ListCrudRoutes<Base> & {
  [K in `GET ${Base}/new`]: TypedRouteHandler<K>;
};

/** Bind a CRUD handler bundle under the five routes of a record that is
 * created on its list page. */
export const listCrudRoutes = <Base extends string>(
  base: Base,
  crud: CrudHandlers,
): ListCrudRoutes<Base> =>
  ({
    [`GET ${base}`]: crud.listGet,
    [`GET ${base}/:id/delete`]: crud.deleteGet,
    [`POST ${base}`]: crud.createPost,
    [`POST ${base}/:id/delete`]: crud.deletePost,
    [`POST ${base}/:id/edit`]: crud.editPost,
  }) as ListCrudRoutes<Base>;

/** Bind a CRUD handler bundle under its section's six standard routes, ready
 * to spread into the route table. */
export const crudRoutes = <Base extends string>(
  base: Base,
  crud: CrudHandlers,
): CrudRoutes<Base> =>
  ({
    ...listCrudRoutes(base, crud),
    [`GET ${base}/new`]: crud.newGet,
  }) as CrudRoutes<Base>;

/** Bind an ordered collection's two move routes under the path of the row
 * they move, ready to spread into the route table. */
export const orderRoutes = <Base extends string, Handler>(
  base: Base,
  order: { down: Handler; up: Handler },
): Record<`POST ${Base}/move-down` | `POST ${Base}/move-up`, Handler> =>
  ({
    [`POST ${base}/move-down`]: order.down,
    [`POST ${base}/move-up`]: order.up,
  }) as Record<`POST ${Base}/move-down` | `POST ${Base}/move-up`, Handler>;

/** The routes a record area's list and record page serve. The new page route
 * is absent when the area declares none. */
export type RecordRoutes<Area extends RecordAreaId> =
  (RecordAreaIds<Area>["newPage"] extends false
    ? ListCrudRoutes<RecordAreaPatterns<Area>["list"]>
    : CrudRoutes<RecordAreaPatterns<Area>["list"]>) &
    EntityTabRoutes<RecordAreaPatterns<Area>["detail"]>;

/** Bind a record's list routes and its two entity tabs under the paths its
 *  area declares, ready to spread into the area's route table. */
export const recordRoutes = <Area extends RecordAreaId>(
  area: Area,
  crud: CrudHandlers,
  page: Pick<EntityPage<never>, "renderTab">,
): RecordRoutes<Area> => {
  const patterns = recordAreaPatterns(area);
  const listRoutes = recordAreaIds(area).newPage ? crudRoutes : listCrudRoutes;
  return {
    ...listRoutes(patterns.list, crud),
    ...entityTabRoutes(patterns.detail, page),
  } as RecordRoutes<Area>;
};

/** Define an admin route table. It refuses any route whose path no declared
 * destination serves. A route without a declaration has no audience, so the
 * role matrix and the nav cannot say who reaches it. A new route must not
 * arrive that way. The typed call signature is shared with `defineRoutes`.
 * This adds the bind-time declaration check on top. */
export const defineAdminRoutes: RouteTableFactory = (routes) => {
  const destinations = Object.values(ADMIN_SURFACE.destinations);
  for (const route of Object.keys(routes)) {
    const boundary = route.indexOf(" ");
    const pattern = routePathPatternToRegex(route.slice(boundary + 1));
    const declared = destinations.some((destination) =>
      pattern.test(oneServedPath(destination.pattern)),
    );
    if (!declared) {
      throw new Error(`No admin route is declared for "${route}"`);
    }
  }
  return defineRoutes(routes);
};
