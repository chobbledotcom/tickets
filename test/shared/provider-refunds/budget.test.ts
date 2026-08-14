import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { DATABASE_MAX_ATTEMPTS } from "#shared/db/client.ts";
import {
  REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS,
  REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS,
  REFUND_RESULT_DATABASE_RESERVE,
} from "#shared/provider-refunds/budget.ts";

test("refund authority budgets every physical database attempt", () => {
  expect(REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS).toBe(
    DATABASE_MAX_ATTEMPTS * 5,
  );
  expect(REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS).toBe(
    DATABASE_MAX_ATTEMPTS * 4,
  );
  expect(REFUND_RESULT_DATABASE_RESERVE).toEqual({
    database: DATABASE_MAX_ATTEMPTS * 2,
    external: 0,
    total: DATABASE_MAX_ATTEMPTS * 2,
  });
});
