import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { handleRequest } from "#routes";
import {
  adminGet,
  createTestDbWithSetup,
  expectAdminRedirect,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("server (admin guide)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/guide", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/guide"));
      expectAdminRedirect(response);
    });

    test("renders guide page when authenticated", async () => {
      const { response } = await adminGet("/admin/guide");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Guide");
    });

    test("contains FAQ sections", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("Getting Started");
      expect(html).toContain("Events");
      expect(html).toContain("Payments");
      expect(html).toContain("Check-in");
    });

    test("contains payment reservation info", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("5 minutes");
    });

    test("contains add attendee info", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("Add Attendee");
    });

    test("contains admin navigation", async () => {
      const { response } = await adminGet("/admin/guide");
      const html = await response.text();
      expect(html).toContain("/admin/guide");
      expect(html).toContain("Events");
      expect(html).toContain("Logout");
    });
  });
});
