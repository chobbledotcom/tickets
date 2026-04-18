/**
 * Tests for the admin "generate booking QR code" page.
 *
 * Exercises the end-to-end flow: form rendering, validation, token signing,
 * and the embedded QR SVG. Auth, CSRF, and role checks are shared with other
 * admin routes and tested there.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { verifyQrBookToken } from "#lib/qr-token.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
  mockFormRequest,
  mockRequest,
  testCookie,
} from "#test-utils";

/** Extract the ?t= token from a generated QR booking link */
const extractToken = (html: string): string | null => {
  const match = html.match(/\/qr-book\?t=([^"\s&]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
};

describeWithEnv("admin event-qr route", { db: true }, () => {
  describe("GET /admin/event/:id/qr", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/qr`),
      );
      expect(response.status).toBe(302);
      response.body?.cancel();
    });

    test("returns 404 when the event does not exist", async () => {
      const { response } = await adminGet("/admin/event/99999/qr");
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("renders the form with quantity defaulted to 1", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminGet(`/admin/event/${event.id}/qr`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('name="customer_name"');
      expect(body).toContain('name="value"');
      expect(body).toContain('name="quantity"');
      expect(body).toContain('value="1"');
    });

    test("shows a date selector for daily events", async () => {
      const event = await createDailyTestEvent({ unitPrice: 500 });
      const { response } = await adminGet(`/admin/event/${event.id}/qr`);
      const body = await response.text();
      expect(body).toContain('name="date"');
    });

    test("omits the date selector for standard events", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminGet(`/admin/event/${event.id}/qr`);
      const body = await response.text();
      expect(body).not.toContain('name="date"');
    });
  });

  describe("POST /admin/event/:id/qr", () => {
    test("rejects invalid CSRF for an authenticated session", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const cookie = await testCookie();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/qr`,
          { csrf_token: "invalid", quantity: "1" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      response.body?.cancel();
    });

    test("renders a validation error when quantity exceeds max", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        maxQuantity: 2,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        quantity: "5",
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Quantity cannot exceed 2");
      expect(body).not.toContain("/qr-book?t=");
    });

    test("renders a validation error when quantity is not a number", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        quantity: "abc",
      });
      const body = await response.text();
      expect(body).toContain("Quantity must be at least 1");
    });

    test("renders a validation error when daily event is missing a date", async () => {
      const event = await createDailyTestEvent({ unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        customer_name: "Ada",
        quantity: "1",
        value: "5.00",
      });
      const body = await response.text();
      expect(body).toContain("Date is required");
    });

    test("renders a validation error for pay-more price below minimum", async () => {
      const event = await createTestEvent({
        canPayMore: true,
        maxAttendees: 10,
        maxPrice: 10000,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        quantity: "1",
        value: "1.00",
      });
      const body = await response.text();
      expect(body).toContain("at least the minimum");
    });

    test("accepts any price for fixed-price events as a one-off override", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        customer_name: "Ada",
        quantity: "1",
        // Way above the event's unit_price; allowed for the override
        value: "200.00",
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("/qr-book?t=");
      expect(body).toContain("<svg");
    });

    test("signed token embeds submitted values and matches the event slug", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        customer_name: "Ada Lovelace",
        quantity: "3",
        value: "12.50",
      });
      const body = await response.text();
      const token = extractToken(body);
      expect(token).not.toBeNull();
      const payload = await verifyQrBookToken(event.slug, token!);
      expect(payload).not.toBeNull();
      expect(payload!.n).toBe("Ada Lovelace");
      expect(payload!.v).toBe(1250);
      expect(payload!.q).toBe(3);
    });

    test("generates a token when customer_name is omitted, defaulting quantity to 1", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/event/${event.id}/qr`, {
        // No customer_name, no quantity, no value
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      const token = extractToken(body);
      expect(token).not.toBeNull();
      const payload = await verifyQrBookToken(event.slug, token!);
      expect(payload!.n).toBe("");
      expect(payload!.q).toBe(1);
      expect(payload!.v).toBe(-1);
    });

    test("tokens are scoped to their event slug", async () => {
      const a = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const b = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const { response } = await adminFormPost(`/admin/event/${a.id}/qr`, {
        customer_name: "Ada",
        quantity: "1",
        value: "5.00",
      });
      const body = await response.text();
      const token = extractToken(body)!;
      expect(await verifyQrBookToken(b.slug, token)).toBeNull();
    });
  });

  describe("GET /admin/event/:id/qr.json (client-side refresh)", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/qr.json?quantity=1`),
      );
      expect(response.status).toBe(302);
      response.body?.cancel();
    });

    test("returns 404 when the event does not exist", async () => {
      const { response } = await adminGet("/admin/event/99999/qr.json?quantity=1");
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("returns JSON with a fresh token matching submitted values", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        maxQuantity: 5,
        unitPrice: 500,
      });
      const { response } = await adminGet(
        `/admin/event/${event.id}/qr.json?customer_name=Ada&value=7.50&quantity=2`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const body = (await response.json()) as {
        ok: boolean;
        url: string;
        svg: string;
      };
      expect(body.ok).toBe(true);
      expect(body.svg).toContain("<svg");
      const match = body.url.match(/\/qr-book\?t=([^&]+)/);
      expect(match).not.toBeNull();
      const token = decodeURIComponent(match![1]!);
      const payload = await verifyQrBookToken(event.slug, token);
      expect(payload!.n).toBe("Ada");
      expect(payload!.v).toBe(750);
      expect(payload!.q).toBe(2);
    });

    test("returns 400 JSON on validation failure", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        maxQuantity: 2,
        unitPrice: 500,
      });
      const { response } = await adminGet(
        `/admin/event/${event.id}/qr.json?quantity=99`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        ok: boolean;
        error?: string;
      };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Quantity cannot exceed");
    });

    test("signs a different token each minute (fresh expiry)", async () => {
      const event = await createTestEvent({ maxAttendees: 10, unitPrice: 500 });
      const first = await adminGet(
        `/admin/event/${event.id}/qr.json?customer_name=Ada&value=5.00&quantity=1`,
      );
      await new Promise((r) => setTimeout(r, 1100));
      const second = await adminGet(
        `/admin/event/${event.id}/qr.json?customer_name=Ada&value=5.00&quantity=1`,
      );
      const a = (await first.response.json()) as { url: string };
      const b = (await second.response.json()) as { url: string };
      expect(a.url).not.toBe(b.url);
    });
  });
});
