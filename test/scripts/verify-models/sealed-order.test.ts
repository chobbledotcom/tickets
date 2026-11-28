import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sealedOrderDataWithFault } from "#scripts/verify-models/sealed-order.ts";
import { members, records } from "#test-utils/tla-data.ts";
import { registeredModel } from "./registered-model.ts";

const { data: sealedOrderModelData, controls } = registeredModel("SealedOrder");
const [
  receiptBooksData,
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
 * settled, and that no delivery holds, raises the alarm. */
/* jscpd:ignore-start -- static data, not code */
const MISSING_CASES: [string, string, string, Fields?][] = [
  ["none", "unrecorded", "unreadable", ALARM],
  ["none", "recorded", "settled"],
  ["reserved", "unrecorded", "held"],
  ["reserved", "recorded", "settled"],
  ["finalized", "unrecorded", "settled"],
  ["finalized", "recorded", "settled"],
  ["failed", "unrecorded", "settled"],
  ["failed", "recorded", "settled"],
];
/* jscpd:ignore-end */

const MISSING = MISSING_CASES.map(([row, ledger, answer, change]) =>
  fact("gone", row, ledger, answer, change),
);

const HEALED_BOOKED = { rowAfter: "finalized" };
const HEALED_FAILED = { rowAfter: "failed" };

/** A reserved or final row decides the answer, whatever the bundle and the
 * ledger hold. The facts run ledger by ledger, then bundle by bundle. */
const ROW_ANSWERS = [
  ["reserved", "held"],
  ["finalized", "booked"],
  ["failed", "settled"],
] as const;

const ROW_DECIDES = ROW_ANSWERS.flatMap(([row, answer]) =>
  ["unrecorded", "recorded"].flatMap((ledger) =>
    ["order", "receipt"].map((bundle) => fact(bundle, row, ledger, answer)),
  ),
);

/** Every delivery that reads an order or a receipt. With no row, a ledger
 * leg heals the row. A receipt with no row and no leg is a lost order. */
const READABLE = [
  fact("receipt", "none", "unrecorded", "unreadable", ALARM),
  fact("order", "none", "recorded", "booked", HEALED_BOOKED),
  fact("order", "none", "recorded", "settled", HEALED_FAILED),
  fact("receipt", "none", "recorded", "booked", HEALED_BOOKED),
  fact("receipt", "none", "recorded", "settled", HEALED_FAILED),
  ...ROW_DECIDES,
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

  test("replays a readable order from the row or the ledger, and reads a receipt with no row and no leg as a lost order", async () => {
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

  test("the receipt-books control books from a receipt with no row and no leg, and changes nothing else", async () => {
    const books = (delivery: Fields) =>
      delivery.bundle === "receipt" &&
      delivery.rowBefore === "none" &&
      delivery.ledgerBefore === "unrecorded"
        ? fact("receipt", "none", "unrecorded", "booked", {
            books: true,
            ledgerAfter: "recorded",
            rowAfter: "finalized",
          })
        : delivery;

    expect(await deliveries(receiptBooksData!)).toEqual(
      (await deliveries(sealedOrderModelData)).map(books),
    );
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
      (await deliveries(sealedOrderModelData))
        .filter((delivery) => delivery.alarms)
        .map((delivery) => ({ ...delivery, refunds: true })),
    );
  });
});
