import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { preparedCheckout } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

describeSquare(() => {
  test("returns the exact Square order as the checkout session", async () => {
    const checkout = await preparedCheckout(
      undefined,
      "square",
      "square-local-checkout",
    );
    await withMocks(
      () =>
        stub(squareApi, "createCheckout", () =>
          Promise.resolve({
            orderId: "square-order",
            url: "https://square.link/checkout",
          }),
        ),
      async (createCheckout) => {
        expect(await squarePaymentProvider.createCheckout(checkout)).toEqual({
          checkoutUrl: "https://square.link/checkout",
          session: {
            id: "square-order",
            kind: "square_order",
            provider: "square",
          },
          sessionId: "square-order",
        });
        expect(createCheckout.calls[0]?.args).toEqual([checkout]);
      },
    );
  });

  test("returns null when Square creates no payment link", async () => {
    await withMocks(
      () => stub(squareApi, "createCheckout", () => Promise.resolve(null)),
      async () => {
        expect(
          await squarePaymentProvider.createCheckout(
            await preparedCheckout(undefined, "square"),
          ),
        ).toBeNull();
      },
    );
  });
});
