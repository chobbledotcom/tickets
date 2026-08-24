/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test-utils/square/fixtures.ts";
import { squareOrderRead } from "#test-utils/square/outcomes.ts";

/* jscpd:ignore-end */

const completedOrder = (id: string, metadata: Record<string, string>) =>
  squareOrderRead({
    id,
    metadata,
    state: "COMPLETED",
    totalMoney: squareMoney(1000),
  });

describe("square provider order ownership", () => {
  const debug = setupSquareProviderSuite();

  test("returns null when an order carries no app metadata", async () => {
    await withMocks(
      () =>
        stub(squareApi, "readOrder", () =>
          Promise.resolve(completedOrder("order_no_meta", {})),
        ),
      async () => {
        expect(
          await squarePaymentProvider.retrieveSession("order_no_meta"),
        ).toBeNull();
        expect(debug().calls.at(-1)?.args).toEqual([
          "[Square] Square order does not carry app metadata",
        ]);
      },
    );
  });

  test("says which reason it refused a half-filled order for", async () => {
    // An order carrying our marker but not the fields it needs is a different
    // fault from a till sale, and the operator reading the log has to be able
    // to tell them apart.
    await withMocks(
      () =>
        stub(squareApi, "readOrder", () =>
          Promise.resolve(
            completedOrder("order_partial_meta", { _origin: "localhost" }),
          ),
        ),
      async () => {
        expect(
          await squarePaymentProvider.retrieveSession("order_partial_meta"),
        ).toBeNull();
        expect(debug().calls.at(-1)?.args).toEqual([
          "[Square] Square order is missing required metadata fields",
        ]);
      },
    );
  });

  test("acknowledges a completed foreign order with a common metadata field", async () => {
    await withMocks(
      () =>
        stub(squareApi, "readOrder", () =>
          Promise.resolve(
            completedOrder("order_foreign_name", {
              name: "Counter sale",
            }),
          ),
        ),
      async () => {
        expect(
          await squarePaymentProvider.retrieveSession(
            "order_foreign_name",
            "pay_foreign_name",
          ),
        ).toBeNull();
        expect(debug().calls.at(-1)?.args).toEqual([
          "[Square] Square order does not carry app metadata",
        ]);
      },
    );
  });

  for (const [name, metadata] of [
    [
      "missing",
      {
        _origin: "example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "Damaged checkout",
      },
    ],
    [
      "from an earlier site domain with a missing",
      {
        _origin: "old.example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "Damaged earlier checkout",
      },
    ],
    [
      "corrupt",
      {
        ...SQUARE_ORDER_META,
        price_proof: "not-a-price-proof",
      },
    ],
  ] as const) {
    test(`keeps this site's ${name} price proof retryable`, async () => {
      await withMocks(
        () =>
          stub(squareApi, "readOrder", () =>
            Promise.resolve(completedOrder(`order_${name}_proof`, metadata)),
          ),
        async () => {
          await expect(
            squarePaymentProvider.retrieveSession(
              `order_${name}_proof`,
              `pay_${name}_proof`,
            ),
          ).rejects.toThrow(
            "Completed Square order is missing required metadata",
          );
        },
      );
    });
  }
});
