import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { spyOn } from "#test-compat";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  mockFormRequest,
  mockProviderType,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  loginAsAdmin,
  withMocks,
} from "#test-utils";
import { paymentsApi } from "#lib/payments.ts";

describe("server (admin refunds)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/refund", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/refund`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/refund",
        { cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/refund",
        { cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different event", async () => {
      const event1 = await createTestEvent({ name: "Event 1", maxAttendees: 100 });
      const event2 = await createTestEvent({ name: "Event 2", maxAttendees: 100 });
      const attendee = await createTestAttendee(event2.id, event2.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event1.id}/attendee/${attendee.id}/refund`,
        { cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows error when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
        { cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("no payment to refund");
    });

    test("shows refund confirmation page for paid attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "Jane Smith", "jane@example.com", "pi_test_123");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Refund Attendee");
      expect(html).toContain("Jane Smith");
      expect(html).toContain("type their name");
      expect(html).toContain("5.00");
    });

    test("includes return_url as hidden field when provided", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "Jane Smith", "jane@example.com", "pi_test_123");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/refund?return_url=${encodeURIComponent("/admin/calendar#attendees")}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain("/admin/calendar#attendees");
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/refund", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/refund`, {
          confirm_name: "John Doe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_456");

      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
          { confirm_name: "John Doe", csrf_token: "invalid-token" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("rejects mismatched attendee name", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_789");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
          { confirm_name: "Wrong Name", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("returns error when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
          { confirm_name: "John Doe", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("no payment to refund");
    });

    test("returns error when no payment provider configured", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_noprov");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
          { confirm_name: "John Doe", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("No payment provider configured");
    });

    test("successfully refunds attendee payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_success");

      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefund = spyOn(stripePaymentProvider, "refundPayment").mockResolvedValue(true);
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
                { confirm_name: "John Doe", csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);
            expect(mockRefund).toHaveBeenCalled();
          } finally {
            mockRefund.mockRestore?.();
          }
        },
      );
    });

    test("shows error when refund fails", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_fail");

      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefund = spyOn(stripePaymentProvider, "refundPayment").mockResolvedValue(false);
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
                { confirm_name: "John Doe", csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(400);
            const html = await response.text();
            expect(html).toContain("Refund failed");
          } finally {
            mockRefund.mockRestore?.();
          }
        },
      );
    });

    test("handles missing confirm_name field", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_test_missing");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/refund`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });
  });

  describe("GET /admin/event/:id/refund-all", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/refund-all`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/999/refund-all",
        { cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows error when no attendees have payments", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/refund-all`,
        { cookie },
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("No attendees have payments to refund");
    });

    test("shows refund all confirmation page with refundable count", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "Paid User", "paid@example.com", "pi_paid_1");
      // Also add a free attendee (no payment_id)
      await createTestAttendee(event.id, event.slug, "Free User", "free@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/refund-all`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Refund All");
      expect(html).toContain("1 attendee(s) with payments");
      expect(html).toContain("type the event name");
    });
  });

  describe("POST /admin/event/:id/refund-all", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/refund-all`, {
          confirm_name: event.name,
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/refund-all",
          { confirm_name: "Test", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects mismatched event name", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_refundall_1");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/refund-all`,
          { confirm_name: "Wrong Event Name", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("rejects when confirm_name is missing", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_refundall_missing");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/refund-all`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("returns error when no attendees have payments", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/refund-all`,
          { confirm_name: event.name, csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("No attendees have payments to refund");
    });

    test("returns error when no payment provider configured", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_noprov_all");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/refund-all`,
          { confirm_name: event.name, csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("No payment provider configured");
    });

    test("successfully refunds all attendees", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "User One", "one@example.com", "pi_all_1");
      await createPaidTestAttendee(event.id, "User Two", "two@example.com", "pi_all_2");

      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefund = spyOn(stripePaymentProvider, "refundPayment").mockResolvedValue(true);
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/event/${event.id}/refund-all`,
                { confirm_name: event.name, csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);
            expect(mockRefund).toHaveBeenCalledTimes(2);
          } finally {
            mockRefund.mockRestore?.();
          }
        },
      );
    });

    test("reports partial failure when some refunds fail", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "Good User", "good@example.com", "pi_partial_ok");
      await createPaidTestAttendee(event.id, "Bad User", "bad@example.com", "pi_partial_fail");

      const { cookie, csrfToken } = await loginAsAdmin();

      let callNum = 0;
      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefund = spyOn(stripePaymentProvider, "refundPayment").mockImplementation(() => {
            callNum++;
            // First refund succeeds, second fails
            return Promise.resolve(callNum <= 1);
          });
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/event/${event.id}/refund-all`,
                { confirm_name: event.name, csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(400);
            const html = await response.text();
            expect(html).toContain("1 refund(s) succeeded");
            expect(html).toContain("1 failed");
          } finally {
            mockRefund.mockRestore?.();
          }
        },
      );
    });
  });

  describe("event page UI", () => {
    test("shows Refund link for paid attendees on paid events", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      await createPaidTestAttendee(event.id, "Paid User", "paid@example.com", "pi_ui_1");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("/refund");
      expect(html).toContain("Refund All");
    });

    test("does not show Refund link for free events", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "Free User", "free@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Refund All");
    });

    test("does not show Refund link for attendees without payment_id on paid events", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      // Create a free attendee on a paid event (no payment_id)
      await createTestAttendee(event.id, event.slug, "No Payment User", "nopay@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // The event nav should still show Refund All (because it's a paid event)
      expect(html).toContain("Refund All");
      // But the attendee row should NOT show an individual refund link
      // since the attendee has no payment_id
      expect(html).not.toContain("/refund\"");
    });
  });
});
