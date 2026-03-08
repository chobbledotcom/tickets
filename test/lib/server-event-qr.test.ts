/**
 * Tests for event QR code route
 */

import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import {
  createTestDbWithSetup,
  createTestEvent,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";
import { handleEventQrGet } from "#routes/event-qr.ts";

describe("event QR code", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /event/:id/qr", () => {
    test("returns SVG content type for valid event", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(mockRequest(`/event/${event.id}/qr`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
    });

    test("returns valid SVG with QR code", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const response = await handleRequest(mockRequest(`/event/${event.id}/qr`));
      const body = await response.text();
      expect(body).toContain("<svg");
      expect(body).toContain("</svg>");
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(mockRequest("/event/99999/qr"));
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-numeric id", async () => {
      const response = await handleRequest(mockRequest("/event/abc/qr"));
      expect(response.status).toBe(404);
    });
  });

  describe("handleEventQrGet", () => {
    test("generates QR code encoding event public URL", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const request = mockRequest(`/event/${event.id}/qr`);
      const response = await handleEventQrGet(request, { id: event.id });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const body = await response.text();
      expect(body).toContain("<svg");
    });

    test("returns 404 for missing event", async () => {
      const request = mockRequest("/event/99999/qr");
      const response = await handleEventQrGet(request, { id: 99999 });
      expect(response.status).toBe(404);
    });
  });
});
