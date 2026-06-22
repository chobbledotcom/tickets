import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LedgerConflictError } from "#shared/accounting/conflicts.ts";
import {
  allTransfers,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import {
  postTransferGroups,
  postTransfers,
  postTransfersTx,
} from "#shared/accounting/store.ts";
import { withTransaction } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
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

  describe("postTransferGroups (one atomic batch of many events)", () => {
    /** A sale+payment event for `attendeeId`, isolated under its own group. */
    const event = (group: string, attendeeId: number): TransferInput[] => [
      tx({
        destination: account("revenue", attendeeId),
        eventGroup: group,
        reference: `sale-${group}`,
        source: account("attendee", attendeeId),
      }),
      tx({
        destination: account("attendee", attendeeId),
        eventGroup: group,
        reference: `pay-${group}`,
        source: account("external", "world"),
      }),
    ];

    test("posts many independent events together and feeds projections", async () => {
      const results = await postTransferGroups([
        event("evt-a", 1),
        event("evt-b", 2),
      ]);
      expect(results).toEqual([
        { inserted: 2, skipped: 0 },
        { inserted: 2, skipped: 0 },
      ]);
      expect((await allTransfers()).length).toBe(4);
      const rev1 = account("revenue", 1);
      const rev2 = account("revenue", 2);
      expect(balanceOf(rev1)(await transfersByAccount(rev1))).toBe(5000);
      expect(balanceOf(rev2)(await transfersByAccount(rev2))).toBe(5000);
    });

    test("replays an already-stored event as a skip while inserting the new one", async () => {
      await postTransferGroups([event("evt-a", 1)]);
      // evt-a's two stored legs are re-loaded and matched (a skip); evt-b is new.
      const results = await postTransferGroups([
        event("evt-a", 1),
        event("evt-b", 2),
      ]);
      expect(results).toEqual([
        { inserted: 0, skipped: 2 },
        { inserted: 2, skipped: 0 },
      ]);
      expect((await allTransfers()).length).toBe(4);
    });

    test("rejects a changed leg on an already-stored event, writing nothing", async () => {
      await postTransferGroups([event("evt-a", 1)]);
      const [sale, pay] = event("evt-a", 1);
      const error = await rejection(
        postTransferGroups([[{ ...sale!, amount: 9999 }, pay!]]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("amount");
      expect((await allTransfers()).length).toBe(2);
    });

    test("rejects a reference that already belongs to a different event", async () => {
      await postTransfers([tx({ eventGroup: "evt-a", reference: "shared" })]);
      const error = await rejection(
        postTransferGroups([
          [tx({ eventGroup: "evt-b", reference: "shared" })],
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("different event");
      expect((await allTransfers()).length).toBe(1);
    });

    test("rejects a duplicate reference across two groups in the batch", async () => {
      const error = await rejection(
        postTransferGroups([
          [tx({ eventGroup: "evt-a", reference: "dup" })],
          [
            tx({
              destination: account("fee_income", "booking"),
              eventGroup: "evt-b",
              reference: "dup",
            }),
          ],
        ]),
      );
      expect(error.message).toContain("duplicate reference across the batch");
      expect((await allTransfers()).length).toBe(0);
    });

    test("rejects a batch whose groups disagree on currency", async () => {
      const error = await rejection(
        postTransferGroups([
          [tx({ currency: "GBP", eventGroup: "evt-a", reference: "gbp" })],
          [tx({ currency: "USD", eventGroup: "evt-b", reference: "usd" })],
        ]),
      );
      expect(error.message).toContain("one currency");
      expect((await allTransfers()).length).toBe(0);
    });

    test("rejects a batch in a different currency than the ledger holds", async () => {
      await postTransferGroups([
        [tx({ currency: "GBP", eventGroup: "evt-a", reference: "gbp" })],
      ]);
      const error = await rejection(
        postTransferGroups([
          [tx({ currency: "USD", eventGroup: "evt-b", reference: "usd" })],
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("currency");
      expect((await allTransfers()).length).toBe(1);
    });

    test("validates every group up front, rejecting the whole batch before any write", async () => {
      const error = await rejection(
        postTransferGroups([
          event("evt-a", 1),
          [tx({ amount: 0, eventGroup: "evt-b", reference: "bad" })],
        ]),
      );
      expect(error.message).toContain("non_positive_amount");
      // All-or-nothing: the valid group is not written either.
      expect((await allTransfers()).length).toBe(0);
    });

    test("treats an all-empty batch as a no-op, one result per group", async () => {
      expect(await postTransferGroups([[], []])).toEqual([
        { inserted: 0, skipped: 0 },
        { inserted: 0, skipped: 0 },
      ]);
      expect((await allTransfers()).length).toBe(0);
    });

    test("keeps results aligned with the input groups around empty groups", async () => {
      const results = await postTransferGroups([[], event("evt-a", 1), []]);
      expect(results).toEqual([
        { inserted: 0, skipped: 0 },
        { inserted: 2, skipped: 0 },
        { inserted: 0, skipped: 0 },
      ]);
      expect((await allTransfers()).length).toBe(2);
    });

    test("posts a valid reversal, checking it against the pre-loaded original", async () => {
      await postTransfers([
        tx({ eventGroup: "evt-1", reference: "sale" }),
      ]);
      const originalId = (await transfersByEventGroup("evt-1"))[0]!.id;
      const result = await postTransferGroups([
        [
          tx({
            destination: account("attendee", 1),
            eventGroup: "evt-2",
            reference: "void",
            reversesId: originalId,
            source: account("revenue", 1),
          }),
        ],
      ]);
      expect(result).toEqual([{ inserted: 1, skipped: 0 }]);
    });

    test("rejects a reversal whose original is missing", async () => {
      const error = await rejection(
        postTransferGroups([
          [
            tx({
              destination: account("attendee", 1),
              eventGroup: "evt-2",
              reference: "void",
              reversesId: 999_999,
              source: account("revenue", 1),
            }),
          ],
        ]),
      );
      expect(error).toBeInstanceOf(LedgerConflictError);
      expect(error.message).toContain("refers to no transfer");
    });
  });
});
