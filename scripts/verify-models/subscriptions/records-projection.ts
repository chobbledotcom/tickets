/** Subscriber projection is one row per stored booking, not per provider id.
 * The expected universe is built from seed inputs before either production read.
 * No rendered page, role, label, link, or personal-data claim is made here.
 */
import * as v from "valibot";
import { executeBatch } from "#db/client.ts";
import {
  getSubscribedRowOrNull,
  getSubscribedRows,
  type SubscribedRow,
} from "#db/subscriptions.ts";
import {
  RecurringIntervalSchema,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";
import { seedBooking } from "./environment.ts";
import { type RecordFacts, recordPlanObservation } from "./records-facts.ts";

const projection = (
  row: SubscribedRow,
  slot: number,
  singleMatches: boolean,
): RecordFacts["observed"][number] => ({
  ...recordPlanObservation(row),
  attempt: 1,
  attendee: row.attendee_id,
  booking: row.id,
  listing: row.listing_id,
  pass: 1,
  quantity: row.quantity,
  scenario: "subscriber-universe",
  singleMatches,
  slot,
  status: row.subscription_status,
});

/** Only a boundary validation error counts as the expected loud refusal. */
const rejectsInvalidPlan = (read: () => Promise<unknown>): Promise<boolean> =>
  read().then(
    () => false,
    (error: unknown) => {
      if (!(error instanceof v.ValiError)) throw error;
      return true;
    },
  );

export const projectionFacts = async (beforeRead?: () => Promise<void>) => {
  const universe: SubscribedRow[] = [];
  for (const [
    statusIndex,
    status,
  ] of SubscriptionStatusSchema.options.entries()) {
    for (const [quantityIndex, quantity] of [0, 1, 3].entries()) {
      const id = statusIndex * 3 + quantityIndex + 1;
      const interval = RecurringIntervalSchema.options[quantityIndex]!;
      const plan = {
        amount: 731 + id,
        id: id <= 2 ? "sub_shared" : `sub_${id}`,
        interval,
        status,
        tax: 113,
      };
      const attendeeId = (id % 2) + 1;
      const listingId = (id % 2) + 11;
      await seedBooking({ attendeeId, id, listingId, plan, quantity });
      // Different dates give each stored row a distinct slot on the same listing.
      await executeBatch([
        {
          args: [`2026-03-${String(id).padStart(2, "0")}T00:00:00Z`, id],
          sql: "UPDATE listing_attendees SET start_at = ? WHERE id = ?",
        },
      ]);
      universe.push({
        attendee_id: attendeeId,
        id,
        listing_id: listingId,
        quantity,
        recurring_interval: interval,
        recurring_price: plan.amount,
        recurring_tax: plan.tax,
        subscription_id: plan.id,
        subscription_status: status,
      });
    }
  }
  for (const [id, attendeeId, listingId, quantity] of [
    [101, 1, 21, 0],
    [102, 2, 22, 3],
  ] as const)
    await seedBooking({ attendeeId, id, listingId, quantity });
  if (beforeRead) await beforeRead();
  const expected = universe
    .toSorted((left, right) => right.id - left.id)
    .map((row, index) => projection(row, index + 1, true));
  const observed: RecordFacts["observed"] = [];
  for (const [index, row] of (await getSubscribedRows()).entries()) {
    const single = await getSubscribedRowOrNull(row.id);
    observed.push(
      projection(
        row,
        index + 1,
        JSON.stringify(single) === JSON.stringify(row),
      ),
    );
  }
  // Ordinary and absent single reads must not invent a subscription.
  for (const id of [101, 102, 987654]) {
    if ((await getSubscribedRowOrNull(id)) !== null)
      throw new Error(`Unexpected subscribed row ${id}`);
  }
  const invalid: RecordFacts["invalid"] = [];
  await seedBooking({
    attendeeId: 2,
    id: 999,
    listingId: 99,
    plan: {
      amount: 731,
      id: "sub_invalid",
      interval: "month",
      status: "active",
      tax: 113,
    },
    quantity: 0,
  });
  for (const [scenario, interval, status] of [
    ["missing-interval", "", "active"],
    ["invalid-interval", "fortnight", "active"],
    ["missing-status", "month", ""],
    ["invalid-status", "month", "unknown"],
  ]) {
    await executeBatch([
      {
        args: [interval!, status!],
        sql: "UPDATE listing_attendees SET recurring_interval = ?, subscription_status = ? WHERE id = 999",
      },
    ]);
    invalid.push({
      attempt: 1,
      listThrows: await rejectsInvalidPlan(getSubscribedRows),
      pass: 1,
      scenario: scenario!,
      singleThrows: await rejectsInvalidPlan(() => getSubscribedRowOrNull(999)),
    });
  }
  return { expected, invalid, observed };
};
