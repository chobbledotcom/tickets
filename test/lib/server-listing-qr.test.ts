/**
 * Tests for ticket QR code route
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { handleTicketQrGet } from "#routes/public/ticket-routes.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

describeWithEnv("ticket QR code", { db: true }, () => {
  describe("GET /ticket/:slug/qr", () => {
    test("returns SVG content type for valid listing", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}/qr`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
    });

    test("returns valid SVG with QR code", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}/qr`),
      );
      const body = await response.text();
      expect(body).toContain("<svg");
      expect(body).toContain("</svg>");
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await handleRequest(
        mockRequest("/ticket/no-such-listing/qr"),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("handleTicketQrGet", () => {
    test("generates QR code encoding listing public URL", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const request = mockRequest(`/ticket/${listing.slug}/qr`);
      const response = await handleTicketQrGet(request, { slug: listing.slug });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const body = await response.text();
      expect(body).toContain("<svg");
    });

    test("returns 404 for missing listing", async () => {
      const request = mockRequest("/ticket/no-such-listing/qr");
      const response = await handleTicketQrGet(request, {
        slug: "no-such-listing",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("group QR code", () => {
    test("returns SVG QR code for valid group slug", async () => {
      const group = await createTestGroup();
      // The group needs a standalone-bookable member, or its booking page (and so
      // its QR) 404s as a dead link (Fix 3).
      await createTestListing({ groupId: group.id, name: "Member" });
      const response = await handleRequest(
        mockRequest(`/ticket/${group.slug}/qr`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const body = await response.text();
      expect(body).toContain("<svg");
      expect(body).toContain("</svg>");
    });

    test("handleTicketQrGet returns QR code for group slug", async () => {
      const group = await createTestGroup();
      await createTestListing({ groupId: group.id, name: "Member" });
      const request = mockRequest(`/ticket/${group.slug}/qr`);
      const response = await handleTicketQrGet(request, {
        slug: group.slug,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const body = await response.text();
      expect(body).toContain("<svg");
    });
  });
});
