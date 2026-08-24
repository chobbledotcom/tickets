/**
 * The destination ids and path patterns, read back out of the areas table.
 *
 * Every id and pattern in the system comes from here, so a link built with
 * `adminPath` names a route that exists and fills the parameters that route
 * actually has.
 */

import type { ADMIN_AREAS } from "#shared/admin-surface/areas.ts";
import type { RouteParamNames } from "#shared/route-pattern.ts";

type Areas = typeof ADMIN_AREAS;

type ViewsOf<Area> = Area extends { readonly view: infer Group }
  ? Group
  : Record<never, never>;
type WritesOf<Area> = Area extends { readonly write: infer Group }
  ? Group
  : Record<never, never>;

export type AdminAreaId = keyof Areas;

export type AdminDestinationId = {
  [Area in keyof Areas]:
    | keyof ViewsOf<Areas[Area]>
    | keyof WritesOf<Areas[Area]>;
}[keyof Areas] &
  string;

/** The one area entry that declares this id, whichever group it sits in. */
type SpecFor<Id extends AdminDestinationId> = {
  [Area in keyof Areas]: Id extends keyof ViewsOf<Areas[Area]>
    ? ViewsOf<Areas[Area]>[Id]
    : Id extends keyof WritesOf<Areas[Area]>
      ? WritesOf<Areas[Area]>[Id]
      : never;
}[keyof Areas];

/** The path out of one route's entry, whichever of the two forms it took. */
type PatternOfSpec<Spec> = Spec extends string
  ? Spec
  : Spec extends { readonly pattern: infer Pattern }
    ? Pattern
    : never;

/**
 * The exact path a route declares, as a literal type. Route tables keyed by a
 * pattern stay typed because this keeps the string, not `string`.
 *
 * `Id extends unknown` looks like nothing, and is the whole point: it takes
 * each id of a union on its own. Without it a caller holding two ids resolves
 * to `never`, and `AdminPathParams` below then asks for no parameters at all.
 */
export type AdminPatternFor<Id extends AdminDestinationId> = Id extends unknown
  ? PatternOfSpec<SpecFor<Id>>
  : never;

/** The parameter names one route's path carries, or `never` when it carries
 * none. Named so the two checks below read it without repeating the lookup. */
type ParamNamesOf<Id extends AdminDestinationId> = RouteParamNames<
  AdminPatternFor<Id> & string
>;

/**
 * A route addressed by one plain `:id` and nothing else. A section's record
 * page and the form a reader falls back to must both be of this kind, so
 * `entityReturnPath` can build either from the same id.
 *
 * Both directions are checked. A path with no parameter at all resolves to
 * `never`, which is assignable to `"id"`, so the second check alone would let
 * `/admin/` in and build a record link that names no record.
 */
export type AdminRecordDestinationId = {
  [Id in AdminDestinationId]: "id" extends ParamNamesOf<Id>
    ? ParamNamesOf<Id> extends "id"
      ? Id
      : never
    : never;
}[AdminDestinationId];

export type AdminPathParams<Id extends AdminDestinationId> = Record<
  RouteParamNames<AdminPatternFor<Id> & string>,
  string | number
>;
