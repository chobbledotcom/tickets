import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  expectAdminRedirect,
  expectHtmlResponse,
  mockFormRequest,
  mockProviderType,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  withMocks,
} from "#test-utils";
import type { Attendee, Event } from "#lib/types.ts";
import type { EventInput } from "#lib/db/events.ts";
import { paymentsApi } from "#lib/payments.ts";

// -- URL builders --------------------------------------------------------- //

const refundUrl = (eventId: number, attendeeId: number) =>
  `/admin/event/${eventId}/attendee/${attendeeId}/refund`;

const refundAllUrl = (eventId: number) => `/admin/event/${eventId}/refund-all`;

// -- Setup helpers -------------------------------------------------------- //

const createPaidEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
) => createTestEvent({ maxAttendees: 100, unitPrice: 500, ...overrides });

type RefundCtx = {
  event: Event;
  attendee: Attendee;
  cookie: string;
  csrfToken: string;
};

/** Create a paid event + paid John Doe attendee + admin session. */
const setupRefundTest = async (paymentId: string): Promise<RefundCtx> => {
  const event = await createPaidEvent();
  const attendee = await createPaidTestAttendee(
    event.id,
    "John Doe",
    "john@example.com",
    paymentId,
  );
  return {
    event,
    attendee,
    cookie: await testCookie(),
    csrfToken: await testCsrfToken(),
  };
};

/** POST the single-attendee refund form. Defaults to John Doe + ctx csrf. */
const submitRefund = (
  { event, attendee, csrfToken, cookie }: RefundCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundUrl(event.id, attendee.id),
      { confirm_name: "John Doe", csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

/** POST the refund-all form. Defaults to event name + ctx csrf. */
const submitRefundAll = (
  { event, csrfToken, cookie }: RefundCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundAllUrl(event.id),
      { confirm_name: event.name, csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

const markAsRefunded = async (attendeeId: number) => {
  const { markRefunded } = await import("#lib/db/attendees.ts");
  await markRefunded(attendeeId);
};

// -- Mock provider helper ------------------------------------------------- //

const withRefundMock = async (
  refundBehavior: boolean | (() => Promise<boolean>),
  fn: (mockRefund: Stub) => Promise<void>,
) => {
  await withMocks(
    () =>
      stub(
        paymentsApi,
        "getConfiguredProvider",
        () => Promise.resolve(mockProviderType("stripe")),
      ),
    async () => {
      const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
      const mockRefund = typeof refundBehavior === "function"
        ? stub(stripePaymentProvider, "refundPayment", refundBehavior)
        : stub(
          stripePaymentProvider,
          "refundPayment",
          () => Promise.resolve(refundBehavior),
        );
      try {
        await fn(mockRefund);
      } finally {
        mockRefund.restore();
      }
    },
  );
};

// -- Tests ---------------------------------------------------------------- //

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
      const event = await createPaidEvent();
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(refundUrl(event.id, attendee.id)),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await awaitTestRequest(refundUrl(999, 1), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie } = await setupEventAndLogin({ maxAttendees: 100 });
      const response = await awaitTestRequest(refundUrl(1, 999), { cookie });
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different event", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        maxAttendees: 100,
      });
      const event2 = await createTestEvent({
        name: "Event 2",
        maxAttendees: 100,
      });
      const attendee = await createTestAttendee(
        event2.id,
        event2.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        refundUrl(event1.id, attendee.id),
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("shows error when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        refundUrl(event.id, attendee.id),
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 400, "no payment to refund");
    });

    test("shows refund confirmation page for paid attendee", async () => {
      const ctx = await setupRefundTest("pi_test_123");
      const response = await awaitTestRequest(
        refundUrl(ctx.event.id, ctx.attendee.id),
        { cookie: ctx.cookie },
      );
      await expectHtmlResponse(
        response,
        200,
        "Refund Attendee",
        "John Doe",
        "type their name",
        "£5",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const ctx = await setupRefundTest("pi_test_return");
      const url = `${refundUrl(ctx.event.id, ctx.attendee.id)}?return_url=${
        encodeURIComponent("/admin/calendar#attendees")
      }`;
      const response = await awaitTestRequest(url, { cookie: ctx.cookie });
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/refund", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createPaidEvent();
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(refundUrl(event.id, attendee.id), {
          confirm_name: "John Doe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const ctx = await setupRefundTest("pi_test_456");
      const response = await submitRefund(ctx, { csrf_token: "invalid-token" });
      expect(response.status).toBe(403);
    });

    test("rejects mismatched attendee name", async () => {
      const ctx = await setupRefundTest("pi_test_789");
      const response = await submitRefund(ctx, { confirm_name: "Wrong Name" });
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("returns error when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundUrl(event.id, attendee.id),
          { confirm_name: "John Doe", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "no payment to refund");
    });

    test("returns error when no payment provider configured", async () => {
      const ctx = await setupRefundTest("pi_test_noprov");
      const response = await submitRefund(ctx);
      await expectHtmlResponse(response, 400, "No payment provider configured");
    });

    test("successfully refunds attendee payment", async () => {
      const ctx = await setupRefundTest("pi_test_success");

      await withRefundMock(true, async (mockRefund) => {
        const response = await submitRefund(ctx);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `/admin/event/${ctx.event.id}?success=Refund+issued`,
        );
        expect(mockRefund.calls.length).toBeGreaterThan(0);
      });
    });

    test("shows error when refund fails", async () => {
      const ctx = await setupRefundTest("pi_test_fail");

      await withRefundMock(false, async () => {
        const response = await submitRefund(ctx);
        await expectHtmlResponse(response, 400, "Refund failed");
      });
    });

    test("handles missing confirm_name field", async () => {
      const ctx = await setupRefundTest("pi_test_missing");
      const response = await handleRequest(
        mockFormRequest(refundUrl(ctx.event.id, ctx.attendee.id), {
          csrf_token: ctx.csrfToken,
        }, ctx.cookie),
      );
      await expectHtmlResponse(response, 400, "does not match");
    });
  });

  describe("GET /admin/event/:id/refund-all", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createPaidEvent();
      const response = await handleRequest(mockRequest(refundAllUrl(event.id)));
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await awaitTestRequest(refundAllUrl(999), {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("shows error when no attendees have payments", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(event.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        400,
        "No attendees have payments to refund",
      );
    });

    test("shows refund all confirmation page with refundable count", async () => {
      const event = await createPaidEvent();
      await createPaidTestAttendee(
        event.id,
        "Paid User",
        "paid@example.com",
        "pi_paid_1",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Free User",
        "free@example.com",
      );

      const response = await awaitTestRequest(refundAllUrl(event.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Refund All",
        "1 attendee(s) with payments",
        "type the event name",
      );
    });
  });

  describe("POST /admin/event/:id/refund-all", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createPaidEvent();
      const response = await handleRequest(
        mockFormRequest(refundAllUrl(event.id), { confirm_name: event.name }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockFormRequest(refundAllUrl(999), {
          confirm_name: "Test",
          csrf_token: await testCsrfToken(),
        }, await testCookie()),
      );
      expect(response.status).toBe(404);
    });

    test("rejects mismatched event name", async () => {
      const ctx = await setupRefundTest("pi_refundall_1");
      const response = await submitRefundAll(ctx, {
        confirm_name: "Wrong Event Name",
      });
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("rejects when confirm_name is missing", async () => {
      const ctx = await setupRefundTest("pi_refundall_missing");
      const response = await handleRequest(
        mockFormRequest(refundAllUrl(ctx.event.id), {
          csrf_token: ctx.csrfToken,
        }, ctx.cookie),
      );
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("returns error when no attendees have payments", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          refundAllUrl(event.id),
          { confirm_name: event.name, csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "No attendees have payments to refund",
      );
    });

    test("returns error when no payment provider configured", async () => {
      const ctx = await setupRefundTest("pi_noprov_all");
      const response = await submitRefundAll(ctx);
      await expectHtmlResponse(response, 400, "No payment provider configured");
    });

    test("successfully refunds all attendees", async () => {
      const event = await createPaidEvent();
      await createPaidTestAttendee(
        event.id,
        "User One",
        "one@example.com",
        "pi_all_1",
      );
      await createPaidTestAttendee(
        event.id,
        "User Two",
        "two@example.com",
        "pi_all_2",
      );
      await withRefundMock(true, async (mockRefund) => {
        const response = await handleRequest(
          mockFormRequest(refundAllUrl(event.id), {
            confirm_name: event.name,
            csrf_token: await testCsrfToken(),
          }, await testCookie()),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `/admin/event/${event.id}?success=All+attendees+refunded`,
        );
        expect(mockRefund.calls.length).toBe(2);
      });
    });

    test("reports partial failure when some refunds fail", async () => {
      const event = await createPaidEvent();
      await createPaidTestAttendee(
        event.id,
        "Good User",
        "good@example.com",
        "pi_partial_ok",
      );
      await createPaidTestAttendee(
        event.id,
        "Bad User",
        "bad@example.com",
        "pi_partial_fail",
      );
      let callNum = 0;
      await withRefundMock(
        () => Promise.resolve(++callNum <= 1),
        async () => {
          const response = await handleRequest(
            mockFormRequest(refundAllUrl(event.id), {
              confirm_name: event.name,
              csrf_token: await testCsrfToken(),
            }, await testCookie()),
          );
          await expectHtmlResponse(
            response,
            400,
            "1 refund(s) succeeded",
            "1 failed",
          );
        },
      );
    });
  });

  describe("already-refunded guard", () => {
    test("GET refund page shows error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_already_refunded");
      await markAsRefunded(ctx.attendee.id);

      const response = await awaitTestRequest(
        refundUrl(ctx.event.id, ctx.attendee.id),
        { cookie: ctx.cookie },
      );
      await expectHtmlResponse(response, 400, "already been refunded");
    });

    test("POST refund returns error for already-refunded attendee", async () => {
      const ctx = await setupRefundTest("pi_post_already");
      await markAsRefunded(ctx.attendee.id);

      const response = await submitRefund(ctx);
      await expectHtmlResponse(response, 400, "already been refunded");
    });

    test("refund-all excludes already-refunded attendees", async () => {
      const event = await createPaidEvent();
      const refundedAttendee = await createPaidTestAttendee(
        event.id,
        "Refunded",
        "refunded@example.com",
        "pi_ra_1",
      );
      await createPaidTestAttendee(
        event.id,
        "Not Refunded",
        "notrefunded@example.com",
        "pi_ra_2",
      );
      await markAsRefunded(refundedAttendee.id);

      const response = await awaitTestRequest(refundAllUrl(event.id), {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "1 attendee(s) with payments");
    });

    test("marks attendee as refunded after successful refund", async () => {
      const ctx = await setupRefundTest("pi_mark_refund");

      await withRefundMock(true, async () => {
        const response = await submitRefund(ctx);
        expect(response.status).toBe(302);

        // Verify attendee is marked as refunded by trying to refund again
        const retryResponse = await submitRefund(ctx);
        await expectHtmlResponse(retryResponse, 400, "already been refunded");
      });
    });
  });

  describe("event page UI", () => {
    test("shows Refund link for paid attendees on paid events", async () => {
      const event = await createPaidEvent();
      await createPaidTestAttendee(
        event.id,
        "Paid User",
        "paid@example.com",
        "pi_ui_1",
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(response, 200, "/refund", "Refund All");
    });

    test("does not show Refund link for free events", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(
        event.id,
        event.slug,
        "Free User",
        "free@example.com",
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Refund All");
    });

    test("does not show Refund link for attendees without payment_id on paid events", async () => {
      const event = await createPaidEvent();
      // Create a free attendee on a paid event (no payment_id)
      await createTestAttendee(
        event.id,
        event.slug,
        "No Payment User",
        "nopay@example.com",
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      // The event nav should still show Refund All (because it's a paid event)
      expect(html).toContain("Refund All");
      // But the attendee row should NOT show an individual refund link
      // since the attendee has no payment_id
      expect(html).not.toContain('/refund"');
    });
  });
});
