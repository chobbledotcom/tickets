import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { revenueAccount, WRITEOFF } from "#shared/accounting/accounts.ts";
import { postWriteoffAdjustment } from "#shared/accounting/adjustments.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { accountKey } from "#shared/ledger/account.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";

describe("db > accounting > postWriteoffAdjustment", () => {
  useTransactionalDb();

  const revenue = revenueAccount(7);

  test("a zero delta posts nothing", async () => {
    await postWriteoffAdjustment(revenue, 0, ["income-adjust", 7]);
    expect(await allTransfers()).toEqual([]);
  });

  test("a positive delta credits the account (writeoff → account)", async () => {
    await postWriteoffAdjustment(revenue, 1500, ["income-adjust", 7]);
    const [leg, ...rest] = await allTransfers();
    expect(rest).toEqual([]);
    expect(leg!.kind).toBe("adjustment");
    expect(leg!.amount).toBe(1500);
    // Crediting the account: money flows from writeoff into the account.
    expect(accountKey(leg!.source)).toBe(accountKey(WRITEOFF));
    expect(accountKey(leg!.destination)).toBe(accountKey(revenue));
    // balanceOf(account) rises by the delta.
    expect(await accountBalance(revenue)).toBe(1500);
  });

  test("a negative delta debits the account (account → writeoff)", async () => {
    await postWriteoffAdjustment(revenue, -1200, ["income-adjust", 7]);
    const [leg, ...rest] = await allTransfers();
    expect(rest).toEqual([]);
    expect(leg!.kind).toBe("adjustment");
    // amount is the magnitude of the delta.
    expect(leg!.amount).toBe(1200);
    // Debiting the account: money flows from the account out to writeoff.
    expect(accountKey(leg!.source)).toBe(accountKey(revenue));
    expect(accountKey(leg!.destination)).toBe(accountKey(WRITEOFF));
    // balanceOf(account) falls by the delta.
    expect(await accountBalance(revenue)).toBe(-1200);
  });

  test("amount is the absolute value of the delta either way", async () => {
    await postWriteoffAdjustment(revenue, -300, ["income-adjust", 7]);
    const [leg] = await allTransfers();
    expect(leg!.amount).toBe(300);
  });

  test("repeated edits of the same figure each post a distinct event", async () => {
    // The poster mixes a fresh occurredAt into the references, so raising then
    // lowering the same figure must not collide (idempotent-replay) — both land.
    await postWriteoffAdjustment(revenue, 1000, ["income-adjust", 7]);
    await postWriteoffAdjustment(revenue, -1000, ["income-adjust", 7]);
    const all = await allTransfers();
    expect(all.length).toBe(2);
    // The two corrections net the account back to zero.
    expect(await accountBalance(revenue)).toBe(0);
  });

  test("the writeoff account mirrors the opposite of the adjusted figure", async () => {
    // A credit to revenue sinks from writeoff, so writeoff's own balance falls by
    // the same amount — conservation holds (Σ balance == 0 across the pair).
    await postWriteoffAdjustment(revenue, 800, ["income-adjust", 7]);
    expect(await accountBalance(revenue)).toBe(800);
    expect(await accountBalance(WRITEOFF)).toBe(-800);
  });
});
