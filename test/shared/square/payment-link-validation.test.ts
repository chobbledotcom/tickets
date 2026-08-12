import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  extractSessionMetadata,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import type { CreatePaymentLinkInput } from "#shared/square/client.ts";
import {
  configureSquare,
  expectNoLink,
  withSquareClient,
} from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";

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

    test("returns null when SDK response missing orderId", async () => {
      await configureSquare({ locationId: "L_multi_loc" });
      await withSquareClient(
        {
          checkoutCreate: () =>
            Promise.resolve({
              paymentLink: { url: "https://square.link/multi" },
            }),
        },
        async () => {
          const result = await squareApi.createPaymentLink(
            checkoutIntent({
              email: "bob@example.com",
              items: [checkoutItem({ name: "Listing 1" })],
              name: "Bob Missing",
            }),
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("constructs correct SDK call with multiple line items", async () => {
      await configureSquare({ locationId: "L_multi_loc" });
      await withSquareClient(
        {
          checkoutCreate: () =>
            Promise.resolve({
              paymentLink: {
                orderId: "order_multi",
                url: "https://square.link/multi",
              },
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

    const squareError = (errors: string) =>
      new Error(`Status code: 400 Body: { "errors": [ ${errors} ] }`);

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

    /** The SDK error should be swallowed, leaving a null payment link. */
    const expectNullLink = (sdkError: Error) =>
      failingCheckout(sdkError, async () => {
        expect(await makeLink()).toBeNull();
      });

    test("throws PaymentUserError for invalid phone number", async () => {
      await expectUserError(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "INVALID_PHONE_NUMBER", "detail": "Invalid phone number.", "field": "pre_populated_data.buyer_phone_number" }',
        ),
        "phone number",
      );
    });

    test("throws PaymentUserError for invalid email address", async () => {
      await expectUserError(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "INVALID_EMAIL_ADDRESS", "detail": "Invalid email.", "field": "pre_populated_data.buyer_email" }',
        ),
        "email address",
      );
    });

    test("returns null for non-user-facing API errors", async () => {
      await expectNullLink(
        squareError(
          '{ "category": "API_ERROR", "code": "INTERNAL_SERVER_ERROR" }',
        ),
      );
    });

    test("returns null for validation error on unknown field", async () => {
      await expectNullLink(
        squareError(
          '{ "category": "INVALID_REQUEST_ERROR", "code": "MISSING_REQUIRED_PARAMETER", "field": "order.location_id" }',
        ),
      );
    });

    test("returns null for non-Body error messages", async () => {
      await expectNullLink(new Error("Network timeout"));
    });

    test("returns null for malformed JSON in error body", async () => {
      await expectNullLink(
        new Error("Status code: 400 Body: { invalid json content }"),
      );
    });

    test("preserves an error whose errors field is malformed", async () => {
      const sdkError = new Error('Status code: 400 Body: { "errors": {} }');
      const errorLog = spy(console, "error");
      try {
        await expectNullLink(sdkError);
        expect(errorLog.calls.at(-1)?.args[0]).toContain(sdkError.message);
      } finally {
        errorLog.restore();
      }
    });
  });
});
