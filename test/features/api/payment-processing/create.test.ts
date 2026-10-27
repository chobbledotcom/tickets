import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#crypto/encryption.ts";
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";

import { logActivities } from "#db/activity-log.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { stageCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { execute, queryAll } from "#db/client.ts";
import {
  alreadyProcessedResult,
  bookingSlot,
  createAttendeeForSession,
} from "#routes/api/payment-processing/create.ts";
import { specForFailure } from "#routes/api/payment-processing/store-refund.ts";
import { promoActivityLines } from "#routes/api/payment-processing/tail.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import type {
  CheckoutIntent,
  ModifierSpec,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount, webhookMeta } from "#test-utils/factories.ts";
import { pricedOrder as makePricedOrder } from "#test-utils/factories-pricing.ts";
import type { ListingWithCount } from "#types";

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

test("fails when a promo code has no pricing application", () => {
  const spec: ModifierSpec = {
    id: 1,
    kind: "fixed",
    listingIds: null,
    name: "Missing application",
    quantity: 1,
    trigger: "code",
    value: -100,
  };
  const listing: ListingWithCount = testListingWithCount();

  expect(() => promoActivityLines([spec], [], listing)).toThrow(
    "Modifier application 1 was not loaded for promo code activity",
  );
});

type PreparationOptions = {
  chargedUnitAmount?: number;
  fullSubtotal?: number;
  listingName?: string;
  /** Staged text-answer refs, for tests that reach the tail's answer read. */
  listingTextAnswerIds?: BookingIntent["listingTextAnswerIds"];
  matchingPricedItem?: boolean;
  packageGroupId?: number;
  reservationAmount?: string;
  safeName?: string;
  secondListingName?: string;
  total: number;
  taxPolicy?: TaxPolicy;
};

/** The buyer's contact fields every preparation fixture shares. */
const PREPARATION_CONTACT = {
  address: "",
  date: null,
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
} as const;

const buildIntent = (
  options: PreparationOptions,
  items: BookingIntent["items"],
): BookingIntent => ({
  ...PREPARATION_CONTACT,
  items,
  listingTextAnswerIds: options.listingTextAnswerIds,
  modifiers: [],
  reservationAmount: options.reservationAmount,
});

const secondListingFor = (
  options: PreparationOptions,
): {
  bookingItem: BookingIntent["items"][number];
  checkoutItem: CheckoutIntent["items"][number];
  listing: ListingWithCount | null;
} | null => {
  if (options.secondListingName === undefined) return null;
  const listing = testListingWithCount({
    id: 2,
    name: options.secondListingName,
    unit_price: 0,
  });
  return {
    bookingItem: { e: 2, p: 0, q: 1 },
    checkoutItem: {
      listingId: 2,
      name: options.secondListingName,
      quantity: 1,
      slug: "second-choice",
      unitPrice: 0,
    },
    listing,
  };
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
  const contact = { ...PREPARATION_CONTACT, date: null };
  // A free second listing keeps the order's totals whole.
  const second = secondListingFor(options);
  const secondListing = second?.listing ?? null;
  const intent = buildIntent(options, [
    bookingItem,
    ...(second ? [second.bookingItem] : []),
  ]);
  const pricingIntent: CheckoutIntent = {
    ...contact,
    items: second ? [checkoutItem, second.checkoutItem] : [checkoutItem],
  };
  const pricedOrder = makePricedOrder({
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
      ...(second
        ? [{ chargedUnitAmount: 0, item: second.checkoutItem, quantity: 1 }]
        : []),
    ],
    modifierApplications: [],
    ...(options.taxPolicy
      ? {
          tax: assessTax(
            { lines: [{ gross: 1000, listingId: 1 }], modifiers: [] },
            options.taxPolicy,
          ),
        }
      : {}),
    total: options.total,
  });
  const session: ValidatedPaymentSession = {
    amountTotal: 1000,
    currency: "GBP",
    id: "cs_preparation_failure",
    metadata: webhookMeta({ name: "Buyer" }),
    paymentReference: "pi_preparation_failure",
    paymentStatus: "paid",
    provider: "stripe",
  };

  return createAttendeeForSession(
    session,
    intent,
    [
      {
        expectedPrice: 1000,
        item: bookingItem,
        listing,
        name: options.safeName ?? listing.name,
      },
      ...(second
        ? [
            {
              expectedPrice: 0,
              item: second.bookingItem,
              listing: secondListing!,
              name: secondListing!.name,
            },
          ]
        : []),
    ],
    pricingIntent,
    pricedOrder,
    "stable-ticket-token",
    1,
    new Map(),
    [],
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
  test("a staged-answer read failure takes the retryable path", async () => {
    // A transient I/O failure in the tail's staged-answer read has written
    // nothing, so the retryable shape — 500, provider redelivers — must win
    // over a refund of the valid payment.
    await stageCheckoutAnswers(
      "cs_preparation_failure",
      { "7": "Answer" },
      null,
    );
    await execute("UPDATE checkout_pending_answers SET sealed = ?", [
      "not-a-sealed-payload",
    ]);
    using create = stubSuccessfulBooking();
    const result = await preparationResult({
      listingTextAnswerIds: { "1": [{ q: 7, s: 3 }] },
      total: 1000,
    });
    expect(result.ok).toBeNull();
    if (result.ok !== null) throw new Error("Expected a retryable failure");
    expect(result.error).toBeInstanceOf(Error);
    expect(create.calls).toHaveLength(0);
  });

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
  test("leaves the full VAT assessment less the actual deposit owed", async () => {
    using create = stubSuccessfulBooking();
    await preparationResult({
      chargedUnitAmount: 240,
      reservationAmount: "20%",
      taxPolicy: { mode: "add_to_total", rateBasisPoints: 2000 },
      total: 240,
    });
    expect(create.calls[0]!.args[0].remainingBalance).toBe(960);
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

  test("names the listing the refusal says sold out, not the order's first", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({
        listingIds: [2],
        reason: "capacity_exceeded",
        success: false,
      }),
    );
    expect(
      await preparationResult({
        secondListingName: "Second choice",
        total: 1000,
      }),
    ).toEqual({
      detail:
        "Sorry, Second choice sold out while you were completing payment.",
      ok: false,
      reason: "capacity_exceeded",
    });
  });

  test("uses the generic capacity message when the listing name is empty", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({
        listingIds: [],
        reason: "capacity_exceeded",
        success: false,
      }),
    );
    expect(await preparationResult({ listingName: "", total: 1000 })).toEqual({
      detail: "Sorry, this listing sold out while you were completing payment.",
      ok: false,
      reason: "capacity_exceeded",
    });
  });

  test("a concealed package capacity error names the package", async () => {
    using _create = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.resolve({
        listingIds: [],
        reason: "capacity_exceeded",
        success: false,
      }),
    );
    expect(
      await preparationResult({
        packageGroupId: 9,
        safeName: "Mystery Package",
        total: 1000,
      }),
    ).toEqual({
      detail:
        "Sorry, Mystery Package sold out while you were completing payment.",
      ok: false,
      reason: "capacity_exceeded",
    });
  });

  // What a code did to the price, in the words the owner reads. A discount
  // says how much came off; a code worth nothing is not called a discount.
  for (const [name, code, delta, message] of [
    ["a code worth nothing", "FREE", 0, "Promo code 'FREE' used: +£0"],
    ["money off", "POUNDOFF", -100, "Promo code 'POUNDOFF' used: £1 off"],
  ] as const) {
    test(`writes down ${name}`, async () => {
      const listing: ListingWithCount = await createTestListing();
      const attendee = await bookTestAttendee(
        [listing.id],
        `${code} buyer`,
        `${code.toLowerCase()}@example.com`,
      );
      const spec: ModifierSpec = {
        id: 1,
        kind: "fixed",
        listingIds: null,
        name: code,
        quantity: 1,
        trigger: "code",
        value: delta,
      };
      const application: ModifierApplication = {
        amountApplied: Math.abs(delta),
        delta,
        modifierId: 1,
        name: code,
        quantity: 1,
        scopedSubtotal: listing.unit_price,
      };

      await logActivities(
        promoActivityLines([spec], [application], listing).map((line) => ({
          ...line,
          attendeeId: attendee.id,
        })),
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
      ).toBe(message);
    });
  }

  // A buyer with several tickets has them kept as one joined-up value, so a
  // return to a finished checkout hands back each ticket separately.
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
