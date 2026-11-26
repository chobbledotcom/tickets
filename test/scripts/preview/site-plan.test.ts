import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readSitePlan, readStripeKey } from "#scripts/preview/site-plan.ts";

const ENV: Record<string, string> = {
  PREVIEW_OWNER_PASSWORD: "a-shared-password",
  PREVIEW_OWNER_USERNAME: "preview-owner",
  SQUARE_ACCESS_TOKEN: "EAAAsandbox",
  SQUARE_LOCATION_ID: "LOC1",
  STRIPE_SECRET_KEY: "sk_test_abc",
  SUMUP_API_KEY: "sumup-key",
  SUMUP_MERCHANT_CODE: "MCODE",
};

const without = (name: string) => (key: string) =>
  key === name ? undefined : ENV[key];

describe("readSitePlan", () => {
  test("reads the owner and each provider, with Stripe last", () => {
    expect(readSitePlan((key) => ENV[key])).toEqual({
      ok: true,
      value: {
        owner: { password: "a-shared-password", username: "preview-owner" },
        providers: [
          {
            fields: { sumupApiKey: "sumup-key", sumupMerchantCode: "MCODE" },
            id: "sumup",
          },
          {
            fields: {
              squareAccessToken: "EAAAsandbox",
              squareLocationId: "LOC1",
              squareSandbox: "on",
            },
            id: "square",
          },
          { fields: { stripeSecretKey: "sk_test_abc" }, id: "stripe" },
        ],
      },
    });
  });

  test("names every missing secret", () => {
    const result = readSitePlan((key) =>
      key === "SUMUP_API_KEY" || key === "PREVIEW_OWNER_PASSWORD"
        ? "  "
        : ENV[key],
    );

    expect(result).toEqual({
      error:
        "Set these secrets for the preview: PREVIEW_OWNER_PASSWORD, SUMUP_API_KEY.",
      ok: false,
    });
  });

  test("refuses a Stripe key that is not a test key", () => {
    const result = readSitePlan((key) =>
      key === "STRIPE_SECRET_KEY" ? "sk_live_abc" : ENV[key],
    );

    expect(result).toEqual({
      error:
        "STRIPE_SECRET_KEY must be a Stripe test key. It starts with sk_test_.",
      ok: false,
    });
  });
});

describe("readStripeKey", () => {
  test("reads a test key", () => {
    expect(readStripeKey((key) => ENV[key])).toEqual({
      ok: true,
      value: "sk_test_abc",
    });
  });

  test("names the key when it is missing", () => {
    expect(readStripeKey(without("STRIPE_SECRET_KEY"))).toEqual({
      error: "Set these secrets for the preview: STRIPE_SECRET_KEY.",
      ok: false,
    });
  });

  test("refuses a key that is not a test key", () => {
    expect(readStripeKey(() => "sk_live_abc")).toEqual({
      error:
        "STRIPE_SECRET_KEY must be a Stripe test key. It starts with sk_test_.",
      ok: false,
    });
  });
});
