import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  alreadyProcessedResult,
  bookingSlot,
  createAttendeeForSession,
  logPromoCodeModifiers,
  pairEntriesByListing,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { specForFailure } from "#routes/api/payment-processing/store-refund.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import { decryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { getOrCreateStringIds } from "#shared/db/questions/strings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount, webhookMeta } from "#test-utils/factories.ts";

/** A validated item carries a listing (the only field the pairing reads). */
const item = (id: number) => ({ listing: testListingWithCount({ id }) });
/** A created booking row — the pairing keys on its `listing_id`. */
const row = (listing_id: number) => ({ listing_id });
const intentContact = {
  address: "",
  date: null,
  phone: "",
  special_instructions: "",
};

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

test("builds session success with default and explicit ticket tokens", () => {
  expect(sessionSuccess(2, 7)).toEqual({
    attendee: { id: 2 },
    listingId: 7,
    success: true,
    ticketTokens: [],
  });
  expect(sessionSuccess(2, 7, ["one"])).toMatchObject({
    ticketTokens: ["one"],
  });
});

describeWithEnv("processed payment replay", { encryptionKey: true }, () => {
  test("replays encrypted ticket tokens from a processed payment", async () => {
    expect(
      await alreadyProcessedResult(7, {
        attendee_id: 2,
        failure_data: "",
        payment_reference: "",
        payment_session_id: "session",
        processed_at: "2026-07-18T00:00:00.000Z",
        provider_refunded_at: "",
        ticket_tokens: await encrypt("one+two"),
      }),
    ).toEqual({
      attendee: { id: 2 },
      listingId: 7,
      success: true,
      ticketTokens: ["one", "two"],
    });
  });
});

const preparationResult = (options: {
  matchingPricedItem: boolean;
  sessionId: string;
  total: number;
}) => {
  const listing = testListingWithCount({ id: 1, unit_price: 1000 });
  const bookingItem = { e: listing.id, p: 1000, q: 1 };
  const checkoutItem = {
    listingId: listing.id,
    name: listing.name,
    quantity: 1,
    slug: listing.slug,
    unitPrice: 1000,
  };
  const contact = {
    address: "",
    date: null,
    email: "buyer@example.com",
    name: "Buyer",
    phone: "",
    special_instructions: "",
  };
  const session = {
    amountTotal: 1000,
    id: options.sessionId,
    metadata: webhookMeta({ name: "Buyer" }),
    paymentReference: `pi_${options.sessionId}`,
    paymentStatus: "paid" as const,
  };
  return createAttendeeForSession(
    session,
    { ...contact, items: [bookingItem], modifiers: [] },
    [{ expectedPrice: 1000, item: bookingItem, listing }],
    { ...contact, items: [checkoutItem] },
    {
      extras: [],
      fullSubtotal: 1000,
      lines: [
        {
          chargedUnitAmount: 1000,
          item: options.matchingPricedItem ? checkoutItem : { ...checkoutItem },
          quantity: 1,
        },
      ],
      modifierApplications: [],
      total: options.total,
    },
    {
      attendeeId: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      paymentSessionId: session.id,
      provider: "stripe",
      providerCheckoutId: session.id,
      refund: null,
      state: "pending",
      ticketToken: "stable-ticket-token",
    },
  );
};

test("reports a preparation error before the atomic write starts", async () => {
  const result = await preparationResult({
    matchingPricedItem: true,
    sessionId: "cs_preparation_failure",
    total: Number.NaN,
  });
  expect(result).toEqual({
    detail:
      "Unexpected error preparing session cs_preparation_failure: Error: mapBooking: invalid facts (non-finite amountPaid)",
    ok: false,
    reason: "unexpected_error",
  });
  if (result.ok !== false) throw new Error("Expected preparation to fail");
  expect(specForFailure(result).code).toBe("unexpected_error");
});

test("reports a preparation error when a paid amount was not loaded", async () => {
  const result = await preparationResult({
    matchingPricedItem: false,
    sessionId: "cs_missing_paid_amount",
    total: 1000,
  });
  expect(result).toEqual({
    detail:
      "Unexpected error preparing session cs_missing_paid_amount: Error: Paid amount for checkout item 0 was not loaded",
    ok: false,
    reason: "unexpected_error",
  });
});

describeWithEnv("activation failures", { encryptionKey: true }, () => {
  for (const [reason, detail] of [
    ["sold_out", "a chosen add-on or extra sold out during payment"],
    [
      "capacity_exceeded",
      "Sorry, Test Listing sold out while you were completing payment.",
    ],
    ["stage_mismatch", "Staged order did not match session cs_stage_mismatch"],
  ] as const) {
    test(`reports the exact ${reason} activation failure`, async () => {
      using _activate = stub(attendeesApi, "activateStagedAttendee", () =>
        Promise.resolve({ reason, success: false } as never),
      );
      expect(
        await preparationResult({
          matchingPricedItem: true,
          sessionId: `cs_${reason}`,
          total: 1000,
        }),
      ).toMatchObject({ detail, ok: false, reason });
    });
  }
});

describeWithEnv("payment creation details", { db: true }, () => {
  test("saves a resolved text answer and skips a corrupt unresolved ref", async () => {
    const listing = await createTestListing();
    const attendee = await bookTestAttendee(
      [listing.id],
      "Answer buyer",
      "answer@example.com",
    );
    const question = await getDb().execute(
      "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text') RETURNING id",
    );
    const questionId = Number(question.rows[0]!.id);
    const stringId = (await getOrCreateStringIds(["Saved answer"])).get(
      "Saved answer",
    )!;
    await saveSessionAnswers(
      [{ attendee: { id: attendee.id }, listing } as never],
      {
        ...intentContact,
        email: "answer@example.com",
        items: [{ e: listing.id, p: 0, q: 1 }],
        listingTextAnswerIds: {
          [String(listing.id)]: [
            { q: questionId, s: stringId },
            { q: questionId + 1 } as never,
          ],
        },
        modifiers: [],
        name: "Answer buyer",
      },
    );
    expect(
      await queryAll(
        "SELECT question_id, string_id FROM attendee_answers WHERE attendee_id = ?",
        [attendee.id],
      ),
    ).toEqual([{ question_id: questionId, string_id: stringId }]);
  });

  test("does no answer write when answer metadata is absent", async () => {
    await saveSessionAnswers([], {
      ...intentContact,
      email: "none@example.com",
      items: [{ e: 1, p: 0, q: 1 }],
      modifiers: [],
      name: "No answers",
    });
    expect(
      await queryAll("SELECT attendee_id FROM attendee_answers", []),
    ).toEqual([]);
  });

  test("saves an answer when only choice metadata is present", async () => {
    const listing = await createTestListing();
    const attendee = await bookTestAttendee(
      [listing.id],
      "Choice buyer",
      "choice@example.com",
    );
    const question = await getDb().execute(
      "INSERT INTO questions (text, display_type) VALUES ('Pick?', 'radio') RETURNING id",
    );
    const choiceQuestionId = Number(question.rows[0]!.id);
    const answer = await getDb().execute(
      "INSERT INTO answers (question_id, text) VALUES (?, 'Yes') RETURNING id",
      [choiceQuestionId],
    );
    const answerId = Number(answer.rows[0]!.id);
    await saveSessionAnswers(
      [{ attendee: { id: attendee.id }, listing } as never],
      {
        ...intentContact,
        email: "choice@example.com",
        items: [{ e: listing.id, p: 0, q: 1 }],
        listingAnswerIds: { [String(listing.id)]: [answerId] },
        modifiers: [],
        name: "Choice buyer",
      },
    );
    expect(
      await queryAll(
        "SELECT answer_id FROM attendee_answers WHERE attendee_id = ?",
        [attendee.id],
      ),
    ).toEqual([{ answer_id: answerId }]);
  });

  test("logs positive and negative promo effects", async () => {
    const listing = await createTestListing();
    const attendee = await bookTestAttendee(
      [listing.id],
      "Promo buyer",
      "promo@example.com",
    );
    await logPromoCodeModifiers(
      [
        { id: 1, name: "SAVE" } as never,
        { id: 2, name: "EXTRA" } as never,
        { id: 3, name: "FREE" } as never,
      ],
      [
        { delta: -500, modifierId: 1 } as never,
        { delta: 250, modifierId: 2 } as never,
        { delta: 0, modifierId: 3 } as never,
      ],
      listing as never,
      attendee.id,
    );
    const rows = await queryAll<{ message: string }>(
      "SELECT message FROM activity_log WHERE attendee_id = ? ORDER BY id",
      [attendee.id],
    );
    const privateKey = await getTestPrivateKey();
    expect(
      await Promise.all(
        rows.map((row) =>
          decryptWithOwnerKey(row.message as never, privateKey),
        ),
      ),
    ).toEqual([
      "Promo code 'SAVE' used: £5 off",
      "Promo code 'EXTRA' used: +£2.50",
      "Promo code 'FREE' used: +£0",
    ]);
  });
});
