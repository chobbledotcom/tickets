/** A registration activity write that rejects inside a create batch must
 *  roll the whole booking back — booking, answers, stock, ledger, and
 *  contact-source — on every atomic strategy, and queue no sends: the caller
 *  never sees a committed booking to notify about. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { revenueAccount } from "#accounting/accounts.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import { hmacHash } from "#crypto/hashing.ts";
import {
  bookingActivityStatements,
  sealBookedActivities,
} from "#db/activity-log.ts";
import {
  createAttendeeAtomicImpl as createAttendeeAtomic,
  createBookingAtomic,
} from "#db/attendees/create.ts";
import type { BatchTail } from "#db/attendees/create-batch.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute, queryOne } from "#db/client.ts";
import { getVisits, hashEmail } from "#db/contact-preferences.ts";
import { modifierUsedQuantities } from "#db/modifier-usage.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { bookedAnswersTail } from "#db/questions/attendee-answers/at-booking.ts";
import {
  groupListingAnswerSets,
  prepareAttendeeAnswerSave,
} from "#db/questions/attendee-answers/save.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { registeredActivityMessage } from "#shared/webhook/delivery.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectFetchSilent } from "#test-utils/mocks.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";
import type { ListingWithCount } from "#types";

const OCCURRED_AT = "2026-07-15T00:00:00.000Z";

const pricedOrder = (
  listing: ListingWithCount,
  modifierApplications: PricedOrder["modifierApplications"] = [],
): PricedOrder => ({
  extras: [],
  fullSubtotal: 500,
  lines: [
    {
      chargedUnitAmount: 500,
      item: {
        listingId: listing.id,
        name: listing.name,
        quantity: 1,
        slug: listing.slug,
        unitPrice: 500,
      },
      quantity: 1,
    },
  ],
  modifierApplications,
  total: 500,
});

const input = (listingId: number, ticketToken: string) => ({
  bookings: [{ listingId, pricePaid: 500, quantity: 1 }],
  email: "activity-fault@example.com",
  name: "Activity Fault",
  paymentId: "pi_activity-fault",
  ticketToken,
});

/** The answers tail and the registration activities, assembled exactly the
 *  way the free path's creation tail assembles them. */
const answersAndActivitiesTail = async (
  listing: ListingWithCount,
): Promise<BatchTail> => {
  const question = await questionsTable.insert({
    displayType: "free_text",
    text: "Anything to add?",
  });
  const answer = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: "Fault answer",
  });
  await execute(
    "INSERT INTO listing_questions (listing_id, question_id, sort_order) VALUES (?, ?, 0)",
    [listing.id, question.id],
  );
  const answersTail = bookedAnswersTail(
    await prepareAttendeeAnswerSave(
      groupListingAnswerSets(
        [{ attendee: { id: 0 }, listing: { id: listing.id } }],
        { [String(listing.id)]: [answer.id] },
        {},
      ),
    ),
    [listing.id],
  );
  const sealed = await sealBookedActivities([
    {
      listing,
      message: registeredActivityMessage(listing.name),
    },
  ]);
  return (tokenIndex: string) => [
    ...answersTail(tokenIndex),
    ...bookingActivityStatements(sealed, tokenIndex),
  ];
};

const installRejectingTrigger = async (): Promise<void> => {
  await execute(
    `CREATE TRIGGER reject_activity_insert
     BEFORE INSERT ON activity_log
     BEGIN
       SELECT RAISE(ABORT, 'activity write rejected');
     END`,
    [],
  );
};

const dropRejectingTrigger = async (): Promise<void> => {
  await execute("DROP TRIGGER IF EXISTS reject_activity_insert", []);
};

/** Runs one create attempt under the rejecting activity trigger and asserts
 *  that every write rolled back and no send left the process. */
const expectRolledBack = async (
  listing: ListingWithCount,
  ticketToken: string,
  modifierId: number | null,
  attempt: () => Promise<unknown>,
): Promise<void> => {
  await installRejectingTrigger();
  try {
    await expectFetchSilent(async () =>
      expect(attempt()).rejects.toThrow("activity write rejected"),
    );
  } finally {
    await dropRejectingTrigger();
  }
  await expectNothingCommitted(listing, ticketToken, modifierId);
};

const expectNothingCommitted = async (
  listing: ListingWithCount,
  ticketToken: string,
  modifierId: number | null,
): Promise<void> => {
  expect(await getAttendeesRaw(listing.id)).toEqual([]);
  const tokenRow = await queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM attendees WHERE ticket_token_index = ?",
    [await hmacHash(ticketToken)],
  );
  expect(Number(tokenRow!.count)).toBe(0);
  expect(await getVisits(await hashEmail("activity-fault@example.com"))).toBe(
    0,
  );
  if (modifierId !== null) {
    expect(await modifierUsedQuantities([modifierId])).toEqual(new Map());
  }
  expect(await allTransfers()).toEqual([]);
  expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
};

describeWithEnv("db > registration activity write faults", { db: true }, () => {
  test("rolls the plain free strategy back and queues no sends", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const ride = await answersAndActivitiesTail(listing);
    await expectRolledBack(listing, "tok-free-plain", null, () =>
      createAttendeeAtomic(
        input(listing.id, "tok-free-plain"),
        undefined,
        ride,
      ),
    );
  });

  test("rolls the ledger free strategy back and queues no sends", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const ride = await answersAndActivitiesTail(listing);
    await expectRolledBack(listing, "tok-free-ledger", null, async () =>
      createBookingAtomic(
        input(listing.id, "tok-free-ledger"),
        await bookingBatchPlan([], {
          eventId: "evt-free-ledger",
          occurredAt: OCCURRED_AT,
          pricedOrder: pricedOrder(listing),
        }),
        ride,
      ),
    );
  });

  test("rolls the paid strategy back and queues no sends", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 100,
      direction: "charge",
      name: "Fault add-on",
      stock: 2,
    });
    const ride = await answersAndActivitiesTail(listing);
    // The finalize statement reads processed_at off the session's own
    // reservation, so the session is reserved before the fault: the failing
    // statement this test pins is the registration activity insert.
    await reserveSession("evt-paid-fault");
    await expectRolledBack(listing, "tok-paid", modifier.id, async () =>
      createBookingAtomic(
        {
          ...input(listing.id, "tok-paid"),
          paymentId: "pi_activity-fault",
        },
        await bookingBatchPlan(
          [],
          {
            eventId: "evt-paid-fault",
            occurredAt: OCCURRED_AT,
            pricedOrder: pricedOrder(listing, [
              {
                amountApplied: 100,
                delta: 100,
                modifierId: modifier.id,
                name: "Fault add-on",
                quantity: 1,
                scopedSubtotal: 500,
              },
            ]),
          },
          {
            paymentReference: taggedPaymentReference("pi_activity-fault"),
            sessionId: "evt-paid-fault",
          },
        ),
        ride,
      ),
    );
  });
});
