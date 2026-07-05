import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { groupsTable } from "#shared/db/groups.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  bookAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtmlResponse,
  fillSoleCapacityListing,
  mockRequest,
  setupStripe,
  signMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("skips refund for ticket payment when listing not found", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_notfound",
          metadata: {
            email: "missing@example.com",

            items: JSON.stringify([{ e: 99999, p: 500, q: 1 }]),
            name: "Missing Listing",
          },
          payment_intent: "pi_multi_notfound",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_notfound"),
        );
        // Unsigned → ignored as not ours: not-recognized page, never refunded
        // (the session may belong to a different instance sharing the provider).
        await expectHtmlResponse(response, 400, "not recognized");
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("a multi-item session with a now-hidden, deactivated member refunds without leaking the member name", async () => {
      await setupStripe();
      const visible = await createTestListing({
        name: "Open Add-On",
        unitPrice: 500,
      });
      const group = await createTestGroup({ isPackage: true, name: "Bundle" });
      await groupsTable.update(group.id, { hidePackageListings: true });
      // The standalone session was signed before this listing became a hidden
      // package member; it is then deactivated, so per-item validation fails on
      // it. The failure message must not expose the concealed member's name.
      const member = await createTestListing({
        groupId: group.id,
        name: "Concealed Member XYZ",
        unitPrice: 500,
      });
      await deactivateTestListing(member.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_stale_hidden_multi",
          metadata: signMeta(
            {
              email: "stale@example.com",
              items: JSON.stringify([
                { e: visible.id, p: 500, q: 1 },
                { e: member.id, p: 500, q: 1 },
              ]),
              name: "Stale Buyer",
            },
            1000,
          ),
          payment_intent: "pi_stale_hidden_multi",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_stale_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_stale_hidden_multi"),
        );
        const body = await response.text();
        expect(body).not.toContain("Concealed Member XYZ");
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("a package session whose group was deleted refunds without naming members", async () => {
      await setupStripe();
      // A package checkout signed while the group existed; the group is then
      // deleted and a member deactivated before /payment/success. The stale
      // group can no longer say whether it hid its listings, so the refund
      // fails SAFE as hidden and must not name the member.
      const group = await createTestGroup({
        isPackage: true,
        name: "Gone Kit",
      });
      const keeper = await createTestListing({
        groupId: group.id,
        name: "Surviving Member",
        unitPrice: 500,
      });
      const vanished = await createTestListing({
        groupId: group.id,
        name: "Vanished Member XYZ",
        unitPrice: 500,
      });
      await deactivateTestListing(vanished.id);
      await groupsTable.deleteById(group.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_stale_pkg_group",
          metadata: signMeta(
            {
              email: "stale-pkg@example.com",
              items: JSON.stringify([
                { e: keeper.id, k: "p", p: 500, q: 1, r: group.id },
                { e: vanished.id, k: "p", p: 500, q: 1, r: group.id },
              ]),
              name: "Stale Package Buyer",
            },
            1000,
          ),
          payment_intent: "pi_stale_pkg_group",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_stale_pkg_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_stale_pkg_group"),
        );
        expect(response.status).toBe(410);
        const body = await response.text();
        expect(body).toContain("no longer accepting registrations");
        expect(body).not.toContain("Vanished Member XYZ");
        expect(mockRefund.calls[0]!.args).toEqual(["pi_stale_pkg_group"]);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("refunds ticket payment when listing is inactive", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Inactive Pay",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_multi_inactive",
          metadata: signMeta(
            {
              email: "inactive@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Inactive Listing",
            },
            500,
          ),
          payment_intent: "pi_multi_inactive",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_inactive_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_inactive"),
        );
        await expectHtmlResponse(
          response,
          410,
          "no longer accepting registrations",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows refund failure message when refund fails", async () => {
      await setupStripe();

      const listing = await fillSoleCapacityListing();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_refund_fail",
          metadata: signMeta(
            {
              email: "refund@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Refund Fail",
            },
            1000,
          ),
          payment_intent: "pi_refund_fail",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      // Mock refund to fail, and the payment is not already refunded, so the
      // refund genuinely failed (→ contact-support, not an idempotent success).
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );
      const mockIntent = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve({
          latest_charge: { refunded: false },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrievePaymentIntent>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        // Kept as a quantity-0 placeholder; the refund FAILED, so the customer is
        // told their details are saved and the refund is being arranged (HTTP 200).
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refund is being arranged",
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        const ghost = (await getAttendeesRaw(listing.id)).find(
          (a) => a.quantity === 0,
        );
        expect(ghost).toBeDefined();
        expect(await getNoteRows([ghost!.id])).toHaveLength(1);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
        mockIntent.restore();
      }
    });

    test("ticket payment capacity failure is kept as a placeholder and refunded", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Rollback 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi Rollback 2",
        unitPrice: 1000,
      });

      // Fill listing2
      await bookAttendee(listing2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_rollback",
          metadata: signMeta(
            {
              email: "rollback@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Rollback User",
            },
            1500,
          ),
          payment_intent: "pi_multi_rollback",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_rollback_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        // The capacity failure no longer drops the booking: it's kept as a
        // quantity-0 placeholder across BOTH listings and refunded (HTTP 200).
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refunded",
        );

        // The paid customer is never lost: a quantity-0 ghost is kept on listing1
        // (not rolled back to nothing).
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const ghost1 = (await getAttendeesRaw(listing1.id)).find(
          (a) => a.quantity === 0,
        );
        expect(ghost1).toBeDefined();
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });
  });
});
