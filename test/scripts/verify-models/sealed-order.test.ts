import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sealedOrderDataWithFault } from "#scripts/verify-models/sealed-order.ts";
import { members, records } from "#test-utils/tla-data.ts";
import { registeredModel } from "./registered-model.ts";

const { data: sealedOrderModelData, controls } = registeredModel("SealedOrder");
const [
  earlyReceiptData,
  settledAlarmData,
  missedAlarmData,
  lostOrderRefundData,
] = controls.map((control) => control.data);

type Fields = Record<string, string | number | boolean>;

/** A delivery fact as the clean module emits it: the bundle, the row and the
 * ledger it finds, its answer, and what it changes. */
const fact = (
  bundle: string,
  rowBefore: string,
  ledgerBefore: string,
  answer: string,
  change: Fields = {},
) => ({
  alarms: false,
  answer,
  books: false,
  bundle,
  ledgerAfter: ledgerBefore,
  ledgerBefore,
  refunds: false,
  rowAfter: rowBefore,
  rowBefore,
  ...change,
});

const ALARM = { alarms: true };

/** Every delivery that finds no readable order. Only a session that is not
 * settled raises the alarm. */
const MISSING = [
  fact("gone", "none", "unrecorded", "unreadable", ALARM),
  fact("gone", "none", "recorded", "settled"),
  fact("gone", "reserved", "unrecorded", "unreadable", ALARM),
  fact("gone", "reserved", "recorded", "settled"),
  fact("gone", "finalized", "unrecorded", "settled"),
  fact("gone", "finalized", "recorded", "settled"),
  fact("gone", "failed", "unrecorded", "settled"),
  fact("gone", "failed", "recorded", "settled"),
];

const HEALED_BOOKED = { rowAfter: "finalized" };
const HEALED_FAILED = { rowAfter: "failed" };

/** Every delivery that reads an order or a receipt. */
const READABLE = [
  fact("receipt", "none", "unrecorded", "booked", {
    books: true,
    ledgerAfter: "recorded",
    rowAfter: "finalized",
  }),
  fact("order", "none", "recorded", "booked", HEALED_BOOKED),
  fact("order", "none", "recorded", "settled", HEALED_FAILED),
  fact("receipt", "none", "recorded", "booked", HEALED_BOOKED),
  fact("receipt", "none", "recorded", "settled", HEALED_FAILED),
  fact("order", "reserved", "unrecorded", "held"),
  fact("receipt", "reserved", "unrecorded", "held"),
  fact("order", "reserved", "recorded", "held"),
  fact("receipt", "reserved", "recorded", "held"),
  fact("order", "finalized", "unrecorded", "booked"),
  fact("receipt", "finalized", "unrecorded", "booked"),
  fact("order", "finalized", "recorded", "booked"),
  fact("receipt", "finalized", "recorded", "booked"),
  fact("order", "failed", "unrecorded", "settled"),
  fact("receipt", "failed", "unrecorded", "settled"),
  fact("order", "failed", "recorded", "settled"),
  fact("receipt", "failed", "recorded", "settled"),
];

const deliveries = async (data: () => Promise<string>) =>
  records(await data(), "DeliveryFacts");

const goneOnly = (facts: Fields[]) =>
  facts.filter((delivery) => delivery.bundle === "gone");

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
    expect(goneOnly(await deliveries(sealedOrderModelData))).toEqual(MISSING);
  });

  test("replays a readable order from the row or the ledger, and books only from a receipt with no row and no leg", async () => {
    const facts = await deliveries(sealedOrderModelData);

    expect(facts.filter((delivery) => delivery.bundle !== "gone")).toEqual(
      READABLE,
    );
  });

  test("writes a receipt only after a final row", async () => {
    expect(records(await sealedOrderModelData(), "ReceiptFacts")).toEqual([
      { rowBefore: "finalized" },
      { rowBefore: "failed" },
    ]);
  });

  test("a settle rule that splits the results of one row stops the producer", async () => {
    const faulty = sealedOrderDataWithFault({
      settles: (result) => result.success || result.refunded === true,
    });

    await expect(faulty()).rejects.toThrow(
      "The results that leave a failed row disagree on the receipt.",
    );
  });

  test("a callback answer that the model does not hold stops the producer", async () => {
    const faulty = sealedOrderDataWithFault({
      answerFor: () => ({
        outcome: { kind: "unverifiable" },
        reportsLostOrder: false,
      }),
    });

    await expect(faulty()).rejects.toThrow(
      'The sealed order model holds no answer "unverifiable".',
    );
  });

  test("the early-receipt control writes a receipt after a reserved row too", async () => {
    expect(records(await earlyReceiptData!(), "ReceiptFacts")).toEqual([
      { rowBefore: "reserved" },
      { rowBefore: "finalized" },
      { rowBefore: "failed" },
    ]);
  });

  test("the settled-alarm control raises the alarm for a refunded session, and changes nothing else", async () => {
    const refunded = (delivery: Fields) =>
      delivery.rowBefore === "failed"
        ? { ...delivery, alarms: true, answer: "unreadable" }
        : delivery;

    expect(goneOnly(await deliveries(settledAlarmData!))).toEqual(
      MISSING.map(refunded),
    );
  });

  test("the missed-alarm control settles an open session quietly, and changes nothing else", async () => {
    const quiet = (delivery: Fields) =>
      delivery.alarms === true
        ? { ...delivery, alarms: false, answer: "settled" }
        : delivery;

    expect(goneOnly(await deliveries(missedAlarmData!))).toEqual(
      MISSING.map(quiet),
    );
  });

  test("the lost-order refund control refunds only the alarmed deliveries", async () => {
    const facts = await deliveries(lostOrderRefundData!);

    expect(facts.filter((delivery) => delivery.refunds === true)).toEqual(
      MISSING.filter((delivery) => delivery.alarms).map((delivery) => ({
        ...delivery,
        refunds: true,
      })),
    );
  });
});
