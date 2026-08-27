import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BUNNY_SUBREQUEST_LIMIT,
  countSubrequest,
  getSubrequestRemaining,
  getSubrequestUsage,
  runWithSubrequestBudget,
  SubrequestBudgetError,
  withSubrequestAllowance,
  withSubrequestReserve,
} from "#shared/subrequest-budget.ts";

/**
 * Run `work` in a request that has spent every subrequest it had.
 *
 * The migration runner stops its batch and continues on the next request when
 * the budget runs out, and reads the type rather than the message to tell that
 * refusal from a real defect. Both refusals below are raised from this state.
 */
const withNothingLeft = (work: () => void): void =>
  runWithSubrequestBudget(() =>
    withSubrequestAllowance({ database: 0, external: 0, total: 0 }, work),
  );

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

  test("a refused call leaves its reserved tail untouched", async () => {
    await runWithSubrequestBudget(async () => {
      await withSubrequestReserve(
        { database: 1, external: 0, total: 1 },
        async () => {
          for (let call = 0; call < BUNNY_SUBREQUEST_LIMIT - 1; call++) {
            countSubrequest("database", "bounded work");
          }
          expect(() => countSubrequest("database", "blocked work")).toThrow(
            "Subrequest allowance exceeded",
          );
        },
      );

      expect(getSubrequestRemaining()).toEqual({
        database: 1,
        external: BUNNY_SUBREQUEST_LIMIT,
        total: 1,
      });
      countSubrequest("database", "reserved cleanup");
    });
  });

  test("refuses to start when the promised tail no longer fits", async () => {
    await runWithSubrequestBudget(async () => {
      for (let call = 0; call < BUNNY_SUBREQUEST_LIMIT - 1; call++) {
        countSubrequest("database", "earlier work");
      }
      let ran = false;

      expect(() =>
        withSubrequestReserve({ database: 2, external: 0, total: 2 }, () => {
          ran = true;
        }),
      ).toThrow("Subrequest reserve unavailable");
      expect(ran).toBe(false);
      expect(getSubrequestRemaining()).toEqual({
        database: 1,
        external: BUNNY_SUBREQUEST_LIMIT,
        total: 1,
      });
    });
  });

  test("a call blocked at the cap raises the type a caller stops on", () => {
    withNothingLeft(() => {
      expect(() => countSubrequest("database", "blocked call")).toThrow(
        SubrequestBudgetError,
      );
    });
  });

  test("a reserve that no longer fits raises the type a caller stops on", () => {
    withNothingLeft(() => {
      expect(() =>
        withSubrequestReserve({ database: 1, external: 0, total: 1 }, () => {
          throw new Error("reserved work must not run");
        }),
      ).toThrow(SubrequestBudgetError);
    });
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
