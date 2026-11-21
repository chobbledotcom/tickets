import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { members, records } from "#test-utils/tla-data.ts";
import { registeredModel } from "./registered-model.ts";

const { data: sealedOrderModelData, controls } = registeredModel("SealedOrder");
const [earlyReceiptData, settledAlarmData, lostOrderRefundData] = controls.map(
  (control) => control.data,
);

/** A delivery fact as the clean module emits it. */
const delivery = (fields: Record<string, string | boolean>) => ({
  alarms: false,
  books: false,
  refunds: false,
  ...fields,
});

describe("sealed order checker data", () => {
  test("names the bundle, row and ledger states", async () => {
    const data = await sealedOrderModelData();

    expect(members(data, "BundleStates")).toEqual(["order", "receipt", "gone"]);
    expect(members(data, "RowStates")).toEqual([
      "none",
      "reserved",
      "finalized",
      "failed",
    ]);
    expect(members(data, "LedgerStates")).toEqual(["unrecorded", "recorded"]);
  });

  test("answers a missing order as settled once the session is settled, and raises the alarm otherwise", async () => {
    const facts = records(await sealedOrderModelData(), "DeliveryFacts");
    const missing = facts.filter((fact) => fact.bundle === "gone");

    expect(missing).toHaveLength(8);
    expect(missing).toContainEqual(
      delivery({
        answer: "settled",
        bundle: "gone",
        ledgerAfter: "recorded",
        ledgerBefore: "recorded",
        rowAfter: "none",
        rowBefore: "none",
      }),
    );
    expect(missing).toContainEqual(
      delivery({
        answer: "settled",
        bundle: "gone",
        ledgerAfter: "unrecorded",
        ledgerBefore: "unrecorded",
        rowAfter: "failed",
        rowBefore: "failed",
      }),
    );
    const alarmed = missing.filter((fact) => fact.alarms === true);
    expect(alarmed.map((fact) => fact.rowBefore).toSorted()).toEqual([
      "none",
      "reserved",
    ]);
    for (const fact of alarmed) {
      expect(fact).toMatchObject({
        answer: "unreadable",
        ledgerBefore: "unrecorded",
        refunds: false,
      });
    }
  });

  test("replays a readable order from the row or the ledger, and books only from a receipt with no leg", async () => {
    const facts = records(await sealedOrderModelData(), "DeliveryFacts");
    const readable = facts.filter((fact) => fact.bundle !== "gone");

    expect(readable).toContainEqual(
      delivery({
        answer: "held",
        bundle: "order",
        ledgerAfter: "unrecorded",
        ledgerBefore: "unrecorded",
        rowAfter: "reserved",
        rowBefore: "reserved",
      }),
    );
    expect(
      readable
        .filter((fact) => fact.rowBefore === "none")
        .filter((fact) => fact.ledgerBefore === "recorded")
        .map((fact) => fact.rowAfter)
        .toSorted(),
    ).toEqual(["failed", "failed", "finalized", "finalized"]);
    expect(readable.filter((fact) => fact.books === true)).toEqual([
      delivery({
        answer: "booked",
        books: true,
        bundle: "receipt",
        ledgerAfter: "recorded",
        ledgerBefore: "unrecorded",
        rowAfter: "finalized",
        rowBefore: "none",
      }),
    ]);
  });

  test("writes a receipt only after a final row", async () => {
    const data = await sealedOrderModelData();

    expect(records(data, "ReceiptFacts")).toEqual([
      { rowBefore: "finalized" },
      { rowBefore: "failed" },
    ]);
  });

  test("the early-receipt control also writes a receipt on an open row", async () => {
    const data = await earlyReceiptData!();

    expect(records(data, "ReceiptFacts").map((fact) => fact.rowBefore)).toEqual(
      ["none", "reserved", "finalized", "failed"],
    );
  });

  test("the settled-alarm control raises the alarm for every missing order", async () => {
    const facts = records(await settledAlarmData!(), "DeliveryFacts");
    const missing = facts.filter((fact) => fact.bundle === "gone");

    expect(missing).toHaveLength(8);
    for (const fact of missing) {
      expect(fact).toMatchObject({ alarms: true, answer: "unreadable" });
    }
    expect(facts.filter((fact) => fact.bundle !== "gone")).toEqual(
      records(await sealedOrderModelData(), "DeliveryFacts").filter(
        (fact) => fact.bundle !== "gone",
      ),
    );
  });

  test("the lost-order refund control refunds only the alarmed deliveries", async () => {
    const facts = records(await lostOrderRefundData!(), "DeliveryFacts");

    expect(facts.filter((fact) => fact.refunds === true)).toHaveLength(2);
    for (const fact of facts.filter((fact) => fact.refunds === true)) {
      expect(fact.alarms).toBe(true);
    }
  });
});
