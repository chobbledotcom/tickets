import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LedgerConflictError } from "#shared/accounting/conflicts.ts";
import {
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { postTransfers, postTransfersTx } from "#shared/accounting/store.ts";
import { withTransaction } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import {
  rejection,
  saleAndPayment,
  tx,
  useTransactionalDb,
} from "#test-utils/ledger.ts";

describe("db > accounting > store", () => {
  useTransactionalDb();

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

    test("rejects duplicate references within one post", async () => {
      const error = await rejection(
        postTransfers([
          tx({ reference: "dup" }),
          tx({
            destination: account("fee_income", "booking"),
            reference: "dup",
          }),
        ]),
      );
      expect(error.message).toContain("duplicate reference");
      expect((await allTransfers()).length).toBe(0);
    });

    test("rejects a colliding reference without committing the other legs", async () => {
      await postTransfers([tx({ eventGroup: "evt-a", reference: "shared" })]);
      // evt-b reuses evt-a's reference for one leg and adds a fresh leg. The
      // collision is caught before inserting, so the fresh leg is never written
      // (a post-insert check would leave it behind as a partial event).
      const error = await rejection(
        postTransfers([
          tx({ eventGroup: "evt-b", reference: "shared" }),
          tx({
            destination: account("fee_income", "booking"),
            eventGroup: "evt-b",
            reference: "fresh-leg",
          }),
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect((await allTransfers()).length).toBe(1);
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

    test("rejects legs that span more than one currency", async () => {
      // Each leg passes per-leg validation, but a mixed-currency event would
      // later make every balance projection throw — reject it at the boundary.
      const error = await rejection(
        postTransfers([
          tx({ currency: "GBP", reference: "gbp" }),
          tx({
            currency: "USD",
            destination: account("fee_income", "booking"),
            reference: "usd",
          }),
        ]),
      );
      expect(error.message).toContain("one currency");
      expect((await allTransfers()).length).toBe(0);
    });

    test("rejects a new event in a different currency than the ledger holds", async () => {
      // The first post establishes GBP; a later USD event (e.g. after a site
      // currency change) would make whole-ledger projections throw, so reject it.
      await postTransfers([tx({ currency: "GBP", reference: "gbp-1" })]);
      const error = await rejection(
        postTransfers([
          tx({ currency: "USD", eventGroup: "evt-2", reference: "usd-1" }),
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("currency");
      expect((await allTransfers()).length).toBe(1);
    });

    test("treats an empty post as a no-op", async () => {
      expect(await postTransfers([])).toEqual({ inserted: 0, skipped: 0 });
      expect((await allTransfers()).length).toBe(0);
    });
  });

  describe("postTransfersTx (composed in a wider transaction)", () => {
    test("commits the legs with the surrounding transaction", async () => {
      const result = await withTransaction((t) =>
        postTransfersTx(t, saleAndPayment()),
      );
      expect(result).toEqual({ inserted: 2, skipped: 0 });
      expect((await allTransfers()).length).toBe(2);
    });

    test("rolls the legs back when the surrounding transaction fails", async () => {
      // The whole point of the tx-scoped variant: a later failure in the same
      // transaction undoes the ledger legs, so a booking and its legs are
      // all-or-nothing.
      const error = await rejection(
        withTransaction(async (t) => {
          await postTransfersTx(t, saleAndPayment());
          throw new Error("surrounding work failed");
        }),
      );
      expect(error.message).toContain("surrounding work failed");
      expect((await allTransfers()).length).toBe(0);
    });
  });
});
