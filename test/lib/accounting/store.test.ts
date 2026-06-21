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

const saleAndPayment = (): TransferInput[] => [
  tx({ reference: "sale-1", source: account("attendee", 1) }),
  tx({
    destination: account("attendee", 1),
    reference: "pay-1",
    source: account("external", "world"),
  }),
];

describeWithEnv("db > accounting > store", { db: true }, () => {
  describe("postTransfers", () => {
    test("round-trips an event and feeds the balance projections", async () => {
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

    test("replaying the same event writes nothing", async () => {
      const legs = saleAndPayment();
      expect(await postTransfers(legs)).toEqual({ inserted: 2, skipped: 0 });
      expect(await postTransfers(legs)).toEqual({ inserted: 0, skipped: 2 });
      expect((await allTransfers()).length).toBe(2);
    });

    test("rejects a replay whose leg changed financial facts", async () => {
      await postTransfers([tx({ amount: 5000, reference: "sale-1" })]);
      const error = await rejection(
        postTransfers([tx({ amount: 9999, reference: "sale-1" })]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("amount");
      expect((await allTransfers()).length).toBe(1);
    });

    test("rejects a replay that adds a leg to a posted event", async () => {
      await postTransfers(saleAndPayment());
      const error = await rejection(
        postTransfers([
          ...saleAndPayment(),
          tx({
            destination: account("fee_income", "booking"),
            reference: "fee-1",
          }),
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect((await allTransfers()).length).toBe(2);
    });

    test("rejects a replay that drops a leg from a posted event", async () => {
      await postTransfers(saleAndPayment());
      const error = await rejection(
        postTransfers([
          tx({ reference: "sale-1", source: account("attendee", 1) }),
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect((await allTransfers()).length).toBe(2);
    });

    test("rejects an invalid transfer before writing anything", async () => {
      const error = await rejection(
        postTransfers([tx({ amount: 0, reference: "bad" })]),
      );
      expect(error.message).toContain("non_positive_amount");
      expect((await allTransfers()).length).toBe(0);
    });

    test("rejects legs that span more than one event group", async () => {
      const error = await rejection(
        postTransfers([
          tx({ eventGroup: "evt-a", reference: "a" }),
          tx({ eventGroup: "evt-b", reference: "b" }),
        ]),
      );
      expect(error.message).toContain("one eventGroup");
    });

    test("treats an empty post as a no-op", async () => {
      expect(await postTransfers([])).toEqual({ inserted: 0, skipped: 0 });
      expect((await allTransfers()).length).toBe(0);
    });

    test("preserves kind/memo/posted_by/reverses_id and replays them", async () => {
      const legs = [
        tx({ eventGroup: "e1", reference: "orig" }),
        tx({
          destination: account("attendee", 1),
          eventGroup: "e1",
          kind: "reversal",
          memo: "owner-key-ciphertext",
          postedBy: "user:5",
          reference: "void",
          reversesId: 1,
          source: account("revenue", 1),
        }),
      ];
      expect(await postTransfers(legs)).toEqual({ inserted: 2, skipped: 0 });
      // Replaying exercises the reversesId/kind equality path too.
      expect(await postTransfers(legs)).toEqual({ inserted: 0, skipped: 2 });

      const stored = await transfersByEventGroup("e1");
      const voided = stored.find((t) => t.reference === "void")!;
      expect(voided.kind).toBe("reversal");
      expect(voided.memo).toBe("owner-key-ciphertext");
      expect(voided.postedBy).toBe("user:5");
      expect(voided.reversesId).toBe(1);
      const orig = stored.find((t) => t.reference === "orig")!;
      expect(orig.reversesId).toBeUndefined();
      expect(orig.kind).toBe("");
    });
  });

  describe("reads", () => {
    test("transfersByEventGroup returns only that event's legs", async () => {
      await postTransfers([
        tx({ eventGroup: "evt-x", reference: "x-sale" }),
        tx({
          destination: account("attendee", 1),
          eventGroup: "evt-x",
          reference: "x-pay",
          source: account("external", "world"),
        }),
      ]);
      await postTransfers([tx({ eventGroup: "evt-y", reference: "y-sale" })]);
      const legs = await transfersByEventGroup("evt-x");
      expect(legs.map((t) => t.reference).toSorted()).toEqual([
        "x-pay",
        "x-sale",
      ]);
    });
  });
});
