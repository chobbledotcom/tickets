import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  alreadyProcessedResult,
  bookingSlot,
  createAttendeeForSession,
  logPromoCodeModifiers,
  pairEntriesByListing,
} from "#routes/api/payment-processing/create.ts";
import { specForFailure } from "#routes/api/payment-processing/store-refund.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { queryAll } from "#shared/db/client.ts";
import type {
  CheckoutIntent,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount, webhookMeta } from "#test-utils/factories.ts";

/** A validated item carries a listing (the only field the pairing reads). */
const item = (id: number) => ({ listing: testListingWithCount({ id }) });
/** A created booking row — the pairing keys on its `listing_id`. */
const row = (listing_id: number) => ({ listing_id });

describe("pairEntriesByListing", () => {
  test("pairs a one-row-per-item order by listing id", () => {
    const items = [item(10), item(20)];
    const entries = pairEntriesByListing([row(20), row(10)], items);
    // Order-independent: each row resolves to its own listing, not the item at
    // the same array index.
    expect(entries.map((e) => e.attendee.listing_id)).toEqual([20, 10]);
    expect(entries.map((e) => e.listing.id)).toEqual([20, 10]);
  });

  test("maps MORE rows than items — the multi-parent expansion — without mis-aligning", () => {
    // A child (30) chosen under two parents (10, 20) is ONE signed item but TWO
    // per-parent booking rows, so four rows resolve against three items. A
    // positional `validatedItems[i]` pairing would read `validatedItems[3]`
    // (undefined) and throw; the by-id lookup pairs every row correctly.
    const items = [item(10), item(20), item(30)];
    const attendees = [row(10), row(20), row(30), row(30)];
    const entries = pairEntriesByListing(attendees, items);
    expect(entries).toHaveLength(4);
    // Every entry's listing matches its own row's listing id — including both
    // child rows, which share listing 30.
    expect(entries.every((e) => e.attendee.listing_id === e.listing.id)).toBe(
      true,
    );
    expect(entries.filter((e) => e.listing.id === 30)).toHaveLength(2);
  });

  test("resolves a parent-less remainder row (same listing, extra row) too", () => {
    // A remainder row shares the child's listing id (30) with its allocation
    // row, so both resolve to listing 30 — again more rows than items.
    const entries = pairEntriesByListing(
      [row(10), row(30), row(30)],
      [item(10), item(30)],
    );
    expect(entries.map((e) => e.listing.id)).toEqual([10, 30, 30]);
  });

  test("fails when a created row has no loaded listing", () => {
    expect(() => pairEntriesByListing([row(30)], [item(10)])).toThrow(
      "Listing 30 was not loaded for a created booking",
    );
  });
});

test("builds standalone and package booking slots", () => {
  expect(bookingSlot({ e: 7, p: 100, q: 1 })).toEqual({
    listingId: 7,
    packageGroupId: 0,
  });
  expect(bookingSlot({ e: 7, k: "p", p: 100, q: 1, r: 9 })).toEqual({
    listingId: 7,
    packageGroupId: 9,
  });
});

type PreparationOptions = {
  chargedUnitAmount?: number;
  fullSubtotal?: number;
  listingName?: string;
  matchingPricedItem?: boolean;
  packageGroupId?: number;
  reservationAmount?: string;
  total: number;
};

const preparationResult = (options: PreparationOptions) => {
  const listing = testListingWithCount({
    id: 1,
    name: options.listingName ?? "Test Listing",
    unit_price: 1000,
  });
  const bookingItem = {
    e: listing.id,
    p: 1000,
    q: 1,
    ...(options.packageGroupId === undefined
      ? {}
      : { k: "p" as const, r: options.packageGroupId }),
  };
  const checkoutItem = {
    listingId: listing.id,
    name: listing.name,
    quantity: 1,
    slug: listing.slug,
    unitPrice: 1000,
    ...(options.packageGroupId === undefined
      ? {}
      : { packageGroupId: options.packageGroupId }),
  };
  const contact = {
    address: "",
    date: null,
    email: "buyer@example.com",
    name: "Buyer",
    phone: "",
    special_instructions: "",
  };
  const intent: BookingIntent = {
    ...contact,
    items: [bookingItem],
    modifiers: [],
    ...(options.reservationAmount === undefined
      ? {}
      : { reservationAmount: options.reservationAmount }),
  };
  const pricingIntent: CheckoutIntent = {
    ...contact,
    items: [checkoutItem],
  };
  const pricedOrder: PricedOrder = {
    extras: [],
    fullSubtotal: options.fullSubtotal ?? 1000,
    lines: [
      {
        chargedUnitAmount: options.chargedUnitAmount ?? 1000,
        item:
          options.matchingPricedItem === false
            ? { ...checkoutItem }
            : checkoutItem,
        quantity: 1,
      },
    ],
    modifierApplications: [],
    total: options.total,
  };
  const session: ValidatedPaymentSession = {
    amountTotal: 1000,
    id: "cs_preparation_failure",
    metadata: webhookMeta({ name: "Buyer" }),
    paymentReference: "pi_preparation_failure",
    paymentStatus: "paid",
  };

  return createAttendeeForSession(
    session,
    intent,
    [{ expectedPrice: 1000, item: bookingItem, listing }],
    pricingIntent,
    pricedOrder,
    "stable-ticket-token",
  );
};

const stubSuccessfulBooking = () =>
  stub(attendeesApi, "createBookingAtomic", () =>
    Promise.resolve({
      attendees: [{ id: 1, listing_id: 1, ticket_token: "token" }],
      success: true,
    } as never),
  );

test("reports a preparation error before the atomic write starts", async () => {
  const result = await preparationResult({ total: Number.NaN });
  expect(result).toEqual({
    detail:
      "Unexpected error preparing session cs_preparation_failure: Error: mapBooking: invalid facts (non-finite amountPaid)",
    ok: false,
    reason: "unexpected_error",
  });
  if (result.ok !== false) throw new Error("Expected preparation to fail");
  expect(specForFailure(result).code).toBe("unexpected_error");
});

describeWithEnv("payment booking lines", { db: true }, () => {
  test("reports a missing paid amount before the atomic write starts", async () => {
    using create = stubSuccessfulBooking();

    expect(
      await preparationResult({ matchingPricedItem: false, total: 1000 }),
    ).toEqual({
      detail:
        "Unexpected error preparing session cs_preparation_failure: Error: Paid amount for listing 1 was not loaded for checkout",
      ok: false,
      reason: "unexpected_error",
    });
    expect(create.calls).toHaveLength(0);
  });

  test("passes zero remaining balance for a full payment", async () => {
    using create = stubSuccessfulBooking();
    await preparationResult({ total: 1000 });
    expect(create.calls[0]!.args[0].remainingBalance).toBe(0);
  });

  test("passes the unpaid balance for a reservation payment", async () => {
    using create = stubSuccessfulBooking();
    await preparationResult({
      chargedUnitAmount: 250,
      fullSubtotal: 1000,
      reservationAmount: "25%",
      total: 250,
    });
    expect(create.calls[0]!.args[0].remainingBalance).toBe(750);
  });

  test("reports the exact modifier sellout failure", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve("sold-out"),
    );
    expect(await preparationResult({ total: 1000 })).toEqual({
      detail: "a chosen add-on or extra sold out during payment",
      ok: false,
      reason: "sold_out",
    });
  });

  test("uses the generic capacity message when the listing name is empty", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({ reason: "capacity_exceeded", success: false }),
    );
    expect(await preparationResult({ listingName: "", total: 1000 })).toEqual({
      detail: "Sorry, this listing sold out while you were completing payment.",
      ok: false,
      reason: "capacity_exceeded",
    });
  });

  test("a package order's capacity error omits the member name", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({ reason: "capacity_exceeded", success: false }),
    );
    expect(await preparationResult({ packageGroupId: 9, total: 1000 })).toEqual(
      {
        detail:
          "Sorry, this listing sold out while you were completing payment.",
        ok: false,
        reason: "capacity_exceeded",
      },
    );
  });

  // The owner reads these, so money off says "£1 off" rather than repeating
  // the minus sign the delta carries, and nothing off is not called a discount.
  for (const [name, code, delta, expected] of [
    ["nothing off", "FREE", 0, "Promo code 'FREE' used: +£0"],
    ["money off", "POUNDOFF", -100, "Promo code 'POUNDOFF' used: £1 off"],
  ] as const) {
    test(`logs ${name} the way the owner reads it`, async () => {
      const listing = await createTestListing();
      const attendee = await bookTestAttendee(
        [listing.id],
        `${code} buyer`,
        `${code.toLowerCase()}@example.com`,
      );

      await logPromoCodeModifiers(
        [{ id: 1, name: code } as never],
        [{ delta, modifierId: 1 } as never],
        listing as never,
        attendee.id,
      );

      const [row] = await queryAll<{ message: string }>(
        "SELECT message FROM activity_log WHERE attendee_id = ?",
        [attendee.id],
      );
      expect(
        await decryptWithOwnerKey(
          row!.message as never,
          await getTestPrivateKey(),
        ),
      ).toBe(expected);
    });
  }

  // A buyer with several tickets has them kept as one joined-up value, so
  // coming back to an already-finished checkout has to hand back each ticket
  // separately rather than one run-together string.
  for (const [name, tokens, expected] of [
    ["several tickets", "tok_a+tok_b+tok_c", ["tok_a", "tok_b", "tok_c"]],
    ["one ticket", "tok_only", ["tok_only"]],
  ] as const) {
    test(`hands back ${name} from a checkout already finished`, async () => {
      const listing = await createTestListing();
      const attendee = await bookTestAttendee(
        [listing.id],
        "Returning buyer",
        `returning-${tokens}@example.com`,
      );

      expect(
        await alreadyProcessedResult(listing.id, {
          attendee_id: attendee.id,
          ticket_tokens: await encrypt(tokens),
        } as never),
      ).toEqual({
        attendee: { id: attendee.id },
        listingId: listing.id,
        success: true,
        ticketTokens: expected,
      });
    });
  }

  test("hands back no tickets when the finished checkout kept none", async () => {
    const listing = await createTestListing();
    const attendee = await bookTestAttendee(
      [listing.id],
      "Tokenless buyer",
      "tokenless@example.com",
    );

    expect(
      await alreadyProcessedResult(listing.id, {
        attendee_id: attendee.id,
        ticket_tokens: "",
      } as never),
    ).toEqual({
      attendee: { id: attendee.id },
      listingId: listing.id,
      success: true,
      ticketTokens: [],
    });
  });
});
