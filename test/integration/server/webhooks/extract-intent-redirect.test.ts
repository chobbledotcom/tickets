// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > extractIntent + redirect/renewal",
  { db: true },
  () => {
    test("extractIntent rejects missing items in metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          currency: "gbp",
          id: "cs_no_items",
          metadata: {
            email: "john@example.com",
            name: "John",
            // items intentionally omitted — should cause an error
          },
          payment_intent: "pi_no_items",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_no_items"),
        );
        // extractIntent catches error and returns 400
        expect(redirectResponse.status).toBe(400);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("extractIntent preserves quantity 0 from metadata", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 0,
        email: "john@example.com",
        items: singleItem(listing.id, 0, 0),
        name: "John",
        paymentIntent: "pi_qty_zero",
        sessionId: "cs_qty_zero",
      });

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_qty_zero"),
        );
        expect(redirectResponse.status).toBe(302);
        // The booking is created from metadata without coercing 0→1, but the
        // success page treats a token resolving only to quantity-0 lines as an
        // invalid callback (a quantity-0 line has no live ticket).
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(400);

        // Verify attendee was created with quantity 0, not silently converted to 1
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(0);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("payment success redirect threads siteToken through to the renewal push", async () => {
      await setupStripe();

      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const { insertBuiltSite, builtSites } = await import(
        "#db/built-sites.ts"
      );
      const { provisionTestBuiltSite } = await import(
        "#test-utils/db-helpers/built-sites.ts"
      );
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      await insertBuiltSite(
        "Token Site",
        "tok.b-cdn.net",
        "",
        "",
        false,
        "9100",
      );
      const seedSite = (await builtSites.getAll()).find(
        (s) => s.name === "Token Site",
      )!;
      const { tokenIndex } = await provisionTestBuiltSite(seedSite.id, {
        readOnlyFrom: "2030-01-01T00:00:00Z",
      });

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        metadata: signMeta(
          webhookMeta({
            email: "renew@example.com",
            items: singleItem(tier.id, 1, 1000),
            name: "Renewer",
            site_token_index: tokenIndex,
          }),
          1000,
        ),
        paymentIntent: "pi_site_token",
        sessionId: "cs_site_token",
      });

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_site_token"),
        );
        expect(redirectResponse.status).toBe(302);
        // Threading proof: a READ_ONLY_FROM push lands on the right edge script,
        // proving the site_token_index was extracted, matched, and bumped.
        const readOnlyCall = secretStub.calls.find(
          (c) => (c.args[1] as string) === "READ_ONLY_FROM",
        );
        expect(readOnlyCall).toBeDefined();
        expect(readOnlyCall!.args[0]).toBe(Number(seedSite.hostingId));
      } finally {
        mockRetrieve.restore();
        secretStub.restore();
      }
    });

    test("payment success rejects renewal metadata from an unrecognized origin", async () => {
      await setupStripe();

      const tier = await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          currency: "gbp",
          id: "cs_foreign_site_token",
          metadata: {
            email: "renew@example.com",
            items: singleItem(tier.id, 1, 1000),
            name: "Renewer",
            site_token_index: "foreign-token-index",
          },
          payment_intent: "pi_foreign_site_token",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_foreign_site_token"),
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(
          "Payment session not recognized",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("payment success applies multi-tier renewal months cumulatively", async () => {
      await setupStripe();

      await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 1,
        name: "Monthly multi-tier renewal",
        purchaseOnly: true,
        unitPrice: 1000,
      });
      await createTestListing({
        hidden: true,
        maxAttendees: 50,
        monthsPerUnit: 12,
        name: "Annual multi-tier renewal",
        purchaseOnly: true,
        unitPrice: 1000,
      });

      const { addMonthsIso } = await import("#shared/dates.ts");
      const { getAllListings } = await import("#db/listings/records.ts");
      const { insertBuiltSite, builtSites } = await import(
        "#db/built-sites.ts"
      );
      const { provisionTestBuiltSite } = await import(
        "#test-utils/db-helpers/built-sites.ts"
      );
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      const listings = await getAllListings();
      const monthly = listings.find(
        (e) => e.name === "Monthly multi-tier renewal",
      )!;
      const annual = listings.find(
        (e) => e.name === "Annual multi-tier renewal",
      )!;

      // A deadline in the far future keeps the stacking on this date, not on
      // the clock the test runs under.
      const initialDeadline = "2030-01-01T00:00:00Z";
      await insertBuiltSite(
        "Multi Tier Renewal Site",
        "multi-renew.b-cdn.net",
        "",
        "",
        false,
        "9101",
      );
      const seedSite = (await builtSites.getAll()).find(
        (s) => s.name === "Multi Tier Renewal Site",
      )!;
      const { tokenIndex } = await provisionTestBuiltSite(seedSite.id, {
        readOnlyFrom: initialDeadline,
      });

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );
      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 3000,
        metadata: signMeta(
          webhookMeta({
            email: "renew@example.com",
            items: JSON.stringify([
              { e: monthly.id, p: 2000, q: 2 },
              { e: annual.id, p: 1000, q: 1 },
            ]),
            name: "Renewer",
            site_token_index: tokenIndex,
          }),
          3000,
        ),
        paymentIntent: "pi_multi_tier_renewal",
        sessionId: "cs_multi_tier_renewal",
      });

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_tier_renewal"),
        );
        expect(redirectResponse.status).toBe(302);

        const updated = (await builtSites.getAll()).find(
          (s) => s.id === seedSite.id,
        )!;
        const expectedDeadline = addMonthsIso(initialDeadline, 14);
        expect(updated.readOnlyFrom).toBe(expectedDeadline);

        const pushedDeadlines = secretStub.calls
          .filter((c) => (c.args[1] as string) === "READ_ONLY_FROM")
          .map((c) => c.args[2] as string);
        expect(pushedDeadlines.at(-1)).toBe(expectedDeadline);
      } finally {
        mockRetrieve.restore();
        secretStub.restore();
      }
    });

    test("payment success reads orderId param for Square redirect", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        email: "square@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square User",
        paymentIntent: "pi_square_order",
        sessionId: "cs_square_order",
      });

      try {
        // Square appends orderId as a query parameter (not session_id)
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?orderId=cs_square_order"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
      } finally {
        mockRetrieve.restore();
      }
    });
  },
);
