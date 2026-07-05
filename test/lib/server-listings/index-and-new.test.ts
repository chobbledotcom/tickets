// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  adminGet,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("server listings > index and new", { db: true }, () => {
  describe("GET /admin/listings", () => {
    testRequiresAuth("/admin/listings");

    test("renders active listings before deactivated listings", async () => {
      const active = await createTestListing({ name: "Active Show" });
      const deactivated = await createTestListing({ name: "Old Show" });
      await deactivateTestListing(deactivated.id);

      const response = await adminGet("/admin/listings");
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('class="active" href="/admin/listings"');
      expect(html).toContain(active.name);
      expect(html).toContain(deactivated.name);
      expect(html.indexOf(active.name)).toBeLessThan(
        html.indexOf(deactivated.name),
      );
    });
  });

  describe("GET /admin/listing/new", () => {
    testRequiresAuth("/admin/listing/new");

    test("renders type picker when authenticated (no template param)", async () => {
      const response = await adminGet("/admin/listing/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });

    test("renders create listing form with template=custom", async () => {
      const response = await adminGet("/admin/listing/new?template=custom");
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        'action="/admin/listing"',
      );
    });

    test("renders create listing form with a named template param", async () => {
      const response = await adminGet(
        "/admin/listing/new?template=one-off-event",
      );
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        'action="/admin/listing"',
      );
    });

    test("redirects to picker when a logistics template is requested but logistics is disabled", async () => {
      settings.setForTest({ has_logistics: false });
      const response = await adminGet(
        "/admin/listing/new?template=hireable-item",
      );
      await expectHtmlResponse(
        response,
        200,
        "Add Listing",
        "Choose a listing type",
      );
    });
  });
});
