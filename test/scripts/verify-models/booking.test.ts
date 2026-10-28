/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingReplayModelData,
  deletedRowRefundData,
  duplicateBookingData,
} from "#scripts/verify-models/booking.ts";
import { classifyBookingLedger } from "#shared/session-ledger.ts";
import { members, records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type Fact = Record<string, string | boolean>;

/** The delivery facts the clean module and one corrupted module both emit,
 * plus the facts whose `field` the corruption changed. */
const flippedFacts = async (
  corruptedData: () => Promise<string>,
  field: "books" | "refunds",
): Promise<{ changed: { after: Fact; before: Fact }[] }> => {
  const honest = records(await bookingReplayModelData(), "DeliveryFacts");
  const corrupted = records(await corruptedData(), "DeliveryFacts");
  expect(corrupted).toHaveLength(honest.length);
  const changed = honest.flatMap((fact, index) => {
    const after = corrupted[index];
    if (after === undefined || after[field] === fact[field]) return [];
    return [{ after, before: fact }];
  });
  return { changed };
};

describe("booking replay checker data", () => {
  test("names the ledger states the production classifier produces", async () => {
    const data = await bookingReplayModelData();
    expect(classifyBookingLedger(false, null).status).toBe("unrecorded");
    expect(classifyBookingLedger(true, 1).status).toBe("booked");
    expect(classifyBookingLedger(true, null).status).toBe("orphaned");
    expect(members(data, "LedgerStates")).toEqual([
      "unrecorded",
      "booked",
      "orphaned",
    ]);
    expect(members(data, "RowStates")).toEqual([
      "none",
      "reserved",
      "finalized",
    ]);
  });

  test("records one delivery outcome per ledger and row state", async () => {
    const data = await bookingReplayModelData();
    const facts = records(data, "DeliveryFacts");
    expect(facts).toHaveLength(9);
    // A fresh unrecorded booking creates one booking and finalizes the row.
    expect(facts).toContainEqual({
      books: true,
      ledgerAfter: "booked",
      ledgerBefore: "unrecorded",
      refunds: false,
      rowAfter: "finalized",
      rowBefore: "none",
    });
    // A deleted temporary row does not erase replay protection: a booked
    // ledger replays the honoured booking by healing the row.
    expect(facts).toContainEqual({
      books: false,
      ledgerAfter: "booked",
      ledgerBefore: "booked",
      refunds: false,
      rowAfter: "finalized",
      rowBefore: "none",
    });
    // Exactly one delivery books, none refunds, and a delivery to a booked
    // ledger keeps the ledger booked.
    expect(facts.filter((fact) => fact.books === true)).toHaveLength(1);
    expect(facts.filter((fact) => fact.refunds === true)).toHaveLength(0);
    for (const fact of facts.filter((fact) => fact.ledgerBefore === "booked")) {
      expect(fact.books).toBe(false);
      expect(fact.refunds).toBe(false);
      expect(fact.ledgerAfter).toBe("booked");
    }
  });

  test("duplicate booking flips every booked-ledger delivery to book", async () => {
    const { changed } = await flippedFacts(duplicateBookingData, "books");
    expect(changed).toHaveLength(3);
    for (const { after, before } of changed) {
      expect(before.ledgerBefore).toBe("booked");
      expect(before.books).toBe(false);
      expect(after).toEqual({ ...before, books: true });
    }
  });

  test("deleted-row refund flips only the booked and deleted delivery", async () => {
    const { changed } = await flippedFacts(deletedRowRefundData, "refunds");
    expect(changed).toHaveLength(1);
    const change = changed[0];
    expect(change?.before).toMatchObject({
      books: false,
      ledgerBefore: "booked",
      refunds: false,
      rowBefore: "none",
    });
    expect(change?.after.refunds).toBe(true);
  });
});
