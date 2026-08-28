import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  seedDailyListingBookedOnOneDay,
  seedListingWithAttendees,
  seedSingleAttendeeListing,
  useResend,
} from "#test/integration/server/bulk-email/helpers.ts";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

describeWithEnv("server bulk email > compose", { db: true }, () => {
  describe("GET /admin/emails", () => {
    testRequiresAuth("/admin/emails");

    test("renders the compose page for an owner", async () => {
      expectHtmlResponse(
        await adminGet("/admin/emails"),
        200,
        "Send a bulk email",
        "Audience",
      );
    });

    test("shows the disabled notice when no own provider is configured", async () => {
      const html = await (await adminGet("/admin/emails")).text();
      expect(html).toContain("Heads up");
      // The notice must say why, not just that something is wrong.
      expect(html).toContain("configured your own email provider");
    });

    test("hides the disabled notice when a bulk provider is configured", async () => {
      useResend();
      const html = await (await adminGet("/admin/emails")).text();
      expect(html).not.toContain("Heads up");
    });

    test("targets a single listing via ?listing", async () => {
      const listing = await seedListingWithAttendees();
      const html = await (
        await adminGet(`/admin/emails?listing=${listing.id}`)
      ).text();
      expect(html).toContain("Recipients:</strong> Attendees of Gig");
    });

    test("404s for a non-existent listing", async () => {
      const response = await adminGet("/admin/emails?listing=9999");
      expect(response.status).toBe(404);
    });

    test("404s for a non-numeric listing", async () => {
      const response = await adminGet("/admin/emails?listing=abc");
      expect(response.status).toBe(404);
    });

    test("falls back to the default audience for an unknown one", async () => {
      expectHtmlResponse(
        await adminGet("/admin/emails?audience=bogus"),
        200,
        "Send a bulk email",
      );
    });

    test("accepts an explicit valid audience", async () => {
      const html = await (
        await adminGet("/admin/emails?audience=upcoming")
      ).text();
      expect(html).toContain('<option selected value="upcoming">');
    });

    test("prefills a saved draft and counts a single recipient", async () => {
      const listing = await seedSingleAttendeeListing();
      await adminFormPost("/admin/emails/preview", {
        body: "Saved body",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Saved subject",
      });
      const html = await (
        await adminGet(`/admin/emails?listing=${listing.id}`)
      ).text();
      expect(html).toContain('value="Saved subject"');
      expect(html).toContain("checked");
      expect(html).toContain("recipient. That's everyone");
      expect(html).not.toContain("recipients");
    });

    test("targets one day of a listing via ?listing&day", async () => {
      const listing = await seedDailyListingBookedOnOneDay();
      const html = await (
        await adminGet(`/admin/emails?listing=${listing.id}&day=2026-03-02`)
      ).text();
      expect(html).toContain(
        "Recipients:</strong> Attendees of Term on Monday 2 March 2026",
      );
    });

    test("404s for a day it cannot honour", async () => {
      const listing = await seedDailyListingBookedOnOneDay();
      for (const query of [
        `listing=${listing.id}&day=not-a-day`,
        `listing=${listing.id}&day=2026-02-30`,
        `listing=${listing.id}&day=`,
        "day=2026-03-02",
        "listing=9999&day=2026-03-02",
        // A real day of a real listing that nobody booked: the target resolves,
        // then the empty recipient set is refused.
        `listing=${listing.id}&day=2026-03-09`,
      ]) {
        const response = await adminGet(`/admin/emails?${query}`);
        expect(response.status).toBe(404);
      }
    });

    test("forbids non-owner admins", async () => {
      const cookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/emails", { cookie });
      expect(response.status).toBe(403);
    });
  });
});
