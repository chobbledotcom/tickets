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
} from "#shared/admin-surface/ids.ts";
import { ADMIN_SECTIONS } from "#shared/admin-surface/sections.ts";
import type { AdminLevel } from "#shared/types.ts";

export type { AdminDestinationId, AdminPathParams };

const folded = foldAdminAreas(ADMIN_AREAS);

/** The id type comes from the same table, so the lookup cannot miss. */
export const adminDestination = (id: AdminDestinationId): AdminDestinationDef =>
  folded.destinations[id]!;

export const adminPath = <Id extends AdminDestinationId>(
  id: Id,
  params: AdminPathParams<Id>,
): string =>
  adminDestination(id).pattern.replace(/:(\w+)/g, (_, name: string) =>
    String((params as Record<string, string | number>)[name]),
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
