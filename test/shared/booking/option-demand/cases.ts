/**
 * The declared case table for the option-demand suite: the fixtures, the
 * helpers that drive one surface, and the expected answer per case. The
 * suite that runs the table lives in ./surfaces.test.ts.
 */

import { buildBookingTree } from "#booking/build-tree.ts";
import { foldBookingTree, resolvedByNodeKey } from "#booking/fold-tree.ts";
import { requiredMapValue } from "#fp";
import {
  buildTicketListing,
  type ChildrenByParent,
  type TicketListing,
} from "#booking/model.ts";
import type {
  OptionDemandQuestion,
  OptionRefusal,
} from "#booking/option-demand.ts";
import { childQuantityFieldName } from "#booking/tree.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { loadChildrenByParentId } from "#routes/public/child-listings.ts";
import { addDays } from "#shared/dates.ts";
import { FormParams } from "#shared/form-data.ts";
import { nextWeekday, orderDate } from "#test/features/public/order/helpers.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

/** The availability-resolved listing row one fixture id stands for. */
const ticketInfo = async (id: number): Promise<TicketListing> =>
  buildTicketListing((await getListingWithCount(id))!, false, undefined);

/** The children of one parent set, availability-resolved. */
const resolvedChildren = async (
  parentIds: number[],
): Promise<ChildrenByParent> => {
  const infos = await Promise.all(parentIds.map(ticketInfo));
  return loadChildrenByParentId(infos);
};

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

/** What the surfaces must answer for one case. Child units name their
 * listing, because fixture ids differ per run. */
export type Expectation =
  | { bookable: true; childUnits: [string, number][]; dayCounts: number[] }
  | { bookable: false; reason: OptionRefusal };

/** One declared case: an option (its parents and quantities) judged at a
 * date. `capacityRefuses` marks a case the fold accepts but the per-date
 * capacity refuses — the gallery's pools refuse the same demand, pinned
 * end-to-end by the /order/availability suite. `capacityFitsAt` names the
 * bookable spans whose bookings still fit the pools, when a shorter span
 * escapes the refusal. `foldsDateless` marks a case whose fold holds with
 * no date, as a listing with no calendar folds. `fold: "explicit-choice"`
 * marks a multi-child option the form books only with a chosen child. */
export type DemandCase = {
  build: () => Promise<BuiltCase>;
  capacityFitsAt?: readonly number[];
  capacityRefuses?: boolean;
  expected: Expectation;
  fold?: "explicit-choice";
  foldsDateless?: boolean;
  name: string;
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
const choiceForm = (built: BuiltCase): FormParams => {
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

/** The fold one case drives, with the form its surface would submit. */
export const foldFor = (
  testCase: DemandCase,
  built: BuiltCase,
  dayCount: number,
) =>
  formFold(
    built,
    dayCount,
    testCase.fold === "explicit-choice" ? choiceForm(built) : new FormParams(),
  );

/** The fixtures for one option that books one parent at its minimum: the
 * parent's children resolved, judged at `date`. */
const oneParentCase = async (
  parentId: number,
  date: string | null,
): Promise<BuiltCase> => ({
  childrenByParentId: await resolvedChildren([parentId]),
  date,
  parents: [await ticketInfo(parentId)],
  quantities: new Map([[parentId, 1]]),
});

/** Books one unit of a listing for one day on the day after the order date,
 * the way the capacity fixtures drain one date's pool. */
const bookOneUnitTomorrow = async (listingId: number): Promise<void> => {
  await bookAttendee(
    { id: listingId },
    {
      date: addDays(orderDate(), 1),
      durationDays: 1,
    },
  );
};

/** A fixed three-day parent whose sole customisable child prices 1-3 days
 * with one spot. */
export const createSpanKitPair = async () => {
  const child = await createDailyTestListing({
    customisableDays: true,
    dayPrices: { 1: 500, 2: 900, 3: 1200 },
    durationDays: 3,
    maxAttendees: 1,
    name: "Span Kit",
  });
  const parent = await createDailyTestListing({
    durationDays: 3,
    name: "Three Day Trip",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

/** A fixed three-day weekday parent whose sole customisable child serves
 * early weekdays only. */
export const createEarlyWeekPair = async () => {
  const child = await createDailyTestListing({
    bookableDays: ["Monday", "Tuesday", "Wednesday"],
    customisableDays: true,
    dayPrices: { 1: 500, 2: 900, 3: 1200 },
    durationDays: 3,
    name: "Early Week Kit",
  });
  const parent = await createDailyTestListing({
    durationDays: 3,
    name: "Weekday Trip",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

export const CASES: DemandCase[] = [
  {
    async build() {
      const parent = await createTestListing({ name: "Plain Trip" });
      return oneParentCase(parent.id, orderDate());
    },
    expected: { bookable: true, childUnits: [], dayCounts: [1] },
    name: "a childless standard parent books one day",
  },
  {
    async build() {
      const child = await createTestListing({
        maxAttendees: 1,
        name: "Sole Kit",
      });
      const parent = await createTestListing({ name: "Sole Parent" });
      await listingChildren.setIds(parent.id, [child.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: {
      bookable: true,
      childUnits: [["Sole Kit", 1]],
      dayCounts: [1],
    },
    name: "a parent auto-fills its sole bookable child",
  },
  {
    async build() {
      const child = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        durationDays: 1,
        maxAttendees: 1,
        name: "Single Day Kit",
      });
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 2000, 3: 3000 },
        durationDays: 3,
        name: "Flexible Trip",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: {
      bookable: true,
      childUnits: [["Single Day Kit", 1]],
      dayCounts: [1],
    },
    name: "a customisable parent folds its child at the one span the child serves",
  },
  {
    async build() {
      const { child, parent } = await createSpanKitPair();
      await bookOneUnitTomorrow(child.id);
      return oneParentCase(parent.id, orderDate());
    },
    capacityRefuses: true,
    expected: {
      bookable: true,
      childUnits: [["Span Kit", 1]],
      dayCounts: [1],
    },
    name: "a fixed parent folds its customisable child over the parent's span",
  },
  {
    async build() {
      const { parent } = await createEarlyWeekPair();
      return oneParentCase(parent.id, nextWeekday(orderDate(), "Wednesday"));
    },
    expected: { bookable: false, reason: "date_unsupported" },
    name: "a child that cannot hold the parent's span refuses the start date",
  },
  {
    async build() {
      const { parent } = await createEarlyWeekPair();
      return oneParentCase(parent.id, nextWeekday(orderDate(), "Monday"));
    },
    expected: {
      bookable: true,
      childUnits: [["Early Week Kit", 1]],
      dayCounts: [1],
    },
    name: "a child that holds the whole span keeps the option bookable",
  },
  {
    async build() {
      const child = await createDailyTestListing({
        maximumDaysAfter: 1,
        name: "Near Day Kit",
      });
      const parent = await createTestListing({ name: "Far Date Parent" });
      await listingChildren.setIds(parent.id, [child.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: { bookable: false, reason: "date_unsupported" },
    name: "a child whose calendar refuses the start date refuses the option",
  },
  {
    async build() {
      const child = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
        name: "Two Day Kit",
      });
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000 },
        durationDays: 2,
        name: "Two Day Trip",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: {
      bookable: true,
      childUnits: [["Two Day Kit", 1]],
      dayCounts: [2],
    },
    name: "a parent pricing one span charges its child at that span",
  },
  {
    async build() {
      const kit = await createTestListing({
        maxAttendees: 1,
        name: "Chosen Kit",
      });
      const spare = await createTestListing({
        maxAttendees: 5,
        name: "Spare Kit",
      });
      const parent = await createTestListing({ name: "Chooser" });
      await listingChildren.setIds(parent.id, [kit.id, spare.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: { bookable: true, childUnits: [], dayCounts: [1] },
    fold: "explicit-choice",
    name: "several bookable children leave the choice to the buyer",
  },
  {
    async build() {
      // A standard listing that prices day counts: no calendar, so the fold
      // never demands a date for it.
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        maxAttendees: 1,
        name: "Priced Standard Kit",
      });
      const parent = await createTestListing({ name: "Standard Parent" });
      await listingChildren.setIds(parent.id, [child.id]);
      return oneParentCase(parent.id, orderDate());
    },
    expected: {
      bookable: true,
      childUnits: [["Priced Standard Kit", 1]],
      dayCounts: [1],
    },
    foldsDateless: true,
    name: "a standard child that prices day counts folds without a date",
  },
  {
    async build() {
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000 },
        durationDays: 2,
        maxAttendees: 1,
        name: "Two Day Lone Trip",
      });
      await bookOneUnitTomorrow(parent.id);
      return oneParentCase(parent.id, orderDate());
    },
    capacityRefuses: true,
    expected: { bookable: true, childUnits: [], dayCounts: [2] },
    name: "a childless two-day parent reads its second day's shortage",
  },
  {
    async build() {
      const child = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 500, 2: 900 },
        durationDays: 2,
        maxAttendees: 1,
        name: "Short Fits Kit",
      });
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 2000 },
        durationDays: 2,
        name: "Short Fits Trip",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      // The child is full on the second day: only the one-day booking fits.
      await bookOneUnitTomorrow(child.id);
      return oneParentCase(parent.id, orderDate());
    },
    capacityFitsAt: [1],
    expected: {
      bookable: true,
      childUnits: [["Short Fits Kit", 1]],
      dayCounts: [1, 2],
    },
    name: "a child full on the later day keeps the shorter booking",
  },
  {
    async build() {
      const shortChild = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        durationDays: 1,
        maxAttendees: 5,
        name: "One Day Member Kit",
      });
      const shortParent = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 5,
        name: "One Day Member",
      });
      await listingChildren.setIds(shortParent.id, [shortChild.id]);
      const longChild = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 3: 1500 },
        durationDays: 3,
        maxAttendees: 5,
        name: "Three Day Member Kit",
      });
      const longParent = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
        name: "Three Day Member",
      });
      await listingChildren.setIds(longParent.id, [longChild.id]);
      return {
        childrenByParentId: await resolvedChildren([
          shortParent.id,
          longParent.id,
        ]),
        date: orderDate(),
        parents: [
          await ticketInfo(shortParent.id),
          await ticketInfo(longParent.id),
        ],
        quantities: new Map([
          [shortParent.id, 1],
          [longParent.id, 1],
        ]),
      };
    },
    expected: { bookable: false, reason: "capacity" },
    name: "a package whose members inherit different durations refuses",
  },
];

/** The cases whose date refusal disappears in the form's date-less render
 * phase. */
export const renderPhaseCases = [6, 4, 9] as const;
