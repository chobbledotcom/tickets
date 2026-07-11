import {
  ADMIN_SECTIONS,
  ADMIN_SURFACE_AREAS,
} from "#shared/admin-surface/definitions.ts";
import { ADMIN_NAV_ROUTES } from "#shared/admin-surface/nav-routes.ts";
import { ADMIN_ROUTES } from "#shared/admin-surface/routes/index.ts";
import { ADMIN_WRITE_ROUTES_A_M } from "#shared/admin-surface/write-routes-a-m.ts";
import { ADMIN_WRITE_ROUTES_N_Z } from "#shared/admin-surface/write-routes-n-z.ts";
import type { RouteParamNames } from "#shared/route-pattern.ts";
import type { AdminLevel } from "#shared/types.ts";

const ADMIN_DESTINATIONS = [
  ...ADMIN_NAV_ROUTES,
  ...ADMIN_WRITE_ROUTES_A_M,
  ...ADMIN_WRITE_ROUTES_N_Z,
] as const;

const ADMIN_PATHS = [...ADMIN_DESTINATIONS, ...ADMIN_ROUTES] as const;

export type AdminDestinationId = (typeof ADMIN_DESTINATIONS)[number]["id"];
export type AdminRouteId = (typeof ADMIN_ROUTES)[number]["id"];
export type AdminPathId = (typeof ADMIN_PATHS)[number]["id"];

type PathFor<Id extends AdminPathId> = Extract<
  (typeof ADMIN_PATHS)[number],
  { readonly id: Id }
>;
export type AdminPathParams<Id extends AdminPathId> = Record<
  RouteParamNames<PathFor<Id>["pattern"]>,
  string | number
>;

// AdminDestinationId is derived from this list, so the lookup cannot miss.
export const adminDestination = (id: AdminDestinationId) =>
  ADMIN_DESTINATIONS.find((candidate) => candidate.id === id)!;

// AdminPathId is derived from destinations and routes, so the lookup cannot miss.
const adminPathDefinition = (id: AdminPathId) =>
  ADMIN_PATHS.find((candidate) => candidate.id === id)!;

export const adminPath = <Id extends AdminPathId>(
  id: Id,
  params: AdminPathParams<Id>,
): string =>
  adminPathDefinition(id).pattern.replace(
    /:(\w+)/g,
    (_, name: RouteParamNames<PathFor<Id>["pattern"]>) => String(params[name]),
  );

export const adminDestinationAllowed = (
  id: AdminDestinationId,
  adminLevel: AdminLevel,
  isReadOnly: boolean,
): boolean => {
  const route = adminDestination(id);
  return (
    route.audience.some((level) => level === adminLevel) &&
    !(isReadOnly && route.intent === "write-form")
  );
};

export const ADMIN_SURFACE = {
  areas: ADMIN_SURFACE_AREAS,
  destinations: ADMIN_DESTINATIONS,
  routes: ADMIN_ROUTES,
  sections: ADMIN_SECTIONS,
} as const;
