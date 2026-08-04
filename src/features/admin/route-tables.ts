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

/** The two GET routes every entity page owns: the bare detail path (default
 * tab) and its `/:tab` variant. */
export type EntityTabRoutes<Base extends string, Param extends string> = {
  [K in
    | `GET ${Base}/:${Param}`
    | `GET ${Base}/:${Param}/:tab`]: TypedRouteHandler<K>;
};

/** Bind an entity page's two GET routes, ready to spread into the section's
 * route table. `param` is the route's id parameter name; it must keep the
 * router's numeric-param convention (`id` or `…Id`) so the page receives a
 * parsed number. */
export const entityTabRoutes = <
  Base extends string,
  Param extends "id" | `${string}Id` = "id",
>(
  base: Base,
  page: Pick<EntityPage<never>, "renderTab">,
  param?: Param,
): EntityTabRoutes<Base, Param> => {
  const name: Param = param ?? ("id" as Param);
  const idOf = (params: Record<Param, number>): number => params[name];
  return {
    [`GET ${base}/:${name}`]: (
      request: Request,
      params: Record<Param, number>,
    ) => page.renderTab(request, idOf(params), ""),
    [`GET ${base}/:${name}/:tab`]: (
      request: Request,
      params: Record<Param, number> & { tab: string },
    ) => page.renderTab(request, idOf(params), params.tab),
  } as EntityTabRoutes<Base, Param>;
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
