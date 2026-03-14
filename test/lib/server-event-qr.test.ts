/**
 * Tests for ticket QR code route
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { handleTicketQrGet } from "#routes/public.ts";
import {
  createTestDbWithSetup,
  createTestEvent,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

describe("ticket QR code", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

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
});
