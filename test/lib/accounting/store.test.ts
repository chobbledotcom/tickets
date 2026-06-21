import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  accountBalance,
  accountBalancesForIds,
  accountBalancesOfType,
  allTransfers,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import {
  LedgerConflictError,
  postTransfers,
  postTransfersTx,
} from "#shared/accounting/store.ts";
import { withTransaction } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { setupTransactionalTestDb } from "#test-utils";

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

describe("db > accounting > store", () => {
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    cleanup = await setupTransactionalTestDb();
  });
  afterEach(async () => {
    await cleanup();
  });

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

    test("rejects a colliding reference without committing the event's other legs", async () => {
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

  describe("postTransfersTx (composed in a wider transaction)", () => {
    test("commits the legs with the surrounding transaction", async () => {
      const result = await withTransaction((tx) =>
        postTransfersTx(tx, saleAndPayment()),
      );
      expect(result).toEqual({ inserted: 2, skipped: 0 });
      expect((await allTransfers()).length).toBe(2);
    });

    test("rolls the legs back when the surrounding transaction fails", async () => {
      // The whole point of the tx-scoped variant: a later failure in the same
      // transaction undoes the ledger legs, so a booking and its legs are
      // all-or-nothing.
      const error = await rejection(
        withTransaction(async (tx) => {
          await postTransfersTx(tx, saleAndPayment());
          throw new Error("surrounding work failed");
        }),
      );
      expect(error.message).toContain("surrounding work failed");
      expect((await allTransfers()).length).toBe(0);
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

  describe("balance queries", () => {
    const world = account("external", "world");

    test("accountBalance nets credits minus debits, zero when untouched", async () => {
      const attendee = account("attendee", 9);
      const revenue = account("revenue", 9);
      await postTransfers([
        tx({ destination: revenue, reference: "sale", source: attendee }),
        tx({
          amount: 2000,
          destination: attendee,
          reference: "pay",
          source: world,
        }),
      ]);
      expect(await accountBalance(revenue)).toBe(5000);
      expect(await accountBalance(attendee)).toBe(-3000); // still owes 3000
      expect(await accountBalance(account("revenue", 404))).toBe(0);
    });

    test("accountBalancesOfType returns every account of a type at once", async () => {
      await postTransfers([
        tx({
          amount: 1000,
          destination: account("revenue", 1),
          eventGroup: "e1",
          reference: "r1",
          source: account("attendee", 1),
        }),
      ]);
      await postTransfers([
        tx({
          amount: 3000,
          destination: account("revenue", 2),
          eventGroup: "e2",
          reference: "r2",
          source: account("attendee", 2),
        }),
      ]);
      const income = await accountBalancesOfType("revenue");
      expect(income.get("1")).toBe(1000);
      expect(income.get("2")).toBe(3000);
    });

    test("accountBalancesForIds scopes to given ids; empty is a no-op", async () => {
      await postTransfers([
        tx({
          amount: 1000,
          destination: account("revenue", 1),
          reference: "r1",
          source: account("attendee", 1),
        }),
        tx({
          amount: 3000,
          destination: account("revenue", 2),
          reference: "r2",
          source: account("attendee", 2),
        }),
      ]);
      const scoped = await accountBalancesForIds("revenue", ["1"]);
      expect(scoped.get("1")).toBe(1000);
      expect(scoped.has("2")).toBe(false);
      expect((await accountBalancesForIds("revenue", [])).size).toBe(0);
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
