import {
  ADMIN_SECTIONS,
  ADMIN_SURFACE_AREAS,
} from "#shared/admin-surface/definitions.ts";
import { ADMIN_NAV_ROUTES } from "#shared/admin-surface/nav-routes.ts";
import { ADMIN_WRITE_ROUTES_A_M } from "#shared/admin-surface/write-routes-a-m.ts";
import { ADMIN_WRITE_ROUTES_N_Z } from "#shared/admin-surface/write-routes-n-z.ts";
import type { RouteParamNames } from "#shared/route-pattern.ts";
import type { AdminLevel } from "#shared/types.ts";

const ADMIN_ROUTES = [
  ...ADMIN_NAV_ROUTES,
  ...ADMIN_WRITE_ROUTES_A_M,
  ...ADMIN_WRITE_ROUTES_N_Z,
] as const;

export type AdminRouteId = (typeof ADMIN_ROUTES)[number]["id"];

type RouteFor<Id extends AdminRouteId> = Extract<
  (typeof ADMIN_ROUTES)[number],
  { readonly id: Id }
>;
export type AdminPathParams<Id extends AdminRouteId> = Record<
  RouteParamNames<RouteFor<Id>["pattern"]>,
  string | number
>;

export const adminRoute = (id: AdminRouteId) =>
  ADMIN_ROUTES.find((candidate) => candidate.id === id)!;

export const adminPath = <Id extends AdminRouteId>(
  id: Id,
  params: AdminPathParams<Id>,
): string =>
  adminRoute(id).pattern.replace(
    /:(\w+)/g,
    (_, name: RouteParamNames<RouteFor<Id>["pattern"]>) => String(params[name]),
  );

export const adminRouteAllowed = (
  id: AdminRouteId,
  adminLevel: AdminLevel,
  isReadOnly: boolean,
): boolean => {
  const route = adminRoute(id);
  return (
    route.audience.some((level) => level === adminLevel) &&
    !(isReadOnly && route.intent === "write-form")
  );
};

export const ADMIN_SURFACE = {
  areas: ADMIN_SURFACE_AREAS,
  routes: ADMIN_ROUTES,
  sections: ADMIN_SECTIONS,
} as const;
