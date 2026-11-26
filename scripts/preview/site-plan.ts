// effects: pure
/** What a new preview needs to be set up: the shared owner login and the
 * sandbox keys of each payment provider, read from the build environment. */

import { requiredMapValue } from "#fp";
import type { SitePlan } from "#scripts/preview/configure.ts";
import { readEnvValues } from "#scripts/preview/env-values.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

const STRIPE_KEY = "STRIPE_SECRET_KEY";
const STRIPE_TEST_KEY_PREFIX = "sk_test_";

const PLAN_VARIABLES = [
  "PREVIEW_OWNER_PASSWORD",
  "PREVIEW_OWNER_USERNAME",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  STRIPE_KEY,
  "SUMUP_API_KEY",
  "SUMUP_MERCHANT_CODE",
] as const;

/** A preview takes payments and sends mail, so it only ever holds a Stripe
 * test key. */
const stripeTestKey = (values: Map<string, string>): Result<string> => {
  const key = requiredMapValue(values, STRIPE_KEY);
  return key.startsWith(STRIPE_TEST_KEY_PREFIX)
    ? okResult(key)
    : errorResult(
        `${STRIPE_KEY} must be a Stripe test key. It starts with ${STRIPE_TEST_KEY_PREFIX}.`,
      );
};

/** The Stripe key that the cleanup uses to delete the webhooks of a preview. */
export const readStripeKey = (
  getEnv: (key: string) => string | undefined,
): Result<string> => {
  const values = readEnvValues(getEnv, [STRIPE_KEY]);
  return values.ok ? stripeTestKey(values.value) : values;
};

/** The owner login and the providers, in the order that the setup saves them.
 * The last provider stays the active one. */
export const readSitePlan = (
  getEnv: (key: string) => string | undefined,
): Result<SitePlan> => {
  const values = readEnvValues(getEnv, PLAN_VARIABLES);
  if (!values.ok) return values;
  const stripe = stripeTestKey(values.value);
  if (!stripe.ok) return stripe;
  const value = (name: string): string => requiredMapValue(values.value, name);
  return okResult({
    owner: {
      password: value("PREVIEW_OWNER_PASSWORD"),
      username: value("PREVIEW_OWNER_USERNAME"),
    },
    providers: [
      {
        fields: {
          sumupApiKey: value("SUMUP_API_KEY"),
          sumupMerchantCode: value("SUMUP_MERCHANT_CODE"),
        },
        id: "sumup",
      },
      {
        fields: {
          squareAccessToken: value("SQUARE_ACCESS_TOKEN"),
          squareLocationId: value("SQUARE_LOCATION_ID"),
          squareSandbox: "on",
        },
        id: "square",
      },
      { fields: { stripeSecretKey: stripe.value }, id: "stripe" },
    ],
  });
};
