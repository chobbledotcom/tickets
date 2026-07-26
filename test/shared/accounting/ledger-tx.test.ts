/**
 * `ledgerTx` — the in-transaction ledger facade — and `inOwnTx`.
 *
 * The leaf `…Tx` reads/writes are tested in their own modules; this locks the
 * facade's own behaviour: that each `correct.X` reads its paired figure and
 * posts the single adjustment that moves it onto the target, that the sign is
 * right (income/revenue move WITH the target, what's owed moves AGAINST it),
 * that re-submitting the same target posts nothing (the read-then-write
 * idempotency the corrections rely on), and that `inOwnTx` runs a correction in
 * its own transaction.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { inOwnTx, ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { type TxScope, withTransaction } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import { nowIso } from "#shared/now.ts";
import {
  postListingSale,
  postModifierLeg,
  tx,
  useTransactionalDb,
} from "#test-utils/ledger.ts";

const readIncome = (listingId: number): Promise<number> =>
  withTransaction((scope) => ledgerTx.read.income(scope, listingId));
const readOwed = (attendeeId: number): Promise<number> =>
  withTransaction((scope) => ledgerTx.read.owed(scope, attendeeId));
const readModifierRevenue = (modifierId: number): Promise<number> =>
  withTransaction((scope) => ledgerTx.read.modifierRevenue(scope, modifierId));

describe("db > accounting > ledger-tx", () => {
  useTransactionalDb();

  test("read.income reflects sales and correct.income moves it onto the target", async () => {
    await postListingSale({ attendeeId: 1, gross: 5000, listingId: 1 });
    expect(await readIncome(1)).toBe(5000);

    await inOwnTx(ledgerTx.correct.income)(1, 8000);
    expect(await readIncome(1)).toBe(8000);
  });

  test("correct.income raises a figure from zero when nothing was posted yet", async () => {
    // A correction from a zero baseline: the credit posted is the whole target.
    await inOwnTx(ledgerTx.correct.income)(9, 700);
    expect(await readIncome(9)).toBe(700);
  });

  test("a correction posts one adjustment leg; re-correcting to it posts none", async () => {
    await postListingSale({ attendeeId: 1, gross: 5000, listingId: 1 });
    const beforeCorrection = (await allTransfers()).length;

    // Moving income onto a new target posts exactly one adjustment leg…
    await inOwnTx(ledgerTx.correct.income)(1, 8000);
    const afterFirst = (await allTransfers()).length;
    expect(afterFirst).toBe(beforeCorrection + 1);

    // …and re-submitting the same target computes a zero delta, so nothing else
    // is posted and the figure holds.
    await inOwnTx(ledgerTx.correct.income)(1, 8000);
    expect((await allTransfers()).length).toBe(afterFirst);
    expect(await readIncome(1)).toBe(8000);
  });

  /** A correction is filed under a key built from its own kind, so two kinds can
   *  never be taken for each other. Every expected part is spelled out and the
   *  key is rebuilt with the production helpers, so the check reads the same
   *  key a replay would. */
  const expectFiledUnderKind = async (
    correct: (tx: TxScope, id: number, target: number) => Promise<void>,
    kind: string,
    target: number,
    delta: number,
  ): Promise<void> => {
    using _time = new FakeTime(new Date("2026-06-21T00:00:00.000Z"));
    await inOwnTx(correct)(4, target);
    const legs = await allTransfers();
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    const parts = [kind, 4, delta, nowIso()];
    expect(leg.reference).toBe(await legReference(parts));
    expect(leg.eventGroup).toBe(await eventGroup(parts));
  };

  test("an income correction is filed under its own kind", async () => {
    await expectFiledUnderKind(
      ledgerTx.correct.income,
      "income-adjust",
      500,
      500,
    );
  });

  test("a modifier-revenue correction is filed under its own kind", async () => {
    await expectFiledUnderKind(
      ledgerTx.correct.modifierRevenue,
      "modifier-revenue-adjust",
      500,
      500,
    );
  });

  test("an owed correction is filed under its own kind", async () => {
    // Crediting the attendee lowers what they owe, so the change is negative.
    await expectFiledUnderKind(
      ledgerTx.correct.owed,
      "balance-adjust",
      500,
      -500,
    );
  });

  test("two kinds of correction in the same millisecond both post", async () => {
    // Freeze the clock so both posts share one millisecond, and use the same id
    // and the same size of change, so the ONLY thing keeping the two apart is
    // the kind of correction each one is. Without that, the second would hash
    // identically to the first and be dropped as a replay — a modifier's
    // revenue correction would silently vanish behind a listing's.
    using _time = new FakeTime(new Date("2026-06-21T00:00:00.000Z"));
    await inOwnTx(ledgerTx.correct.income)(4, 500);
    await inOwnTx(ledgerTx.correct.modifierRevenue)(4, 500);

    const legs = await allTransfers();
    expect(legs.length).toBe(2);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(2);
    expect(new Set(legs.map((leg) => leg.reference)).size).toBe(2);
    // And each figure really moved onto its own target.
    expect(await readIncome(4)).toBe(500);
  });

  test("correct.income lowers income onto a lower target", async () => {
    await postListingSale({ attendeeId: 1, gross: 5000, listingId: 1 });
    // Steering down to 2000 posts a negative delta (a write-off debit) — the
    // reverse direction of the raise above.
    await inOwnTx(ledgerTx.correct.income)(1, 2000);
    expect(await readIncome(1)).toBe(2000);
  });

  test("correct.owed lowers what an attendee owes onto the target", async () => {
    // An unpaid sale leaves attendee 1 owing 5000.
    await postTransfers([
      tx({
        destination: account("revenue", 1),
        reference: "unpaid-sale",
        source: account("attendee", 1),
      }),
    ]);
    expect(await readOwed(1)).toBe(5000);

    // Owed is the account balance's NEGATION, so it moves AGAINST the target —
    // steering it to 2000 credits the attendee, it does not bill them 3000 more.
    await inOwnTx(ledgerTx.correct.owed)(1, 2000);
    expect(await readOwed(1)).toBe(2000);
  });

  test("correct.owed raises what an attendee owes onto a higher target", async () => {
    await postTransfers([
      tx({
        destination: account("revenue", 1),
        reference: "unpaid-sale",
        source: account("attendee", 1),
      }),
    ]);
    // Raising owed 5000 → 7000 is the reverse direction: it debits the attendee
    // (owed moves against the target, so a higher target posts a negative credit).
    await inOwnTx(ledgerTx.correct.owed)(1, 7000);
    expect(await readOwed(1)).toBe(7000);
  });

  test("correct.modifierRevenue raises a modifier's net revenue onto the target", async () => {
    await postModifierLeg({ delta: 1000, modifierId: 3 });
    expect(await readModifierRevenue(3)).toBe(1000);

    await inOwnTx(ledgerTx.correct.modifierRevenue)(3, 2500);
    expect(await readModifierRevenue(3)).toBe(2500);
  });

  test("correct.modifierRevenue lowers a modifier's net revenue onto the target", async () => {
    await postModifierLeg({ delta: 2500, modifierId: 3 });
    // The reverse direction: steering revenue down to 1000 posts a negative delta.
    await inOwnTx(ledgerTx.correct.modifierRevenue)(3, 1000);
    expect(await readModifierRevenue(3)).toBe(1000);
  });
});
