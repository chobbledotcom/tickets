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
import { inOwnTx, ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { withTransaction } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
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
