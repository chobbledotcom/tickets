import { afterEach, beforeEach } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import { createTestDb, describeWithEnv, resetDb } from "#test-utils/db.ts";
import { resetTestSlugCounter } from "#test-utils/internal.ts";

/**
 * Wraps a group of Stripe tests with the shared environment and database
 * setup every Stripe suite needs: the stripe-mock host/port from the
 * environment, a fresh client and slug counter before each test, and a clean
 * database around each test.
 */
export const describeStripe = (name: string, body: () => void): void => {
  describeWithEnv(
    name,
    {
      env: {
        STRIPE_MOCK_HOST: Deno.env.get("STRIPE_MOCK_HOST"),
        STRIPE_MOCK_PORT: Deno.env.get("STRIPE_MOCK_PORT"),
      },
    },
    () => {
      beforeEach(async () => {
        resetStripeClient();
        resetTestSlugCounter();
        await createTestDb();
      });

      afterEach(() => {
        resetStripeClient();
        resetDb();
      });

      body();
    },
  );
};
