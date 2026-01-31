import { afterEach, beforeEach, describe, expect, test, spyOn } from "#test-compat";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { squareApi } from "#lib/square.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("square-provider", () => {
  beforeEach(async () => {
    await createTestDb();
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
  });

  afterEach(() => {
    resetDb();
  });

  describe("type", () => {
    test("returns square as provider type", () => {
      expect(squarePaymentProvider.type).toBe("square");
    });
  });

  describe("checkoutCompletedEventType", () => {
    test("returns payment.updated", () => {
      expect(squarePaymentProvider.checkoutCompletedEventType).toBe(
        "payment.updated",
      );
    });
  });

  describe("createCheckoutSession", () => {
    test("returns null when payment link creation fails", async () => {
      const createSpy = spyOn(squareApi, "createPaymentLink")
        .mockResolvedValue(null);

      try {
        const event = {
          id: 1,
          slug: "test-event",
          slug_index: "test-event-index",
          name: "Test",
          description: "Desc",
          created: new Date().toISOString(),
          max_attendees: 50,
          thank_you_url: "https://example.com",
          unit_price: 1000,
          max_quantity: 1,
          webhook_url: null,
          active: 1,
          fields: "email" as const,
        };
        const intent = {
          eventId: 1,
          name: "John",
          email: "john@example.com",
          phone: "",
          quantity: 1,
        };

        const result = await squarePaymentProvider.createCheckoutSession(
          event,
          intent,
          "http://localhost",
        );
        expect(result).toBeNull();
      } finally {
        createSpy.mockRestore?.();
      }
    });

    test("returns session ID and checkout URL on success", async () => {
      const createSpy = spyOn(squareApi, "createPaymentLink")
        .mockResolvedValue({
          orderId: "order_abc123",
          url: "https://square.link/checkout/abc123",
        });

      try {
        const event = {
          id: 1,
          slug: "test-event",
          slug_index: "test-event-index",
          name: "Test",
          description: "Desc",
          created: new Date().toISOString(),
          max_attendees: 50,
          thank_you_url: "https://example.com",
          unit_price: 1000,
          max_quantity: 1,
          webhook_url: null,
          active: 1,
          fields: "email" as const,
        };
        const intent = {
          eventId: 1,
          name: "John",
          email: "john@example.com",
          phone: "",
          quantity: 1,
        };

        const result = await squarePaymentProvider.createCheckoutSession(
          event,
          intent,
          "http://localhost",
        );
        expect(result).not.toBeNull();
        expect(result!.sessionId).toBe("order_abc123");
        expect(result!.checkoutUrl).toBe("https://square.link/checkout/abc123");
      } finally {
        createSpy.mockRestore?.();
      }
    });
  });

  describe("createMultiCheckoutSession", () => {
    test("returns null when multi payment link creation fails", async () => {
      const createSpy = spyOn(squareApi, "createMultiPaymentLink")
        .mockResolvedValue(null);

      try {
        const intent = {
          name: "John",
          email: "john@example.com",
          phone: "",
          items: [
            { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1" },
          ],
        };

        const result = await squarePaymentProvider.createMultiCheckoutSession(
          intent,
          "http://localhost",
        );
        expect(result).toBeNull();
      } finally {
        createSpy.mockRestore?.();
      }
    });

    test("returns session ID and checkout URL on success", async () => {
      const createSpy = spyOn(squareApi, "createMultiPaymentLink")
        .mockResolvedValue({
          orderId: "order_multi_123",
          url: "https://square.link/checkout/multi123",
        });

      try {
        const intent = {
          name: "John",
          email: "john@example.com",
          phone: "",
          items: [
            { eventId: 1, quantity: 1, unitPrice: 1000, slug: "event-1" },
            { eventId: 2, quantity: 2, unitPrice: 500, slug: "event-2" },
          ],
        };

        const result = await squarePaymentProvider.createMultiCheckoutSession(
          intent,
          "http://localhost",
        );
        expect(result).not.toBeNull();
        expect(result!.sessionId).toBe("order_multi_123");
        expect(result!.checkoutUrl).toBe(
          "https://square.link/checkout/multi123",
        );
      } finally {
        createSpy.mockRestore?.();
      }
    });
  });

  describe("retrieveSession", () => {
    test("returns null when order not found", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue(null);

      try {
        const result = await squarePaymentProvider.retrieveSession("order_missing");
        expect(result).toBeNull();
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns null when order has no metadata", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_123",
          state: "COMPLETED",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_123");
        expect(result).toBeNull();
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns null when metadata missing required name field", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_123",
          metadata: { email: "john@example.com", event_id: "1" },
          state: "COMPLETED",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_123");
        expect(result).toBeNull();
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns null when single-ticket order missing event_id", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_123",
          metadata: { name: "John", email: "john@example.com" },
          state: "COMPLETED",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_123");
        expect(result).toBeNull();
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns validated session for single-ticket order", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_123",
          metadata: {
            event_id: "1",
            name: "John Doe",
            email: "john@example.com",
            phone: "555-1234",
            quantity: "2",
          },
          tenders: [{ id: "tender_1", paymentId: "pay_abc" }],
          state: "COMPLETED",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_123");
        expect(result).not.toBeNull();
        expect(result!.id).toBe("order_123");
        expect(result!.paymentStatus).toBe("paid");
        expect(result!.paymentReference).toBe("pay_abc");
        expect(result!.metadata.event_id).toBe("1");
        expect(result!.metadata.name).toBe("John Doe");
        expect(result!.metadata.email).toBe("john@example.com");
        expect(result!.metadata.phone).toBe("555-1234");
        expect(result!.metadata.quantity).toBe("2");
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns unpaid status for non-COMPLETED order", async () => {
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_123",
          metadata: {
            event_id: "1",
            name: "John",
            email: "john@example.com",
          },
          state: "OPEN",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_123");
        expect(result).not.toBeNull();
        expect(result!.paymentStatus).toBe("unpaid");
        expect(result!.paymentReference).toBeNull();
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });

    test("returns validated session for multi-ticket order", async () => {
      const items = JSON.stringify([{ e: 1, q: 2 }, { e: 2, q: 1 }]);
      const retrieveSpy = spyOn(squareApi, "retrieveOrder")
        .mockResolvedValue({
          id: "order_multi",
          metadata: {
            multi: "1",
            name: "John",
            email: "john@example.com",
            items,
          },
          tenders: [{ id: "tender_1", paymentId: "pay_multi" }],
          state: "COMPLETED",
        });

      try {
        const result = await squarePaymentProvider.retrieveSession("order_multi");
        expect(result).not.toBeNull();
        expect(result!.id).toBe("order_multi");
        expect(result!.paymentStatus).toBe("paid");
        expect(result!.metadata.multi).toBe("1");
        expect(result!.metadata.items).toBe(items);
      } finally {
        retrieveSpy.mockRestore?.();
      }
    });
  });

  describe("verifyWebhookSignature", () => {
    test("delegates to square module with notification URL", async () => {
      // This will fail signature verification since we don't have a real key configured,
      // but it verifies the delegation works correctly
      const result = await squarePaymentProvider.verifyWebhookSignature(
        '{"test": true}',
        "fakesig",
      );
      expect(result.valid).toBe(false);
    });
  });

  describe("refundPayment", () => {
    test("delegates to square module", async () => {
      const refundSpy = spyOn(squareApi, "refundPayment")
        .mockResolvedValue(true);

      try {
        const result = await squarePaymentProvider.refundPayment("pay_123");
        expect(result).toBe(true);
        expect(refundSpy).toHaveBeenCalledWith("pay_123");
      } finally {
        refundSpy.mockRestore?.();
      }
    });

    test("returns false when refund fails", async () => {
      const refundSpy = spyOn(squareApi, "refundPayment")
        .mockResolvedValue(false);

      try {
        const result = await squarePaymentProvider.refundPayment("pay_123");
        expect(result).toBe(false);
      } finally {
        refundSpy.mockRestore?.();
      }
    });
  });

  describe("setupWebhookEndpoint", () => {
    test("returns failure since Square webhooks are manual", async () => {
      const result = await squarePaymentProvider.setupWebhookEndpoint(
        "key",
        "https://example.com/webhook",
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Square Developer Dashboard");
      }
    });
  });
});
