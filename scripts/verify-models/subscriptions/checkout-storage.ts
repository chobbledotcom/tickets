/** Real capacity INSERTs store the attachment; subsequent real edits must not rewrite it. */

import type { ListingBooking } from "#db/attendee-types.ts";
import { buildCapacityCheckedInsert } from "#db/attendees/capacity/checks.ts";
import { executeBatch, queryAll } from "#db/client.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import { settings } from "#db/settings.ts";
import { withSubscriptionPlan } from "#shared/subscriptions/booking-plan.ts";
import type { SubscriptionStart } from "#shared/subscriptions/plan.ts";
import { type CheckoutFacts, expectedVat } from "./checkout-facts.ts";
import type { CheckoutBoundary, CheckoutCase } from "./checkout-provider.ts";
import { seedBooking } from "./environment.ts";

type Stored = {
  id: number;
  attendee_id: number;
  listing_id: number;
  quantity: number;
  recurring_price: number;
  recurring_tax: number;
  recurring_interval: string;
  subscription_id: string;
  subscription_status: string;
};

type ExpectedBooking = {
  attendee: number;
  booking: number;
  listing: number;
  owned: boolean;
  plan: ListingBooking["subscription"];
  quantity: number;
};

/** Seed two people and four distinct booking paths before the real INSERTs. */
const seedPlanBookings = async (
  example: CheckoutCase,
  observed: SubscriptionStart,
): Promise<{
  expected: ExpectedBooking[];
  attendee: number;
  other: number;
}> => {
  const { index, policy, start, quantity } = example;
  const attendee = index * 10 + 3;
  const other = attendee + 1;
  const base = index * 100;
  const control = {
    amount: 333,
    id: `sub_other_${index}`,
    interval: "year",
    status: "canceled",
    tax: 55,
  } as const;
  await seedBooking({
    attendeeId: other,
    id: base,
    listingId: start.listingId,
    plan: control,
    quantity: 1,
  });
  await seedBooking({
    attendeeId: other,
    id: base + 1,
    listingId: start.listingId + 1,
    quantity: 0,
  });
  await executeBatch([
    {
      args: [attendee],
      sql: "INSERT INTO attendees (id, created) VALUES (?, '2026-01-01T00:00:00.000Z')",
    },
    {
      args: [start.listingId, start.listingId + 1],
      sql: "UPDATE listings SET active = 1 WHERE id IN (?, ?)",
    },
  ]);
  const subscribedBooking: ListingBooking = {
    listingId: start.listingId,
    quantity,
  };
  // Each missing ownership predicate must meet its own earlier distractor.
  // The known input object, not the production attachment, names the owner.
  const bookings: ListingBooking[] = [
    { listingId: start.listingId + 1, quantity: 1 },
    { listingId: start.listingId, packageGroupId: 81, quantity: 1 },
    {
      listingId: start.listingId,
      parentListingId: start.listingId + 1,
      quantity: 1,
    },
    subscribedBooking,
  ];
  await executeBatch(
    withSubscriptionPlan(bookings, observed, policy).map((booking) =>
      buildCapacityCheckedInsert(booking, (bind) => bind(attendee)),
    ),
  );
  const rate = policy.mode === "none" ? 0 : policy.rateBasisPoints;
  // The expected row universe is independent of the SELECT. Missing INSERTs
  // stay missing. IDs use SQLite's next row id after the two explicit seeds.
  const expected: ExpectedBooking[] = [
    {
      attendee: other,
      booking: base,
      listing: start.listingId,
      owned: false,
      plan: control,
      quantity: 1,
    },
    {
      attendee: other,
      booking: base + 1,
      listing: start.listingId + 1,
      owned: false,
      plan: undefined,
      quantity: 0,
    },
    ...bookings.map((booking, position) => ({
      attendee,
      booking: base + 2 + position,
      listing: booking.listingId,
      owned: booking === subscribedBooking,
      plan:
        booking === subscribedBooking
          ? { ...start, tax: expectedVat(start.amount, rate) }
          : undefined,
      quantity: booking.quantity ?? 1,
    })),
  ];
  return { attendee, expected, other };
};

/** A stored row keeps its own person, listing and quantity before plan checks. */
const storedPlanFact = (
  row: Stored,
  reference: ExpectedBooking,
  scenario: string,
  stage: string,
): CheckoutFacts["plans"][number] => {
  if (
    row.attendee_id !== reference.attendee ||
    row.listing_id !== reference.listing ||
    row.quantity !== reference.quantity
  )
    throw new Error("Stored checkout row changed its identity");
  return {
    amount: row.recurring_price,
    attempt: 1,
    attendee: row.attendee_id,
    booking: row.id,
    expectedAmount: reference.plan?.amount ?? 0,
    expectedInterval: reference.plan?.interval ?? "",
    expectedStatus: reference.plan?.status ?? "",
    expectedSubscription: reference.plan?.id ?? "",
    expectedTax: reference.plan?.tax ?? 0,
    identity: `${scenario}-${stage}-${row.id}`,
    interval: row.recurring_interval,
    listing: row.listing_id,
    owned: reference.owned,
    quantity: row.quantity,
    scenario,
    stage,
    status: row.subscription_status,
    subscription: row.subscription_id,
    tax: row.recurring_tax,
  };
};

/** Missing or extra rows are extraction failures, never replacement defaults. */
const readPlanBookings = async (
  expected: ExpectedBooking[],
  attendee: number,
  other: number,
  scenario: string,
  stage: string,
): Promise<CheckoutFacts["plans"]> => {
  const rows = await queryAll<Stored>(
    "SELECT id, attendee_id, listing_id, quantity, recurring_price, recurring_tax, recurring_interval, subscription_id, subscription_status FROM listing_attendees WHERE attendee_id IN (?, ?) ORDER BY id",
    [attendee, other],
  );
  if (rows.length !== expected.length)
    throw new Error("Stored checkout row coverage is incomplete");
  return rows.map((row) => {
    const reference = expected.find((entry) => entry.booking === row.id);
    if (reference === undefined)
      throw new Error("Unexpected stored checkout booking");
    return storedPlanFact(row, reference, scenario, stage);
  });
};

export const observePlans = async (
  example: CheckoutCase,
  observed: SubscriptionStart,
  boundary: CheckoutBoundary,
): Promise<{ facts: CheckoutFacts["plans"]; universe: string[] }> => {
  const { expected, attendee, other } = await seedPlanBookings(
    example,
    observed,
  );
  const facts: CheckoutFacts["plans"] = [];
  const universe: string[] = [];
  for (const stage of ["stored", "edited"] as const) {
    if (stage === "edited") {
      await executeBatch([
        await rawListingsTable.updateStatement(example.start.listingId, {
          recurringInterval: "week",
          recurringPrice: 9999,
        }),
      ]);
      await settings.update.tax({
        mode: "add_to_total",
        rateBasisPoints: 5000,
      });
      await boundary.stored?.();
    }
    universe.push(
      ...expected.map((row) => `${example.scenario}-${stage}-${row.booking}`),
    );
    facts.push(
      ...(await readPlanBookings(
        expected,
        attendee,
        other,
        example.scenario,
        stage,
      )),
    );
  }
  return { facts, universe };
};
