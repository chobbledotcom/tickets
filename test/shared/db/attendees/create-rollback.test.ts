import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { revenueAccount } from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import {
  createAttendeeAtomic,
  createBookingAtomic,
} from "#shared/db/attendees/api.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  getContactRecord,
  getVisits,
  hashEmail,
} from "#shared/db/contact-preferences.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  decryptSessionTokens,
  isSessionProcessed,
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { seedOrderActivity } from "#test-utils/contact-tokens.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectProcessedPaymentReference } from "#test-utils/processed-payments.ts";

const OCCURRED_AT = "2026-07-15T00:00:00.000Z";

const pricedOrder = (
  listingId: number,
  total: number,
  modifierApplications: PricedOrder["modifierApplications"] = [],
): PricedOrder => ({
  extras: [],
  fullSubtotal: total,
  lines: [
    {
      chargedUnitAmount: total,
      item: {
        listingId,
        name: "Rollback listing",
        quantity: 1,
        slug: "rollback-listing",
        unitPrice: total,
      },
      quantity: 1,
    },
  ],
  modifierApplications,
  total,
});

const paidPlan = async (
  listingId: number,
  sessionId: string,
  ticketTotal = 500,
  modifierApplications: PricedOrder["modifierApplications"] = [],
) =>
  bookingBatchPlan(
    modifierApplications,
    {
      eventId: sessionId,
      occurredAt: OCCURRED_AT,
      pricedOrder: pricedOrder(listingId, ticketTotal, modifierApplications),
    },
    { paymentReference: `pi_${sessionId}`, sessionId },
  );

const input = (
  bookings: { listingId: number; pricePaid: number; quantity: number }[],
  ticketToken: string,
) => ({
  bookings,
  email: "atomic@example.com",
  name: "Atomic",
  paymentId: "pi_atomic",
  ticketToken,
});

const expectNoContactActivity = async (): Promise<void> => {
  expect(await getVisits(await hashEmail("atomic@example.com"))).toBe(0);
};

const attendeeCount = async (): Promise<number> =>
  Number(
    (await queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attendees",
      [],
    ))!.count,
  );

const expectParentRolledBack = async (
  ticketToken: string,
  countBefore: number,
): Promise<void> => {
  const tokenRow = await queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM attendees WHERE ticket_token_index = ?",
    [await computeTicketTokenIndex(ticketToken)],
  );
  expect(Number(tokenRow!.count)).toBe(0);
  expect(await attendeeCount()).toBe(countBefore);
};

describeWithEnv("db > attendee create rollback", { db: true }, () => {
  test("rolls back an open cart line when a later capacity check fails", async () => {
    const open = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    const full = await createTestListing({ maxAttendees: 0, unitPrice: 500 });

    const countBefore = await attendeeCount();
    const ticketToken = "stable-partial";
    const result = await createBookingAtomic(
      input(
        [
          { listingId: open.id, pricePaid: 500, quantity: 1 },
          { listingId: full.id, pricePaid: 500, quantity: 1 },
        ],
        ticketToken,
      ),
      await bookingBatchPlan([], {
        eventId: "partial",
        occurredAt: OCCURRED_AT,
        pricedOrder: {
          ...pricedOrder(open.id, 1000),
          lines: [
            pricedOrder(open.id, 500).lines[0]!,
            pricedOrder(full.id, 500).lines[0]!,
          ],
        },
      }),
    );

    expect(result).toEqual({ reason: "capacity_exceeded", success: false });
    expect(await getAttendeesRaw(open.id)).toEqual([]);
    expect(await getAttendeesRaw(full.id)).toEqual([]);
    await expectParentRolledBack(ticketToken, countBefore);
    await expectNoContactActivity();
  });

  test("rolls back modifier, ledger, contact, and attendee when finalize is missing", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 100,
      direction: "charge",
      name: "Atomic add-on",
      stock: 2,
    });
    const application = {
      amountApplied: 100,
      delta: 100,
      modifierId: modifier.id,
      name: "Atomic add-on",
      quantity: 1,
      scopedSubtotal: 500,
    };

    const countBefore = await attendeeCount();
    const ticketToken = "stable-missing-finalize";
    await expect(
      createBookingAtomic(
        input(
          [{ listingId: listing.id, pricePaid: 600, quantity: 1 }],
          ticketToken,
        ),
        await paidPlan(listing.id, "missing-finalize", 600, [application]),
      ),
    ).rejects.toThrow("processed_payments.processed_at");

    expect(await getAttendeesRaw(listing.id)).toEqual([]);
    expect(await modifierUsedQuantities([modifier.id])).toEqual(new Map());
    expect(await allTransfers()).toEqual([]);
    expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
    await expectParentRolledBack(ticketToken, countBefore);
    await expectNoContactActivity();
  });

  test("rolls back when finalize finds an already-resolved session", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    await reserveSession("resolved-finalize");
    await markSessionFailed("resolved-finalize", { error: "Already failed." });

    const countBefore = await attendeeCount();
    const ticketToken = "stable-resolved-finalize";
    await expect(
      createBookingAtomic(
        input(
          [{ listingId: listing.id, pricePaid: 500, quantity: 1 }],
          ticketToken,
        ),
        await paidPlan(listing.id, "resolved-finalize"),
      ),
    ).rejects.toThrow("processed_payments.processed_at");

    expect(await getAttendeesRaw(listing.id)).toEqual([]);
    expect(await allTransfers()).toEqual([]);
    await expectParentRolledBack(ticketToken, countBefore);
    await expectNoContactActivity();
  });

  test("propagates an unrelated unique-token database error", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const stableInput = input(
      [{ listingId: first.id, pricePaid: 0, quantity: 1 }],
      "stable-db-error",
    );
    expect((await createAttendeeAtomic(stableInput)).success).toBe(true);

    await expect(
      createAttendeeAtomic({
        ...stableInput,
        bookings: [{ listingId: second.id, pricePaid: 0, quantity: 1 }],
      }),
    ).rejects.toThrow("UNIQUE constraint");

    expect(await getAttendeesRaw(first.id)).toHaveLength(1);
    expect(await getAttendeesRaw(second.id)).toEqual([]);
    expect(await getVisits(await hashEmail("atomic@example.com"))).toBe(1);
  });

  test("stores the stable token during finalize and replays contact activity once", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const sessionId = "stable-token-finalize";
    const ticketToken = "stable-contact-token";
    await reserveSession(sessionId);

    const result = await createBookingAtomic(
      input(
        [{ listingId: listing.id, pricePaid: 500, quantity: 1 }],
        ticketToken,
      ),
      await paidPlan(listing.id, sessionId),
    );
    if (result === "sold-out" || !result.success) {
      throw new Error("expected finalized booking");
    }
    expect(result.attendees).toHaveLength(1);
    const created = result.attendees[0]!;
    expect(created.ticket_token).toBe(ticketToken);
    expect(created.payment_id).toBe("pi_atomic");

    const session = await isSessionProcessed(sessionId);
    expect(session!.attendee_id).toBe(created.id);
    expect(await decryptSessionTokens(session!.ticket_tokens)).toBe(
      ticketToken,
    );
    const privateKey = await getTestPrivateKey();
    await expectProcessedPaymentReference(
      created.id,
      sessionId,
      `pi_${sessionId}`,
      privateKey,
    );
    const rawBeforeReplay = await getAttendeesRaw(listing.id);
    const [decrypted] = await decryptAttendees(rawBeforeReplay, privateKey);
    expect({
      id: decrypted!.id,
      paymentId: decrypted!.payment_id,
      ticketToken: decrypted!.ticket_token,
    }).toEqual({ id: created.id, paymentId: "pi_atomic", ticketToken });
    const contactHash = await hashEmail("atomic@example.com");
    const beforeReplay = await getContactRecord(contactHash, privateKey);
    expect(beforeReplay.visits).toBe(1);
    expect(beforeReplay.publicBookingCount).toBe(1);
    await seedOrderActivity("atomic@example.com", "", "public", ticketToken);
    const record = await getContactRecord(contactHash, privateKey);
    expect(record.visits).toBe(1);
    expect(record.publicBookingCount).toBe(1);
    expect(await getAttendeesRaw(listing.id)).toEqual(rawBeforeReplay);
  });
});
