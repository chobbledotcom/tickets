/** Direct tests for the harness's required-secret contract. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { providerSecrets } from "#e2e/config.ts";

/** Run a body with these env values, restoring whatever was there before. */
const withEnv = async (
  values: Record<string, string | undefined>,
  body: () => Promise<void> | void,
): Promise<void> => {
  const before = new Map(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};

describe("required provider secrets", () => {
  it("fails a missing Stripe secret instead of skipping", async () => {
    await withEnv({ STRIPE_SECRET_KEY: undefined }, async () => {
      expect(() => providerSecrets("stripe")).toThrow(
        /STRIPE_SECRET_KEY is not set.*fails the nightly contract/s,
      );
    });
  });

  it("refuses a non-test Stripe key outright", async () => {
    await withEnv({ STRIPE_SECRET_KEY: "sk_live_notafortest" }, async () => {
      expect(() => providerSecrets("stripe")).toThrow(/sk_test_/);
    });
  });

  it("accepts a test-mode Stripe key", async () => {
    await withEnv({ STRIPE_SECRET_KEY: "sk_test_ok" }, async () => {
      expect(providerSecrets("stripe")).toEqual({ secretKey: "sk_test_ok" });
    });
  });

  it("fails missing Square credentials", async () => {
    await withEnv(
      { SQUARE_ACCESS_TOKEN: undefined, SQUARE_LOCATION_ID: undefined },
      async () => {
        expect(() => providerSecrets("square")).toThrow(
          /SQUARE_ACCESS_TOKEN\/SQUARE_LOCATION_ID not set/,
        );
      },
    );
  });

  it("returns Square credentials with no production mode knob", async () => {
    await withEnv(
      {
        SQUARE_ACCESS_TOKEN: "EAAA-sandbox",
        SQUARE_LOCATION_ID: "LATEST",
      },
      async () => {
        expect(providerSecrets("square")).toEqual({
          locationId: "LATEST",
          token: "EAAA-sandbox",
        });
      },
    );
  });

  it("fails missing SumUp credentials", async () => {
    await withEnv(
      { SUMUP_API_KEY: undefined, SUMUP_MERCHANT_CODE: undefined },
      async () => {
        expect(() => providerSecrets("sumup")).toThrow(
          /SUMUP_API_KEY\/SUMUP_MERCHANT_CODE not set/,
        );
      },
    );
  });
});
