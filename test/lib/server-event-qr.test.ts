/**
 * Tests for ticket QR code route
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { handleTicketQrGet } from "#routes/public/ticket-routes.ts";
import {
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

describeWithEnv("ticket QR code", { db: true }, () => {
  describe("GET /ticket/:slug/qr", () => {
    test("returns SVG content type for valid event", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}/qr`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
    });

    test("returns valid SVG with QR code", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}/qr`),
      );
      const body = await response.text();
      expect(body).toContain("<svg");
      expect(body).toContain("</svg>");
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockRequest("/ticket/no-such-event/qr"),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("handleTicketQrGet", () => {
    test("generates QR code encoding event public URL", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const request = mockRequest(`/ticket/${event.slug}/qr`);
      const response = await handleTicketQrGet(request, { slug: event.slug });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const body = await response.text();
      expect(body).toContain("<svg");
    });

    test("returns 404 for missing event", async () => {
      const request = mockRequest("/ticket/no-such-event/qr");
      const response = await handleTicketQrGet(request, {
        slug: "no-such-event",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("group QR code", () => {
    test("returns SVG QR code for valid group slug", async () => {
      const group = await createTestGroup();
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
