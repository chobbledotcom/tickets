import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import {
  extractSessionMetadata,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import type { CreatePaymentLinkInput } from "#shared/square/client.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import {
  expectClosedCheckoutFailure,
  expectSameThrown,
} from "#test-utils/checkout-failure.ts";
import {
  configureSquare,
  expectNoLink,
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("createPaymentLink request handling", () => {
    test("returns null when access token not set", async () => {
      await expectNoLink(
        checkoutIntent({
          items: [
            checkoutItem({ name: "Listing 1" }),
            checkoutItem({
              listingId: 2,
              name: "Listing 2",
              quantity: 2,
              slug: "listing-2",
              unitPrice: 500,
            }),
          ],
          name: "John Doe",
        }),
      );
    });

    test("returns null when location ID not configured", async () => {
      await configureSquare();
      await expectNoLink(
        checkoutIntent({
          items: [checkoutItem({ name: "Listing 1" })],
          name: "John Doe",
        }),
      );
    });

    test("refuses a created link that names no order", async () => {
      await configureSquare({ locationId: "L_multi_loc" });
      await expectClosedCheckoutFailure(
        withSquareAnswer(
          { payment_link: { url: "https://square.link/multi" } },
          () =>
            squareApi.createPaymentLink(
              checkoutIntent({
                email: "bob@example.com",
                items: [checkoutItem({ name: "Listing 1" })],
                name: "Bob Missing",
              }),
              "http://localhost",
            ),
        ),
        { provider: "square", reason: "invalid_response" },
      );
    });

    test("constructs correct SDK call with multiple line items", async () => {
      await configureSquare({ locationId: "L_multi_loc" });
      await withSquareClient(
        {
          checkoutCreate: () =>
            Promise.resolve({
              orderId: "order_multi",
              url: "https://square.link/multi",
            }),
        },
        async ({ checkoutCreate }) => {
          const result = await squareApi.createPaymentLink(
            checkoutIntent({
              email: "alice@example.com",
              items: [
                checkoutItem({
                  listingId: 10,
                  name: "Workshop A",
                  quantity: 2,
                  slug: "workshop-a",
                  unitPrice: 1500,
                }),
                checkoutItem({
                  listingId: 20,
                  name: "Gala Dinner",
                  quantity: 1,
                  slug: "gala-dinner",
                  unitPrice: 3000,
                }),
              ],
              name: "Alice Wonder",
              phone: "555-1111",
            }),
            "https://tickets.example.com",
          );

          expect(result).not.toBeNull();
          expect(result!.orderId).toBe("order_multi");
          expect(result!.url).toBe("https://square.link/multi");

          const args = checkoutCreate.calls[0]
            ?.args[0] as CreatePaymentLinkInput;

          // Verify multiple line items
          expect(args.order.lineItems).toHaveLength(2);
          expect(args.order.lineItems[0]!.name).toBe("Ticket: Workshop A");
          expect(args.order.lineItems[0]!.quantity).toBe("2");
          expect(args.order.lineItems[0]!.basePriceMoney.amount).toBe(
            BigInt(1500),
          );
          expect(args.order.lineItems[0]!.note).toBe("2 Tickets");

          expect(args.order.lineItems[1]!.name).toBe("Ticket: Gala Dinner");
          expect(args.order.lineItems[1]!.quantity).toBe("1");
          expect(args.order.lineItems[1]!.basePriceMoney.amount).toBe(
            BigInt(3000),
          );
          expect(args.order.lineItems[1]!.note).toBe("Ticket");

          // Verify multi-intent metadata (small fields packed into `b`).
          const metadata = extractSessionMetadata(
            args.order.metadata as unknown as SessionMetadata,
          );
          expect(metadata.name).toBe("Alice Wonder");
          expect(metadata.email).toBe("alice@example.com");
          expect(metadata.phone).toBe("555-1111");
          const items = JSON.parse(metadata.items);
          expect(items).toHaveLength(2);
          expect(items[0]).toEqual({ e: 10, p: 3000, q: 2 });
          expect(items[1]).toEqual({ e: 20, p: 3000, q: 1 });

          // Verify location and checkout options
          expect(args.order.locationId).toBe("L_multi_loc");
          expect(args.checkoutOptions.redirectUrl).toBe(
            "https://tickets.example.com/payment/success",
          );
          expect(args.prePopulatedData.buyerEmail).toBe("alice@example.com");
          expect(args.prePopulatedData.buyerPhoneNumber).toBe("+5551111");
        },
      );
    });

    test("throws PaymentUserError when items metadata exceeds Square limit", async () => {
      await configureSquare({ locationId: "L_multi_loc" });
      await withSquareClient({}, async ({ checkoutCreate }) => {
        // Generate enough items to exceed 255-char serialized metadata
        const items = Array.from({ length: 30 }, (_, i) =>
          checkoutItem({
            listingId: i + 1,
            name: `Listing ${i + 1}`,
            slug: `listing-${i + 1}`,
          }),
        );

        await expect(
          squareApi.createPaymentLink(
            checkoutIntent({
              email: "alice@example.com",
              items,
              name: "Alice",
            }),
            "https://tickets.example.com",
          ),
        ).rejects.toThrow(PaymentUserError);

        // SDK should never have been called
        expect(checkoutCreate.calls.length).toBe(0);
      });
    });
  });

  describe("createPaymentLink with validation errors", () => {
    const validationIntent = checkoutIntent({
      items: [checkoutItem({ name: "Test Listing" })],
      phone: "bad-phone",
    });

    const squareError = (invalidField: "email" | "phone") =>
      transportError.answered(providerDetail.square(invalidField), 400);

    /** Configure credentials, then fail the checkout with the given error. */
    const failingCheckout = async (
      sdkError: Error,
      body: () => Promise<void>,
    ) => {
      await configureSquare({ locationId: "L_loc_456" });
      await withSquareClient(
        { checkoutCreate: () => Promise.reject(sdkError) },
        body,
      );
    };

    const makeLink = () =>
      squareApi.createPaymentLink(validationIntent, "http://localhost");

    /** The SDK error should surface as a PaymentUserError with the exact
     * user-facing message built from the label (so a mutated label is caught). */
    const expectUserError = (sdkError: Error, hint: string) =>
      failingCheckout(sdkError, async () => {
        try {
          await makeLink();
          expect(true).toBe(false); // should not reach here
        } catch (err) {
          expect(err instanceof PaymentUserError).toBe(true);
          expect((err as PaymentUserError).message).toBe(
            `The payment processor rejected the ${hint} as invalid. Please correct it and try again.`,
          );
        }
      });

    /** An application error keeps its identity at the checkout boundary. */
    const expectCheckoutFailure = (sdkError: Error) =>
      failingCheckout(sdkError, async () => {
        await expectSameThrown(makeLink(), sdkError);
      });

    /** A recognised provider error crosses only as closed facts. */
    const expectProviderFailure = (
      providerError: Error,
      reason: "network_error" | "provider_error",
      statusCode?: number,
    ) =>
      failingCheckout(providerError, async () => {
        await expectClosedCheckoutFailure(
          makeLink(),
          { provider: "square", reason, statusCode },
          [],
          providerError,
        );
      });

    test("throws PaymentUserError for invalid phone number", async () => {
      await expectUserError(squareError("phone"), "phone number");
    });

    test("throws PaymentUserError for invalid email address", async () => {
      await expectUserError(squareError("email"), "email address");
    });

    test("propagates non-user-facing API errors", async () => {
      await expectCheckoutFailure(new Error("Square server failure"));
    });

    test("propagates validation errors for unknown fields", async () => {
      await expectCheckoutFailure(new Error("Square rejected another field"));
    });

    test("propagates ordinary network errors", async () => {
      await expectCheckoutFailure(new Error("Network timeout"));
    });

    test("does not trust body-shaped messages from another error type", async () => {
      await expectCheckoutFailure(
        new Error(
          'Status code: 400 Body: { "errors": [{ "category": "INVALID_REQUEST_ERROR", "code": "INVALID_PHONE_NUMBER", "field": "pre_populated_data.buyer_phone_number" }] }',
        ),
      );
    });

    test("closes a Square API error without a user-facing field", async () => {
      await expectProviderFailure(
        transportError.answered(providerDetail.square(), 400),
        "provider_error",
        400,
      );
    });

    test("closes a Square connection error", async () => {
      await expectProviderFailure(
        transportError.unreachable(providerDetail.square(), "network_error"),
        "network_error",
      );
    });

    test("closes a malformed Square provider response", async () => {
      const providerError = transportError.unusable(providerDetail.square());
      await failingCheckout(providerError, async () => {
        await expectClosedCheckoutFailure(
          makeLink(),
          { provider: "square", reason: "invalid_response" },
          [],
          providerError,
        );
      });
    });
  });
});
