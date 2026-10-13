/**
 * The drivers the option-demand suite runs its declared cases with: the
 * judge's question for one case, the booking form's own fold, and the
 * fixture helpers that build one option. The declared table lives in
 * ./cases.ts; the suite that runs the table lives in ./surfaces.test.ts.
 */

import { buildBookingTree } from "#booking/build-tree.ts";
import { foldBookingTree, resolvedByNodeKey } from "#booking/fold-tree.ts";
import type { ChildrenByParent, TicketListing } from "#booking/model.ts";
import type { OptionDemandQuestion } from "#booking/option-demand.ts";
import { childQuantityFieldName } from "#booking/tree.ts";
import { requiredMapValue } from "#fp";
import { FormParams } from "#shared/form-data.ts";
import { resolvedChildren, ticketInfo } from "./fixtures.ts";

/** The entries of a units map, in a stable order for equality. */
export const sortedEntries = (
  map: ReadonlyMap<number, number>,
): [number, number][] => [...map].sort(([left], [right]) => left - right);

/** The fixtures one case builds. */
export type BuiltCase = {
  childrenByParentId: ChildrenByParent;
  date: string | null;
  parents: TicketListing[];
  quantities: Map<number, number>;
};

/** The listing's name, which every fixture knows. */
export const nameOf = (built: BuiltCase, listingId: number): string => {
  const found = [
    ...built.parents,
    ...[...built.childrenByParentId.values()].flat(),
  ].find((info) => info.listing.id === listingId);
  if (found === undefined) throw new Error(`Unknown listing ${listingId}`);
  return found.listing.name;
};

/** The judge's question for one case's fixtures. */
export const questionFor = (built: BuiltCase): OptionDemandQuestion => ({
  childrenByParentId: built.childrenByParentId,
  date: built.date,
  holidays: [],
  isPackage: false,
  parents: built.parents,
  quantities: built.quantities,
});

/** The booking form's own fold for one option. The default form is the empty
 * one the gallery's pre-fill produces (a sole bookable child auto-fills). */
export const formFold = (
  built: BuiltCase,
  dayCount: number,
  form = new FormParams(),
) => {
  const tree = buildBookingTree({
    childrenByParentId: built.childrenByParentId,
    listings: built.parents,
    slugs: built.parents.map((parent) => parent.listing.slug),
  });
  const resolved = resolvedByNodeKey(
    built.parents,
    built.childrenByParentId,
    tree,
  );
  return foldBookingTree(
    tree,
    resolved,
    form,
    {
      customPrices: new Map(),
      date: built.date,
      dayCount,
      hasCustomisable: built.parents.some(
        (parent) => parent.listing.customisable_days,
      ),
      quantities: built.quantities,
    },
    [],
  );
};

/** A form that names one child of the option's parent, as the buyer's
 * selector would. */
export const choiceForm = (built: BuiltCase): FormParams => {
  const parent = built.parents[0]!;
  const child = built.childrenByParentId.get(parent.listing.id)![0]!;
  return new FormParams([
    [
      childQuantityFieldName(parent.listing.id, child.listing.id),
      String(
        requiredMapValue(
          built.quantities,
          parent.listing.id,
          "A case's choice form needs its parent quantity",
        ),
      ),
    ],
  ]);
};

/** The fixtures for one option that books one parent at its minimum: the
 * parent's children resolved, judged at `date`. */
export const oneParentCase = async (
  parentId: number,
  date: string | null,
): Promise<BuiltCase> => ({
  childrenByParentId: await resolvedChildren([parentId]),
  date,
  parents: [await ticketInfo(parentId)],
  quantities: new Map([[parentId, 1]]),
});
