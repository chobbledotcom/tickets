import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allTransfers,
  LedgerConflictError,
  postTransfers,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { describeWithEnv } from "#test-utils";

const tx = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  amount: 5000,
  currency: "GBP",
  destination: account("revenue", 1),
  eventGroup: "evt-1",
  occurredAt: "2026-06-21T00:00:00.000Z",
  reference: "ref-default",
  source: account("attendee", 1),
  ...overrides,
});

/** Run a promise expected to reject and return the thrown error. */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
};

describeWithEnv("db > accounting > store", { db: true }, () => {
  describe("postTransfers", () => {
    test("round-trips transfers and feeds the balance projections", async () => {
      const attendee = account("attendee", 3);
      const revenue = account("revenue", 7);
      const result = await postTransfers([
        tx({ destination: revenue, reference: "sale-1", source: attendee }),
        tx({
          destination: attendee,
          reference: "pay-1",
          source: account("external", "world"),
        }),
      ]);
      expect(result).toEqual({ inserted: 2, skipped: 0 });

      expect(balanceOf(attendee)(await transfersByAccount(attendee))).toBe(0);
      expect(balanceOf(revenue)(await transfersByAccount(revenue))).toBe(5000);
    });

    test("is idempotent: replaying matching references writes nothing", async () => {
      const legs = [
        tx({ reference: "sale-1" }),
        tx({
          destination: account("attendee", 1),
          reference: "pay-1",
          source: account("external", "world"),
        }),
      ];
      expect(await postTransfers(legs)).toEqual({ inserted: 2, skipped: 0 });
      expect(await postTransfers(legs)).toEqual({ inserted: 0, skipped: 2 });
      expect((await allTransfers()).length).toBe(2);
    });

    test("rejects a reused reference with different financial facts", async () => {
      await postTransfers([tx({ amount: 5000, reference: "sale-1" })]);
      const error = await rejection(
        postTransfers([tx({ amount: 9999, reference: "sale-1" })]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("amount");
      expect((await allTransfers()).length).toBe(1);
    });

    test("inserts only the new legs on a partial replay", async () => {
      const a = tx({ reference: "a" });
      const b = tx({ reference: "b", source: account("attendee", 9) });
      expect(await postTransfers([a, b])).toEqual({ inserted: 2, skipped: 0 });

      const c = tx({ reference: "c", source: account("attendee", 9) });
      expect(await postTransfers([a, c])).toEqual({ inserted: 1, skipped: 1 });
      expect((await allTransfers()).length).toBe(3);
    });

    test("rejects an invalid transfer before writing anything", async () => {
      const error = await rejection(
        postTransfers([tx({ amount: 0, reference: "bad" })]),
      );
      expect(error.message).toContain("non_positive_amount");
      expect((await allTransfers()).length).toBe(0);
    });

    test("treats an empty post as a no-op", async () => {
      expect(await postTransfers([])).toEqual({ inserted: 0, skipped: 0 });
      expect((await allTransfers()).length).toBe(0);
    });

    test("preserves kind, memo, posted_by and reverses_id round-trip", async () => {
      await postTransfers([tx({ reference: "orig" })]);
      const stored = await allTransfers();
      const orig = stored[0]!;
      expect(orig.kind).toBe("");
      expect(orig.reversesId).toBeUndefined();

      await postTransfers([
        tx({
          kind: "reversal",
          memo: "owner-key-ciphertext",
          postedBy: "user:5",
          reference: "void",
          reversesId: orig.id,
        }),
      ]);
      const legs = await transfersByEventGroup("evt-1");
      const voided = legs.find((t) => t.reference === "void")!;
      expect(voided.kind).toBe("reversal");
      expect(voided.memo).toBe("owner-key-ciphertext");
      expect(voided.postedBy).toBe("user:5");
      expect(voided.reversesId).toBe(orig.id);
    });
  });

  describe("reads", () => {
    test("transfersByEventGroup returns only that event's legs", async () => {
      await postTransfers([
        tx({ eventGroup: "evt-x", reference: "x-sale" }),
        tx({ eventGroup: "evt-x", reference: "x-fee" }),
        tx({ eventGroup: "evt-y", reference: "y-sale" }),
      ]);
      const legs = await transfersByEventGroup("evt-x");
      expect(legs.map((t) => t.reference).toSorted()).toEqual([
        "x-fee",
        "x-sale",
      ]);
    });
  });
});
