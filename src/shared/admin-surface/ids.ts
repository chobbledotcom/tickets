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

/** The exact path a route declares, as a literal type. Route tables keyed by
 * a pattern stay typed because this keeps the string, not `string`. */
export type AdminPatternFor<Id extends AdminDestinationId> =
  SpecFor<Id> extends string
    ? SpecFor<Id>
    : SpecFor<Id> extends { readonly pattern: infer Pattern }
      ? Pattern
      : never;

export type AdminPathParams<Id extends AdminDestinationId> = Record<
  RouteParamNames<AdminPatternFor<Id> & string>,
  string | number
>;
