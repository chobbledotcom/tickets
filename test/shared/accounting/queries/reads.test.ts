import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type BookingFacts, mapBooking } from "#accounting/mappers.ts";
import {
  orderModifierLines,
  transfersByEventGroup,
} from "#accounting/queries.ts";
import { postTransfers } from "#accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");

describe("db > accounting > transfer reads", () => {
  useTransactionalDb();

  test("transfersByEventGroup returns only that event's legs", async () => {
    await postTransfers([
      tx({ eventGroup: "evt-x", reference: "x-sale" }),
      tx({
        destination: account("attendee", 1),
        eventGroup: "evt-x",
        reference: "x-pay",
        source: world,
      }),
    ]);
    await postTransfers([tx({ eventGroup: "evt-y", reference: "y-sale" })]);
    const legs = await transfersByEventGroup("evt-x");
    expect(legs.map((t) => t.reference).toSorted()).toEqual([
      "x-pay",
      "x-sale",
    ]);
  });

  test("orderModifierLines returns nothing for no event groups", async () => {
    expect(await orderModifierLines([])).toEqual(new Map());
  });

  test("orderModifierLines signs each order's modifier legs", async () => {
    await postTransfers([
      tx({
        amount: 100,
        destination: account("modifier", 7),
        eventGroup: "evt-mod",
        kind: "modifier",
        reference: "mod-charge",
      }),
      tx({
        amount: 40,
        destination: account("attendee", 1),
        eventGroup: "evt-mod",
        kind: "modifier",
        reference: "mod-discount",
        source: account("modifier", 8),
      }),
      // A sale leg must not join this order's modifier lines.
      tx({
        amount: 900,
        eventGroup: "evt-mod",
        kind: "sale",
        reference: "mod-sale",
      }),
    ]);
    await postTransfers([
      tx({
        amount: 55,
        destination: account("modifier", 9),
        eventGroup: "evt-other",
        kind: "modifier",
        reference: "other-charge",
      }),
    ]);
    expect(await orderModifierLines(["evt-mod", "evt-mod"])).toEqual(
      new Map([
        [
          "evt-mod",
          [
            { amount: 100, modifierId: 7 },
            { amount: -40, modifierId: 8 },
          ],
        ],
      ]),
    );
  });

  test("orderModifierLines adds up several legs of one modifier", async () => {
    await postTransfers([
      tx({
        amount: 100,
        destination: account("modifier", 7),
        eventGroup: "evt-sum",
        kind: "modifier",
        reference: "sum-one",
      }),
      tx({
        amount: 50,
        destination: account("modifier", 7),
        eventGroup: "evt-sum",
        kind: "modifier",
        reference: "sum-two",
      }),
    ]);
    expect(await orderModifierLines(["evt-sum"])).toEqual(
      new Map([["evt-sum", [{ amount: 150, modifierId: 7 }]]]),
    );
  });

  test("orderModifierLines reads back what a booking posted", async () => {
    // Round trip through the writer: the leg directions the booking mapper
    // chooses are the ones this read must decode, surcharge and discount both.
    const facts: BookingFacts = {
      amountPaid: 10_250,
      attendeeId: 1,
      bookingFee: 0,
      eventId: "evt-round-trip",
      lines: [{ gross: 10_000, listingId: 1 }],
      modifiers: [
        { delta: 1000, modifierId: 21 },
        { delta: -750, modifierId: 22 },
      ],
      occurredAt: "2026-06-01T10:00:00.000Z",
    };
    const legs = await mapBooking(facts);
    await postTransfers(legs);
    const group = legs[0]!.eventGroup;
    expect(await orderModifierLines([group])).toEqual(
      new Map([
        [
          group,
          [
            { amount: 1000, modifierId: 21 },
            { amount: -750, modifierId: 22 },
          ],
        ],
      ]),
    );
  });
});
