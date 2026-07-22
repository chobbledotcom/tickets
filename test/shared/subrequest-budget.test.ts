import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BULK_REFUND_LIMIT,
  BUNNY_SUBREQUEST_LIMIT,
  countSubrequest,
  getSubrequestRemaining,
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";

describe("combined subrequest budget", () => {
  test("reports the full allowance outside a request scope", async () => {
    expect(getSubrequestRemaining()).toEqual({
      database: BUNNY_SUBREQUEST_LIMIT,
      external: BUNNY_SUBREQUEST_LIMIT,
      total: BUNNY_SUBREQUEST_LIMIT,
    });
    await withSubrequestAllowance(
      { database: 1, external: 1, total: 2 },
      async () => {
        expect(getSubrequestRemaining()).toEqual({
          database: 1,
          external: 1,
          total: 2,
        });
      },
    );
  });

  test("tracks database and external calls in one envelope", async () => {
    await runWithSubrequestBudget(async () => {
      countSubrequest("database", "claim");
      countSubrequest("external", "provider");
      expect(getSubrequestUsage()).toEqual({
        database: 1,
        external: 1,
        total: 2,
      });
      await withSubrequestAllowance(
        { database: 0, external: 0, total: 0 },
        async () => {
          expect(getSubrequestRemaining()).toEqual({
            database: 0,
            external: 0,
            total: 0,
          });
        },
      );
    });
  });

  test("enforces each task allowance and its combined maximum", async () => {
    await runWithSubrequestBudget(async () => {
      await withSubrequestAllowance(
        { database: 2, external: 1, total: 3 },
        async () => {
          expect(getSubrequestRemaining()).toEqual({
            database: 2,
            external: 1,
            total: 3,
          });
          countSubrequest("database", "first");
          countSubrequest("database", "second");
          countSubrequest("external", "third");
          expect(() => countSubrequest("database", "fourth")).toThrow(
            "Subrequest allowance exceeded",
          );
        },
      );
    });
  });

  test("counts work already used before a nested allowance", async () => {
    await runWithSubrequestBudget(async () => {
      countSubrequest("database", "setup");
      await withSubrequestAllowance(
        { database: 1, external: 0, total: 1 },
        async () => {
          countSubrequest("database", "task");
          expect(getSubrequestUsage().total).toBe(2);
        },
      );
    });
  });

  test("enforces a per-kind limit before the combined limit", async () => {
    await runWithSubrequestBudget(async () => {
      await withSubrequestAllowance(
        { database: 0, external: 5, total: 5 },
        async () => {
          expect(() => countSubrequest("database", "blocked database")).toThrow(
            "Subrequest allowance exceeded",
          );
        },
      );
    });
  });

  test("enforces the combined limit before either per-kind limit", async () => {
    await runWithSubrequestBudget(async () => {
      await withSubrequestAllowance(
        { database: 2, external: 2, total: 1 },
        async () => {
          countSubrequest("database", "first");
          expect(() => countSubrequest("external", "blocked total")).toThrow(
            "Subrequest allowance exceeded",
          );
        },
      );
    });
  });

  test("reserves five provider calls for bounded bulk refunds", () => {
    expect(BULK_REFUND_LIMIT).toBe(5);
  });

  test("does not count startup work outside a request scope", () => {
    countSubrequest("external", "startup");
    expect(getSubrequestUsage()).toEqual({
      database: 0,
      external: 0,
      total: 0,
    });
  });
});
