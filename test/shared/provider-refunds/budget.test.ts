import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { DATABASE_MAX_ATTEMPTS } from "#db/client.ts";
import {
  REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS,
  REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS,
  REFUND_RESULT_DATABASE_RESERVE,
  REFUND_RETRY_HEADROOM_DATABASE_CALLS,
  REFUND_TERMINAL_AUTHORITY_DATABASE_CALLS,
} from "#shared/provider-refunds/budget.ts";

test("refund authority budgets each statement once with shared retry room", () => {
  expect(REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS).toBe(5);
  expect(REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS).toBe(4);
  expect(REFUND_TERMINAL_AUTHORITY_DATABASE_CALLS).toBe(1);
  expect(REFUND_RETRY_HEADROOM_DATABASE_CALLS).toBe(DATABASE_MAX_ATTEMPTS - 1);
});

test("refund result reserve keeps every physical attempt while a call is in flight", () => {
  expect(REFUND_RESULT_DATABASE_RESERVE).toEqual({
    database: DATABASE_MAX_ATTEMPTS * 2,
    external: 0,
    total: DATABASE_MAX_ATTEMPTS * 2,
  });
});
