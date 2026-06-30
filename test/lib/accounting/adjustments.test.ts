import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { revenueAccount, WRITEOFF } from "#shared/accounting/accounts.ts";
import { writeoffAdjustmentInserts } from "#shared/accounting/adjustments.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import { accountKey } from "#shared/ledger/account.ts";
import {
  postWriteoffAdjustment,
  useTransactionalDb,
} from "#test-utils/ledger.ts";

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

  test("two opposite corrections in the same millisecond both post", async () => {
    // Freeze the clock so both posts share one millisecond `occurredAt`. Because
    // the signed delta is part of the reference, the raise and the lower hash
    // differently and both land — without it they would collide on
    // `[...keyParts, occurredAt]` and INSERT OR IGNORE would drop the second.
    const time = new FakeTime(new Date("2026-06-21T00:00:00.000Z"));
    try {
      await postWriteoffAdjustment(revenue, 1000, ["income-adjust", 7]);
      await postWriteoffAdjustment(revenue, -1000, ["income-adjust", 7]);
      expect((await allTransfers()).length).toBe(2);
      expect(await accountBalance(revenue)).toBe(0);
    } finally {
      time.restore();
    }
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
