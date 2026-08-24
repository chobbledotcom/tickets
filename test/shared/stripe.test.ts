import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  detectStripeKeyMode,
  isoFromUnixSeconds,
  stripeApi,
} from "#shared/stripe.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  stripeCheckoutSession,
  stripeClient,
} from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

describe("Stripe payment operations", () => {
  test("detects test and live secret keys", () => {
    expect(detectStripeKeyMode("sk_test_example")).toBe("test");
    expect(detectStripeKeyMode("sk_live_example")).toBe("live");
    expect(detectStripeKeyMode("rk_test_example")).toBeNull();
  });

  test("converts Unix seconds to an ISO timestamp", () => {
    expect(isoFromUnixSeconds(1)).toBe("1970-01-01T00:00:01.000Z");
    expect(isoFromUnixSeconds("1")).toBe(undefined);
  });
});
describeStripe("what Stripe is asked to charge for", () => {
  const createdWith = async (
    intent: CheckoutIntent,
  ): Promise<Record<string, unknown>> => {
    await settings.update.stripe.secretKey("sk_test_mock");
    const client = await stripeClient();
    let params: Record<string, unknown> = {};
    await withMocks(
      () =>
        stub(client.checkout.sessions, "create", (sent: unknown) => {
          params = sent as Record<string, unknown>;
          return Promise.resolve(
            stripeCheckoutSession({
              id: "cs_created",
              url: "https://stripe.example/checkout",
            }),
          );
        }),
      async () => {
        await stripeApi.createCheckoutSession(intent, "http://localhost:3000");
      },
    );
    return params;
  };

  const describedAs = (params: Record<string, unknown>): string => {
    const [line] = params.line_items as [
      { price_data: { product_data: { description: string } } },
    ];
    return line.price_data.product_data.description;
  };

  test("says how many tickets one line buys when it buys several", async () => {
    expect(
      describedAs(
        await createdWith(
          checkoutIntent({ items: [checkoutItem({ quantity: 3 })] }),
        ),
      ),
    ).toBe("3 Tickets");
  });

  test("says one ticket in the singular", async () => {
    expect(
      describedAs(
        await createdWith(
          checkoutIntent({ items: [checkoutItem({ quantity: 1 })] }),
        ),
      ),
    ).toBe("Ticket");
  });

  test("sends the buyer's email so Stripe can receipt them", async () => {
    const params = await createdWith(
      checkoutIntent({ email: "buyer@example.com" }),
    );
    expect(params.customer_email).toBe("buyer@example.com");
  });

  test("sends no email field at all when the buyer gave none", async () => {
    // Stripe rejects an empty customer_email, so the field must be absent.
    const params = await createdWith(checkoutIntent({ email: "" }));
    expect("customer_email" in params).toBe(false);
  });
});
describeStripe("reading back a checkout Stripe will not show us", () => {
  const readFailing = async (rejection: unknown): Promise<unknown> => {
    await settings.update.stripe.secretKey("sk_test_mock");
    const client = await stripeClient();
    let thrown: unknown;
    await withMocks(
      () =>
        stub(client.checkout.sessions, "retrieve", () =>
          Promise.reject(rejection),
        ),
      async () => {
        try {
          await stripeApi.retrieveCheckoutSession("cs_gone");
        } catch (error) {
          thrown = error;
        }
      },
    );
    return thrown;
  };

  test("reads a checkout Stripe says is gone as simply absent", async () => {
    expect(
      await readFailing(transportError.answered(providerDetail.stripe(), 404)),
    ).toBeUndefined();
  });

  test("names why a checkout could not be read, in closed words", async () => {
    const error = await readFailing(
      transportError.answered(providerDetail.stripe(), 500),
    );
    expect((error as Error).name).toBe("StripeCheckoutReadError");
    expect((error as Error).message).toBe(
      "Stripe checkout could not be read (unavailable:provider_error)",
    );
  });

  test("says a failure Stripe does not own was unexpected", async () => {
    // A bug of ours reaching here has no provider meaning to report.
    const error = await readFailing(new RangeError("a bug of ours"));
    expect((error as Error).name).toBe("StripeCheckoutReadError");
    expect((error as Error).message).toBe(
      "Stripe checkout could not be read (unexpected_failure)",
    );
  });
});
