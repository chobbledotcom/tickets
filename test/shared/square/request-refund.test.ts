import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { squareApi } from "#shared/square.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describeSquare(() => {
  const errors = setupErrorSpy();

  test("rejects a non-positive refund before calling Square", async () => {
    await expect(
      squareApi.requestRefund(
        "square-payment",
        { amount: 0, currency: "GBP" },
        "refund-key",
      ),
    ).rejects.toThrow("Square refund for square-payment must be positive");
    expect(errors.calls).toHaveLength(0);
  });

  test("returns null and logs when Square rejects a refund", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        refundsRequestRefund: () =>
          Promise.reject(new Error("Square refund service is down")),
      },
      async () => {
        expect(
          await squareApi.requestRefund(
            "square-payment",
            { amount: 600, currency: "GBP" },
            "refund-key",
          ),
        ).toBeNull();
        expect(errors.contains("Square refund service is down")).toBe(true);
      },
    );
  });

  for (const [name, error] of [
    ["invalid JSON", new SyntaxError("invalid Square JSON")],
    ["invalid response data", () => v.parse(v.string(), 1)],
  ] as const) {
    test(`propagates ${name} from Square`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient(
        {
          refundsRequestRefund: () =>
            Promise.reject(typeof error === "function" ? error() : error),
        },
        async () => {
          await expect(
            squareApi.requestRefund(
              "square-payment",
              { amount: 600, currency: "GBP" },
              "refund-key",
            ),
          ).rejects.toThrow();
          expect(errors.calls).toHaveLength(0);
        },
      );
    });
  }
});
