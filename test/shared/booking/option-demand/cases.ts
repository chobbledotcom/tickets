/**
 * The declared case table for the option-demand suite: the fixtures and the
 * expected answer per case. The helpers that drive one surface live in
 * ./drivers.ts; the suite that runs the table lives in ./surfaces.test.ts.
 */

import type { OptionRefusal } from "#booking/option-refusal.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { FormParams } from "#shared/form-data.ts";
import { nextWeekday, orderDate } from "#test/features/public/order/helpers.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  type BuiltCase,
  choiceForm,
  formFold,
  oneParentCase,
} from "./drivers.ts";
import {
  bookOneUnitTomorrow,
  createEarlyWeekPair,
  createSpanKitPair,
  resolvedChildren,
  ticketInfo,
} from "./fixtures.ts";

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
 * no date, as a listing with no calendar folds. `foldAccepts` marks a case
 * whose fold walk holds but whose form refusal lives in the page's
 * day-count resolution instead. `fold: "explicit-choice"` marks a
 * multi-child option the form books only with a chosen child. */
export type DemandCase = {
  build: () => Promise<BuiltCase>;
  capacityFitsAt?: readonly number[];
  capacityRefuses?: boolean;
  expected: Expectation;
  fold?: "explicit-choice";
  foldAccepts?: boolean;
  foldsDateless?: boolean;
  name: string;
};

/** The fold one case drives, with the form its surface would submit. */
export const foldFor = (
  testCase: DemandCase,
  built: BuiltCase,
  dayCount: number,
) => formFold(built, dayCount, submitFormFor(testCase, built));

/** The form one case's surface submits: the buyer's own choice when the
 * option carries one, else the empty form. */
export const submitFormFor = (
  testCase: DemandCase,
  built: BuiltCase,
): FormParams =>
  testCase.fold === "explicit-choice" ? choiceForm(built) : new FormParams();

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
  {
    async build() {
      // The sole child of the one-day member records one day. Whichever
      // child the buyer picks for the three-day member records three, so
      // the form refuses the mixed durations whatever the choice is.
      const soleChild = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        durationDays: 1,
        maxAttendees: 5,
        name: "Sole Day Kit",
      });
      const soleParent = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 5,
        name: "Sole Day Member",
      });
      await listingChildren.setIds(soleParent.id, [soleChild.id]);
      const choiceKitA = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 3: 1500 },
        durationDays: 3,
        maxAttendees: 5,
        name: "Choice Kit A",
      });
      const choiceKitB = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 3: 1500 },
        durationDays: 3,
        maxAttendees: 5,
        name: "Choice Kit B",
      });
      const choiceParent = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
        name: "Three Day Chooser",
      });
      await listingChildren.setIds(choiceParent.id, [
        choiceKitA.id,
        choiceKitB.id,
      ]);
      return {
        childrenByParentId: await resolvedChildren([
          soleParent.id,
          choiceParent.id,
        ]),
        date: orderDate(),
        parents: [
          await ticketInfo(soleParent.id),
          await ticketInfo(choiceParent.id),
        ],
        quantities: new Map([
          [soleParent.id, 1],
          [choiceParent.id, 1],
        ]),
      };
    },
    expected: { bookable: false, reason: "capacity" },
    name: "a package mixing a sole duration with a chosen duration refuses",
  },
  {
    async build() {
      // The two members share no day count, so the package's page rules
      // offer no span at all.
      const oneDayMember = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        name: "One Day Only Member",
      });
      const twoDayMember = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000 },
        durationDays: 2,
        name: "Two Day Only Member",
      });
      return {
        childrenByParentId: await resolvedChildren([
          oneDayMember.id,
          twoDayMember.id,
        ]),
        date: orderDate(),
        parents: [
          await ticketInfo(oneDayMember.id),
          await ticketInfo(twoDayMember.id),
        ],
        quantities: new Map([
          [oneDayMember.id, 1],
          [twoDayMember.id, 1],
        ]),
      };
    },
    expected: { bookable: false, reason: "span_unsupported" },
    foldAccepts: true,
    name: "a package whose members share no day count refuses",
  },
  {
    async build() {
      // Two members share one sole child with one spot. The first member's
      // fold takes it, and the second member's fold exceeds the child's
      // capacity, so the package refuses through the one fold state.
      const child = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 1,
        name: "Single Spot Kit",
      });
      const memberA = await createTestListing({
        maxAttendees: 5,
        name: "Overdraft Member A",
      });
      await listingChildren.setIds(memberA.id, [child.id]);
      const memberB = await createTestListing({
        maxAttendees: 5,
        name: "Overdraft Member B",
      });
      await listingChildren.setIds(memberB.id, [child.id]);
      return {
        childrenByParentId: await resolvedChildren([memberA.id, memberB.id]),
        date: orderDate(),
        parents: [await ticketInfo(memberA.id), await ticketInfo(memberB.id)],
        quantities: new Map([
          [memberA.id, 1],
          [memberB.id, 1],
        ]),
      };
    },
    expected: { bookable: false, reason: "capacity" },
    name: "a package whose members overdraw one sole child refuses",
  },
];

/** The cases whose date refusal disappears in the form's date-less render
 * phase. */
export const renderPhaseCases = [6, 4, 9] as const;
