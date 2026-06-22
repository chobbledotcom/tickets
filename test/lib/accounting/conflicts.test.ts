import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LedgerConflictError } from "#shared/accounting/conflicts.ts";
import {
  allTransfers,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import {
  rejection,
  saleAndPayment,
  tx,
  useTransactionalDb,
} from "#test-utils/ledger.ts";

describe("db > accounting > conflicts", () => {
  useTransactionalDb();

  describe("replay divergence", () => {
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

    test("replays the same instant in a different ISO form as a no-op", async () => {
      // The store persists time as epoch-millis and reads it back canonical, so
      // a replay carrying the same moment without milliseconds, or as an offset,
      // must match the stored leg rather than read as an occurredAt conflict.
      await postTransfers([tx({ occurredAt: "2026-06-21T00:00:00Z" })]);
      expect(
        await postTransfers([tx({ occurredAt: "2026-06-21T01:00:00+01:00" })]),
      ).toEqual({ inserted: 0, skipped: 1 });
      expect((await allTransfers()).length).toBe(1);
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

  describe("reversal links", () => {
    const postSale = (): Promise<unknown> =>
      postTransfers([
        tx({
          destination: account("revenue", 1),
          eventGroup: "evt-1",
          reference: "sale",
          source: account("attendee", 1),
        }),
      ]);
    const storedSaleId = async (): Promise<number> =>
      (await transfersByEventGroup("evt-1"))[0]!.id;
    const voidLeg = (overrides: Partial<TransferInput>): TransferInput =>
      tx({
        destination: account("attendee", 1),
        eventGroup: "evt-2",
        reference: "void",
        source: account("revenue", 1),
        ...overrides,
      });

    test("accepts a leg that is the exact inverse of the original", async () => {
      await postSale();
      const result = await postTransfers([
        voidLeg({ reversesId: await storedSaleId() }),
      ]);
      expect(result.inserted).toBe(1);
    });

    test("rejects a reverses_id that refers to no transfer", async () => {
      expect(
        (await rejection(postTransfers([voidLeg({ reversesId: 9999 })])))
          .message,
      ).toContain("refers to no transfer");
    });

    test("rejects a reversal whose amount differs from the original", async () => {
      await postSale();
      const error = await rejection(
        postTransfers([
          voidLeg({ amount: 4000, reversesId: await storedSaleId() }),
        ]),
      );
      expect(error.message).toContain("not the exact inverse");
    });

    test("rejects a reversal that does not swap the accounts", async () => {
      await postSale();
      const error = await rejection(
        postTransfers([
          voidLeg({
            destination: account("revenue", 1),
            reversesId: await storedSaleId(),
            source: account("attendee", 1),
          }),
        ]),
      );
      expect(error.message).toContain("not the exact inverse");
    });
  });
});
