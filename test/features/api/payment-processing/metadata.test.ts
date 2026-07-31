import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  businessTime,
  extractIntent,
} from "#routes/api/payment-processing/metadata.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";

/** The metadata our own checkout writes when the buyer gave the bare minimum:
 *  one line, no answers, no modifiers, no deposit. */
const bareMetadata: SessionMetadata = {
  _origin: "https://example.com",
  address: "",
  allocations: "",
  answer_ids: "",
  balance_attendee_id: "",
  date: "",
  day_count: "",
  email: "buyer@example.com",
  items: JSON.stringify([{ e: 1, p: 100, q: 1 }]),
  modifiers: "",
  name: "Buyer",
  phone: "",
  price_proof: "100.sig",
  reservation_amount: "",
  site_token_index: "",
  special_instructions: "",
  text_answer_ids: "",
  thank_you_url: "",
};

const session = (
  metadata: Partial<SessionMetadata> = {},
  createdAt?: string,
): ValidatedPaymentSession => ({
  amountTotal: 100,
  createdAt,
  id: "cs_1",
  metadata: { ...bareMetadata, ...metadata },
  paymentReference: "pi_1",
  paymentStatus: "paid",
});

describe("the time a payment counts as happening", () => {
  test("uses the time the provider says the checkout was made", () => {
    // A webhook can arrive days late; the buyer paid when they paid.
    expect(businessTime(session({}, "2026-07-01T09:00:00.000Z"))).toBe(
      "2026-07-01T09:00:00.000Z",
    );
  });

  test("falls back to now when the provider gave no time", () => {
    using _time = new FakeTime(new Date("2026-07-28T12:00:00.000Z"));

    expect(businessTime(session())).toBe("2026-07-28T12:00:00.000Z");
  });
});

describe("reading a booking out of a paid checkout", () => {
  test("reads the lines, the buyer, and the empty fields as nothing", () => {
    expect(extractIntent(session())).toEqual({
      address: "",
      allocations: undefined,
      balanceAttendeeId: undefined,
      date: null,
      dayCount: undefined,
      email: "buyer@example.com",
      items: [{ e: 1, p: 100, q: 1 }],
      listingAnswerIds: undefined,
      listingTextAnswerIds: undefined,
      modifiers: [],
      name: "Buyer",
      phone: "",
      reservationAmount: undefined,
      siteTokenIndex: undefined,
      special_instructions: "",
      thankYouUrl: undefined,
    });
  });

  test("reads everything the checkout can carry", () => {
    const intent = extractIntent(
      session({
        allocations: JSON.stringify([{ childId: 2, parentId: 1, qty: 1 }]),
        answer_ids: JSON.stringify({ "1": [7] }),
        balance_attendee_id: "42",
        date: "2026-08-01",
        day_count: "3",
        reservation_amount: "10%",
        site_token_index: "idx",
        text_answer_ids: JSON.stringify({ "1": [{ q: 1, s: 5 }] }),
        thank_you_url: "https://example.com/thanks",
      }),
    );

    expect(intent).toMatchObject({
      allocations: [{ childId: 2, parentId: 1, qty: 1 }],
      balanceAttendeeId: 42,
      date: "2026-08-01",
      dayCount: 3,
      listingAnswerIds: { "1": [7] },
      listingTextAnswerIds: { "1": [{ q: 1, s: 5 }] },
      reservationAmount: "10%",
      siteTokenIndex: "idx",
      thankYouUrl: "https://example.com/thanks",
    });
  });

  test("reads the modifiers the buyer took", () => {
    expect(
      extractIntent(session({ modifiers: JSON.stringify([{ i: 3, q: 2 }]) }))
        ?.modifiers,
    ).toEqual([{ i: 3, q: 2 }]);
  });

  // Our checkout only ever writes a whole number of days here, and leaves the
  // field empty when there is no day count at all. Anything else means what
  // came back is not what we sent, so the booking is not read rather than run
  // for zero, half, or minus a day.
  for (const [name, dayCount] of [
    ["not a number at all", "lots"],
    ["none", "0"],
    ["below zero", "-2"],
    ["part of a day", "2.7"],
  ] as const) {
    test(`reads no booking when the day count is ${name}`, () => {
      expect(extractIntent(session({ day_count: dayCount }))).toBe(null);
    });
  }

  test("keeps a day count of one", () => {
    expect(extractIntent(session({ day_count: "1" }))?.dayCount).toBe(1);
  });

  // Nothing to book means there is no booking to read, and the caller is
  // expected to branch on that rather than get an empty one.
  for (const [name, items] of [
    ["is not readable at all", "{oh no"],
    ["is not a list", JSON.stringify({ e: 1 })],
    ["is an empty list", "[]"],
    ["holds a line with no listing", JSON.stringify([{ e: 0, p: 1, q: 1 }])],
  ] as const) {
    test(`reads no booking when what was bought ${name}`, () => {
      expect(extractIntent(session({ items }))).toBe(null);
    });
  }

  // Every other field the checkout sends is read back the same way: it is what
  // we wrote or the booking is not read at all. Without this, a drifted field
  // was cast straight through and fell over later, after the buyer had paid.
  for (const [name, metadata] of [
    ["the modifiers are not a list", { modifiers: "{}" }],
    ["a modifier is missing its quantity", { modifiers: '[{"i":3}]' }],
    ["the answers are not readable", { answer_ids: "{oh no" }],
    ["an answer is filed under no listing", { answer_ids: '{"nope":[7]}' }],
    ["the child tickets are not a list", { allocations: '{"childId":2}' }],
    ["the balance attendee is not a number", { balance_attendee_id: "me" }],
    ["a deposit cannot be read as an amount", { reservation_amount: "lots" }],
  ] as const) {
    test(`reads no booking when ${name}`, () => {
      expect(extractIntent(session(metadata))).toBe(null);
    });
  }
});
