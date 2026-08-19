/**
 * The admin surface every consumer reads: each route by id, and the segments
 * each area serves. Both derive from the one declaration in
 * `admin-surface/areas.ts`.
 */

import { ADMIN_AREAS } from "#shared/admin-surface/areas.ts";
import {
  type AdminDestinationDef,
  foldAdminAreas,
} from "#shared/admin-surface/definitions.ts";
import type {
  AdminDestinationId,
  AdminPathParams,
  AdminPatternFor,
} from "#shared/admin-surface/ids.ts";
import { ADMIN_SECTIONS } from "#shared/admin-surface/sections.ts";
import type { AdminLevel } from "#shared/types.ts";

export type { AdminDestinationId, AdminPathParams, AdminPatternFor };

const folded = foldAdminAreas(ADMIN_AREAS);

/** The id type comes from the same table, so the lookup cannot miss. */
export const adminDestination = (id: AdminDestinationId): AdminDestinationDef =>
  folded.destinations[id]!;

/**
 * The path a route declares, keeping the literal type the table wrote. This is
 * what a route table binds its handlers under, so the pattern the router serves
 * and the pattern the surface promises are the same string.
 *
 * The declared type says which literal it is; the fold that produced it works
 * over plain data and cannot carry that through, so the value is named here
 * and the test reads every id back to prove the two agree.
 */
export const adminPattern = <Id extends AdminDestinationId>(
  id: Id,
): AdminPatternFor<Id> => adminDestination(id).pattern as AdminPatternFor<Id>;

export const adminPath = <Id extends AdminDestinationId>(
  id: Id,
  params: AdminPathParams<Id>,
): string =>
  adminDestination(id).pattern.replace(
    /:(\w+)/g,
    (_, name: keyof AdminPathParams<Id>) => String(params[name]),
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
  areas: folded.areas,
  destinations: folded.destinations,
  sections: ADMIN_SECTIONS,
} as const;
