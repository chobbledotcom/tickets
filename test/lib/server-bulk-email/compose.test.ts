import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
import {
  seedListingWithAttendees,
  seedSingleAttendeeListing,
  useResend,
} from "./helpers.ts";

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

    test("forbids non-owner admins", async () => {
      const cookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/emails", { cookie });
      expect(response.status).toBe(403);
    });
  });
});
