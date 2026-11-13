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
  RecordAreaId,
  RecordAreaIds,
  RecordAreaPatterns,
} from "#shared/admin-surface/ids.ts";
import { ADMIN_SECTIONS } from "#shared/admin-surface/sections.ts";
import type { AdminLevel } from "#types";

export type {
  AdminDestinationId,
  AdminPathParams,
  AdminPatternFor,
  RecordAreaId,
  RecordAreaIds,
  RecordAreaPatterns,
};

const folded = foldAdminAreas(ADMIN_AREAS);

/** The route ids the record of one record area reads. */
export const recordAreaIds = (
  area: RecordAreaId,
): RecordAreaIds<RecordAreaId> => ADMIN_AREAS[area].record;

/** Look up a declared id, including ids read from the validated table. */
const destinationFor = (id: string): AdminDestinationDef => {
  const destination = folded.destinations[id];
  if (!destination) throw new Error(`No admin route is declared as "${id}"`);
  return destination;
};

/** The route declared under a typed destination id. */
export const adminDestination = (id: AdminDestinationId): AdminDestinationDef =>
  destinationFor(id);

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

/** The route declared at a path or under an id. A route table key is a path.
 * A handler that knows its declaration passes the id. */
export const adminDestinationAt = (route: string): AdminDestinationDef => {
  const destination = folded.byPattern[route] ?? folded.destinations[route];
  if (!destination) {
    throw new Error(`No admin route is declared at "${route}"`);
  }
  return destination;
};

/** The route at a path or id, or null when the surface declares none. */
export const adminDestinationAtOrNull = (
  route: string,
): AdminDestinationDef | null =>
  folded.byPattern[route] ?? folded.destinations[route] ?? null;

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

const recordPath = (
  { id, pattern }: AdminDestinationDef,
  record: string | number,
): string => {
  const [only, ...rest] = pattern.match(/:\w+/g) ?? [];
  if (only === undefined || rest.length > 0) {
    throw new Error(`Admin route "${id}" does not address one record`);
  }
  return pattern.replace(only, String(record));
};

/** The path to one record, whatever the route calls its parameter. */
export const adminRecordPath = (
  id: AdminDestinationId,
  record: string | number,
): string => recordPath(adminDestination(id), record);

/** A generated CRUD save uses its route's override, or its collection list.
 *  A record can override the landing for its own surface. */
export const afterSavePath = (
  route: AdminDestinationDef,
  list: AdminDestinationId,
  record: number,
  landingOverride?: AdminDestinationId,
): string => {
  const landing = destinationFor(landingOverride ?? route.afterSave ?? list);
  return landing.pattern.includes(":")
    ? recordPath(landing, record)
    : landing.pattern;
};

/** One path a pattern can serve. Numeric parameters take a plausible id and
 * the rest take a word. That is enough for the router to match the route and
 * for a guard to run. A caller asks this before it looks any record up. */
export const oneServedPath = (pattern: string): string =>
  pattern
    .replace(/:(\w+)/g, (_, name: string) =>
      name === "id" || name.endsWith("Id") ? "1" : "value",
    )
    .replace(/\/$/, "");

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

/** The list path and the record page path a record area declares. */
export const recordAreaPatterns = <Area extends RecordAreaId>(
  area: Area,
): RecordAreaPatterns<Area> => {
  const ids = recordAreaIds(area);
  return {
    detail: adminDestination(ids.detail).pattern,
    list: adminDestination(ids.list).pattern,
  } as RecordAreaPatterns<Area>;
};
