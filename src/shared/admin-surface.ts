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

/**
 * The route declared under an id. The id type comes from the same table, so a
 * miss means the caller reached past the types — a page definition or a test
 * naming a route that was never declared. It says so, rather than handing back
 * `undefined` for the next line to trip over.
 */
export const adminDestination = (
  id: AdminDestinationId,
): AdminDestinationDef => {
  const destination = folded.destinations[id];
  if (!destination) throw new Error(`No admin route is declared as "${id}"`);
  return destination;
};

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

/** The route declared at a path, named by the path itself. A route table key
 * is a path, so this is how a handler asks what its own route declares. */
export const adminDestinationAt = (pattern: string): AdminDestinationDef => {
  const destination = folded.byPattern[pattern];
  if (!destination) {
    throw new Error(`No admin route is declared at "${pattern}"`);
  }
  return destination;
};

/**
 * The roles that can reach any part of one record's page: the page itself and
 * every route beneath it. This is the floor an entity page's guard enforces,
 * because a tab open to a wider role sits under the same path.
 *
 * A tab still decides for itself who sees it. Widening a route under a page
 * widens this floor, and the tab gates below it are what keep that safe.
 */
export const adminPageAudience = (
  route: AdminDestinationDef,
): readonly AdminLevel[] => {
  const { pattern } = route;
  const reached = new Set<AdminLevel>();
  for (const destination of Object.values(folded.destinations)) {
    if (
      destination.pattern === pattern ||
      destination.pattern.startsWith(`${pattern}/`)
    ) {
      for (const level of destination.audience) reached.add(level);
    }
  }
  return [...reached];
};

/**
 * The path to one record, for a route addressed by a single parameter. Entity
 * pages use it because each names its record differently — `:id`, `:apiKeyId`,
 * `:attendeeId` — and the page itself does not care which.
 */
export const adminRecordPath = (
  id: AdminDestinationId,
  record: string | number,
): string => {
  const { pattern } = adminDestination(id);
  const [only, ...rest] = pattern.match(/:\w+/g) ?? [];
  if (only === undefined || rest.length > 0) {
    throw new Error(`Admin route "${id}" does not address one record`);
  }
  return pattern.replace(only, String(record));
};

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
