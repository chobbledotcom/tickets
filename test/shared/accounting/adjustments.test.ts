import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { revenueAccount, WRITEOFF } from "#accounting/accounts.ts";
import { writeoffAdjustmentInserts } from "#accounting/adjustments.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import { accountKey } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import {
  postWriteoffAdjustment,
  useTransactionalDb,
} from "#test-utils/ledger.ts";

describe("db > accounting > postWriteoffAdjustment", () => {
  useTransactionalDb();

  const revenue = revenueAccount(7);

  /** Post one write-off adjustment to `revenue` and return its sole transfer
   *  leg, first asserting nothing else was posted. */
  const postSoleAdjustment = async (delta: number) => {
    await postWriteoffAdjustment(revenue, delta, ["income-adjust", 7]);
    const [leg, ...rest] = await allTransfers();
    expect(rest).toEqual([]);
    return leg!;
  };

  test("a zero delta posts nothing", async () => {
    await postWriteoffAdjustment(revenue, 0, ["income-adjust", 7]);
    expect(await allTransfers()).toEqual([]);
  });

  /** Post one adjustment and assert the leg it wrote: how big it is, which way
   *  the money flowed, and the balance it left behind. Every expected value is
   *  spelled out, so the check never re-derives the rule it is testing. */
  const expectAdjustment = async ({
    amount,
    balance,
    delta,
    from,
    to,
  }: {
    amount: number;
    balance: number;
    delta: number;
    from: AccountRef;
    to: AccountRef;
  }): Promise<void> => {
    const leg = await postSoleAdjustment(delta);
    expect(leg.kind).toBe("adjustment");
    expect(leg.amount).toBe(amount);
    expect(accountKey(leg.source)).toBe(accountKey(from));
    expect(accountKey(leg.destination)).toBe(accountKey(to));
    expect(await accountBalance(revenue)).toBe(balance);
  };

  test("a positive delta credits the account (writeoff → account)", async () => {
    // Crediting the account: money flows from writeoff into the account, and
    // its balance rises by the delta.
    await expectAdjustment({
      amount: 1500,
      balance: 1500,
      delta: 1500,
      from: WRITEOFF,
      to: revenue,
    });
  });

  test("the smallest credit still flows into the account", async () => {
    // One minor unit is a credit like any other: the direction turns on the
    // sign of the delta, not on it clearing some larger figure.
    await expectAdjustment({
      amount: 1,
      balance: 1,
      delta: 1,
      from: WRITEOFF,
      to: revenue,
    });
  });

  test("a negative delta debits the account (account → writeoff)", async () => {
    // Debiting the account: money flows out to writeoff, its balance falls, and
    // the amount posted is the magnitude of the delta.
    await expectAdjustment({
      amount: 1200,
      balance: -1200,
      delta: -1200,
      from: revenue,
      to: WRITEOFF,
    });
  });

  test("amount is the absolute value of the delta either way", async () => {
    await postWriteoffAdjustment(revenue, -300, ["income-adjust", 7]);
    const [leg] = await allTransfers();
    expect(leg!.amount).toBe(300);
  });

  test("repeated edits of the same figure each post a distinct event", async () => {
    // Two edits of the SAME signed figure at DIFFERENT instants must each post:
    // raising income by 1000, then later raising it by 1000 again. The delta is
    // identical, so only the fresh `occurredAt` in the references keeps them
    // distinct — without it the second would collide on `[...keyParts, delta]`
    // and INSERT OR IGNORE would drop it. Freeze the clock and tick it forward a
    // millisecond between posts so this exercises the occurredAt axis
    // deterministically (no reliance on real wall-clock resolution). `using`
    // restores the real clock at block exit even if an assertion throws, so a
    // failure here never leaks the frozen clock into later tests.
    using time = new FakeTime(new Date("2026-06-21T00:00:00.000Z"));
    await postWriteoffAdjustment(revenue, 1000, ["income-adjust", 7]);
    time.tick(1);
    await postWriteoffAdjustment(revenue, 1000, ["income-adjust", 7]);
    expect((await allTransfers()).length).toBe(2);
    // Both raises land, so the account rises by the full 2000.
    expect(await accountBalance(revenue)).toBe(2000);
  });

  test("two opposite corrections in the same millisecond both post", async () => {
    // Freeze the clock so both posts share one millisecond `occurredAt`. Because
    // the signed delta is part of the reference, the raise and the lower hash
    // differently and both land — without it they would collide on
    // `[...keyParts, occurredAt]` and INSERT OR IGNORE would drop the second.
    // `using` restores the real clock on block exit, throw or not.
    using _time = new FakeTime(new Date("2026-06-21T00:00:00.000Z"));
    await postWriteoffAdjustment(revenue, 1000, ["income-adjust", 7]);
    await postWriteoffAdjustment(revenue, -1000, ["income-adjust", 7]);
    expect((await allTransfers()).length).toBe(2);
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

describe("writeoffAdjustmentInserts (folded into a wider batch)", () => {
  const revenue = revenueAccount(7);

  test("builds one INSERT OR IGNORE per non-zero adjustment, dropping zero deltas", async () => {
    // An attendee merge passes one adjustment per discarded booking; a zero-delta
    // one (a booking that left nothing to write off) posts nothing, so only the
    // non-zero adjustments become statements.
    const inserts = await writeoffAdjustmentInserts(
      [
        { account: revenue, delta: 1500, keyParts: ["merge", 7] },
        { account: revenue, delta: 0, keyParts: ["merge", 8] },
        { account: revenue, delta: -200, keyParts: ["merge", 9] },
      ],
      "2026-06-21T00:00:00.000Z",
    );
    expect(inserts.length).toBe(2);
    for (const stmt of inserts) {
      expect(stmt.sql).toContain("INSERT OR IGNORE");
    }
  });

  test("an all-zero set yields no statements at all", async () => {
    const inserts = await writeoffAdjustmentInserts(
      [{ account: revenue, delta: 0, keyParts: ["merge", 7] }],
      "2026-06-21T00:00:00.000Z",
    );
    expect(inserts).toEqual([]);
  });
});
