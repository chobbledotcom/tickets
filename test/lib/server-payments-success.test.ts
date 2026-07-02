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
  expectRedirect,
  followRedirect,
  mockRequest,
  setTestEnv,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes ticket payment success", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2500,
          id: "cs_multi_success",
          metadata: signMeta(
            {
              email: "multi@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 2000, q: 2 },
              ]),
              name: "Multi Payer",
            },
            2500,
          ),
          payment_intent: "pi_multi_success",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        // With multi-listing attendees, one token covers all listings
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "Thank you for your order",
          "Click here to view your ticket",
        );

        // Verify attendees created for both listings
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("stamps package_group_id on a paid package booking", async () => {
      // The webhook/redirect package path threads intent.packageGroupId onto the
      // created booking rows, so tickets/emails group the order by the persisted
      // id rather than membership equality.
      await setupStripe();
      const { getDb } = await import("#shared/db/client.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Paid Kit",
        slug: "paid-kit",
      });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Paid Member",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_pkg_paid",
          metadata: signMeta(
            {
              email: "pkgpaid@example.com",
              items: JSON.stringify([
                { e: member.id, k: "p", p: 1000, q: 1, r: group.id },
              ]),
              name: "Pkg Payer",
              package_group_id: String(group.id),
            },
            1000,
          ),
          payment_intent: "pi_pkg_paid",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_paid"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const row = (
          await getDb().execute({
            args: [member.id],
            sql: "SELECT package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
          })
        ).rows[0]!;
        expect(Number(row.package_group_id)).toBe(group.id);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("a paid DAILY package books every member on the signed date", async () => {
      // A dated package rides the order-level `date` metadata; the webhook's
      // tree revalidation must accept the tagged dated lines (no false drift)
      // and persist each member's row on that date.
      await setupStripe();
      const { getDb } = await import("#shared/db/client.ts");
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Dated Kit",
        slug: "dated-kit",
      });
      const boat = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Dated Boat",
        unitPrice: 700,
      });
      const hut = await createTestListing({
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Dated Hut",
        unitPrice: 300,
      });
      const date = addDays(todayInTz("UTC"), 2);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_pkg_dated",
          metadata: signMeta(
            {
              date,
              email: "dated@example.com",
              items: JSON.stringify([
                { e: boat.id, k: "p", p: 700, q: 1, r: group.id },
                { e: hut.id, k: "p", p: 300, q: 1, r: group.id },
              ]),
              name: "Dated Payer",
              package_group_id: String(group.id),
            },
            1000,
          ),
          payment_intent: "pi_pkg_dated",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_dated"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        for (const member of [boat, hut]) {
          const row = (
            await getDb().execute({
              args: [member.id],
              sql: "SELECT start_at, package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
            })
          ).rows[0]!;
          expect(String(row.start_at).slice(0, 10)).toBe(date);
          expect(Number(row.package_group_id)).toBe(group.id);
        }
      } finally {
        mockRetrieve.restore();
      }
    });

    test("a paid CUSTOMISABLE package revalidates per-day overrides for the signed day count", async () => {
      // The boat's 2-day price is overridden inside this package (1000, not its
      // own 1200); the hut keeps its own 2-day price. The webhook's
      // expectedItemPrice must re-derive both from CURRENT config — a mismatch
      // would refund instead of booking.
      await setupStripe();
      const { getDb } = await import("#shared/db/client.ts");
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const { setGroupPackageMembers } = await import("#shared/db/groups.ts");
      const group = await createTestGroup({
        isPackage: true,
        name: "Flex Paid Kit",
        slug: "flex-paid-kit",
      });
      const boat = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 700, 2: 1200 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Flex Paid Boat",
        unitPrice: 700,
      });
      const hut = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 500, 2: 900 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 50,
        minimumDaysBefore: 0,
        name: "Flex Paid Hut",
        unitPrice: 500,
      });
      await setGroupPackageMembers(group.id, [
        { dayPrices: { 2: 1000 }, listingId: boat.id, price: null },
        { listingId: hut.id, price: null },
      ]);
      const date = addDays(todayInTz("UTC"), 2);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1900,
          id: "cs_pkg_flex_paid",
          metadata: signMeta(
            {
              date,
              day_count: "2",
              email: "flexpaid@example.com",
              items: JSON.stringify([
                { e: boat.id, k: "p", p: 1000, q: 1, r: group.id },
                { e: hut.id, k: "p", p: 900, q: 1, r: group.id },
              ]),
              name: "Flex Payer",
              package_group_id: String(group.id),
            },
            1900,
          ),
          payment_intent: "pi_pkg_flex_paid",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_pkg_flex_paid"),
        );
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        for (const member of [boat, hut]) {
          const row = (
            await getDb().execute({
              args: [member.id],
              sql: "SELECT start_at, package_group_id FROM listing_attendees WHERE listing_id = ? ORDER BY id DESC LIMIT 1",
            })
          ).rows[0]!;
          expect(String(row.start_at).slice(0, 10)).toBe(date);
          expect(Number(row.package_group_id)).toBe(group.id);
        }
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns error for invalid ticket metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_bad_multi",
          metadata: {
            email: "bad@example.com",

            items: "not-an-array",
            name: "Bad",
          },
          payment_intent: "pi_bad",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        // No valid proof (unsigned, and the items don't parse) → ignored.
        await expectHtmlResponse(response, 400, "not recognized");
      } finally {
        mockRetrieve.restore();
      }
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
                { e: keeper.id, p: 500, q: 1 },
                { e: vanished.id, p: 500, q: 1 },
              ]),
              name: "Stale Package Buyer",
              package_group_id: String(group.id),
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

      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the listing
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

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

    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_thankyou",
          metadata: signMeta(
            {
              email: "single@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Single",
            },
            500,
          ),
          payment_intent: "pi_single_thankyou",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "https://example.com/single-thanks",
          "Click here to view your ticket",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("suppresses thank_you_url for a hidden package's sole member", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Hidden Success Pkg",
        slug: "hidden-success-pkg",
      });
      await groupsTable.update(group.id, { hidePackageListings: true });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Concealed Member",
        thankYouUrl: "https://example.com/concealed-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_hidden_pkg",
          metadata: signedMeta(
            {
              email: "concealed@example.com",
              // A package member carries its package edge tag (k:"p", r:group)
              // so the webhook's tree revalidation resolves it as a package
              // member rather than a standalone listing.
              items: JSON.stringify([
                { e: listing.id, k: "p", p: 500, q: 1, r: group.id },
              ]),
              name: "Concealed Buyer",
              package_group_id: String(group.id),
            },
            500,
          ),
          payment_intent: "pi_hidden_pkg",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_hidden_pkg"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
        const html = await response.text();
        // The ticket link still shows, but the concealed member's thank-you URL
        // (which would meta-refresh to the listing the package hid) must not leak.
        expect(html).toContain("Click here to view your ticket");
        expect(html).not.toContain("https://example.com/concealed-thanks");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("suppresses thank_you_url on replay for a hidden package's sole member", async () => {
      await setupStripe();

      const group = await createTestGroup({
        isPackage: true,
        name: "Hidden Replay Pkg",
        slug: "hidden-replay-pkg",
      });
      await groupsTable.update(group.id, { hidePackageListings: true });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Concealed Replay Member",
        thankYouUrl: "https://example.com/concealed-replay",
        unitPrice: 700,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 700,
          id: "cs_hidden_replay",
          metadata: signedMeta(
            {
              email: "replay@example.com",
              // Package member tagged with its edge (k:"p", r:group) so the
              // webhook's tree revalidation resolves it as a package member.
              items: JSON.stringify([
                { e: listing.id, k: "p", p: 700, q: 1, r: group.id },
              ]),
              name: "Replay Buyer",
              package_group_id: String(group.id),
            },
            700,
          ),
          payment_intent: "pi_hidden_replay",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request redirects with tokens (no stored tokens — a hidden package
        // carries no explicit thank-you URL, so storeTokens is false).
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_hidden_replay"),
        );
        expect(response1.status).toBe(302);
        // Replay finds the session already processed with no stored tokens, so it
        // renders directly via the single-listing fallback — which must suppress
        // the concealed member's thank-you URL too.
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_hidden_replay"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        expect(html).not.toContain("https://example.com/concealed-replay");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_dupe_session",
          metadata: signMeta(
            {
              email: "dupe@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Dupe",
            },
            1000,
          ),
          payment_intent: "pi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");

        // Should still only have one attendee
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles single-item cart session replay (shows thank_you_url)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_cart_single",
          metadata: signMeta(
            {
              email: "cartsingle@example.com",
              items: JSON.stringify([{ e: listing.id, p: 800, q: 1 }]),
              name: "Cart Single Buyer",
            },
            800,
          ),
          payment_intent: "pi_cart_single",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request: process and redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response1.status).toBe(302);

        // Follow redirect to render success page with tokens
        const tokenResponse = await followRedirect(response1, handleRequest);
        const tokenHtml = await tokenResponse.text();
        // Single-listing cart: token path resolves one unique listing → shows thank_you_url
        expect(tokenHtml).toContain("redirected");

        // Replay (no tokens stored): renders directly via items.length === 1 branch
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        // Single-item cart replay also shows thank_you_url
        expect(html).toContain("redirected");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles ticket duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_dupe",
          metadata: signMeta(
            {
              email: "multireplay@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Multi Replay",
            },
            1500,
          ),
          payment_intent: "pi_multi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
      } finally {
        mockRetrieve.restore();
      }
    });
  });

  describe("payment success token verification", () => {
    test("returns error for tokens param with only delimiters", async () => {
      // %2B decodes to "+", parseTokens produces empty array, no tokens to verify
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=%2B"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for empty tokens param", async () => {
      // Empty string is falsy → falls through to final error
      const response = await handleRequest(
        mockRequest("/payment/success?tokens="),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for invalid tokens not in database", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=nonexistent_token"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error when no session_id or tokens param", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
    });

    test("renders ticket link from verified tokens", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/verified-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_token_verify",
          metadata: signMeta(
            {
              email: "verify@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Token Verify",
            },
            500,
          ),
          payment_intent: "pi_token_verify",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // Process payment to get redirect with token
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_token_verify"),
        );
        const location = expectRedirect(redirectResponse);

        // Follow redirect to verify tokens and render page
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
        const html = await response.text();

        // Should have ticket link with verified token
        expect(html).toContain("Click here to view your ticket");
        expect(html).toContain('target="_blank"');
        expect(html).toContain("/t/");

        // Should have thank_you_url for single-listing purchase
        expect(html).toContain("https://example.com/verified-thanks");

        // Token in the link should match the one in the redirect URL
        const tokenFromUrl = decodeURIComponent(location.split("tokens=")[1]!);
        expect(html).toContain(`/t/${tokenFromUrl}`);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("shows email notice on payment success when email configured", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Create attendee directly (simulates post-payment state)
      const result = await bookAttendee(listing, {
        email: "buyer@example.com",
        name: "Email Test",
        paymentId: "pi_email_notice",
        pricePaid: 500,
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const restore = setTestEnv({
        HOST_EMAIL_API_KEY: "re_test123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@tickets.com",
        HOST_EMAIL_PROVIDER: "resend",
      });

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?tokens=${encodeURIComponent(
              result.attendees[0]!.ticket_token,
            )}`,
          ),
        );
        const html = await expectHtmlResponse(response, 200, "Junk/Spam");
        expect(html).toContain("noreply@tickets.com");
      } finally {
        restore();
      }
    });
  });
});
