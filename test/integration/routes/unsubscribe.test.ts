import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import {
  hashEmail,
  isHashUnsubscribed,
  unsubscribeHash,
} from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";

const getUnsubscribe = (query = ""): Promise<Response> =>
  handleRequest(mockRequest(`/unsubscribe${query}`));

const postUnsubscribe = async (
  data: Record<string, string>,
  csrf?: string,
): Promise<Response> => {
  const token = csrf ?? (await signCsrfToken());
  return handleRequest(
    mockFormRequest("/unsubscribe", { csrf_token: token, ...data }),
  );
};

/** Whether a contact_preferences row exists for the hash at all. Every
 * production read answers the same for "no row" and "a zeroed row", and the
 * forget pin's claim is precisely that the row is gone. */
const rowExists = async (hash: string): Promise<boolean> =>
  (await queryOne<{ present: number }>(
    "SELECT 1 AS present FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  )) !== null;

// The GET renders and POST actions are told in the customer's terms by the
// story `attendees.asking-to-be-left-alone`; these pins own the direct
// coverage of each branch, which a Cucumber journey may never be the only
// cover of.
describeWithEnv("routes (unsubscribe)", { db: true }, () => {
  describe("GET /unsubscribe", () => {
    test("shows the subscribed state for a known hash", async () => {
      const hash = await hashEmail("reader@example.com");
      const response = await getUnsubscribe(
        `?email=${encodeURIComponent(hash)}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Email preferences",
        "currently subscribed",
        "Unsubscribe",
        "Delete my data",
        "one-way code",
        "Other contact details from past bookings",
      );
    });

    test("shows the unsubscribed state once opted out", async () => {
      const hash = await hashEmail("gone@example.com");
      await unsubscribeHash(hash);
      const response = await getUnsubscribe(
        `?email=${encodeURIComponent(hash)}`,
      );
      await expectHtmlResponse(response, 200, "unsubscribed", "Resubscribe");
    });

    test("explains an invalid link with no hash", async () => {
      const response = await getUnsubscribe();
      await expectHtmlResponse(response, 200, "invalid or incomplete");
    });

    test("includes the website title when one is set", async () => {
      settings.setForTest({ website_title: "Acme Tickets" });
      const response = await getUnsubscribe();
      await expectHtmlResponse(
        response,
        200,
        "Email preferences - Acme Tickets",
      );
    });
  });

  describe("POST /unsubscribe", () => {
    test("unsubscribes the hash and confirms with an info flash", async () => {
      const hash = await hashEmail("leaver@example.com");
      const response = await postUnsubscribe({
        action: "unsubscribe",
        email: hash,
      });
      // The redirect carries the hash back, so the page still knows them.
      expectRedirect(
        response,
        "/unsubscribe",
        `email=${encodeURIComponent(hash)}`,
      );
      expect(await isHashUnsubscribed(hash)).toBe(true);

      const followed = await followRedirectWithFlash(response, handleRequest);
      const html = await expectHtmlResponse(
        followed,
        200,
        "You've unsubscribed",
      );
      expect(html).toContain('class="info"');
      expect(html).not.toContain('class="success"');
    });

    test("resubscribes the hash and confirms with a success flash", async () => {
      const hash = await hashEmail("returner@example.com");
      await unsubscribeHash(hash);
      const response = await postUnsubscribe({
        action: "resubscribe",
        email: hash,
      });
      expectRedirect(
        response,
        "/unsubscribe",
        `email=${encodeURIComponent(hash)}`,
      );
      expect(await isHashUnsubscribed(hash)).toBe(false);

      const followed = await followRedirectWithFlash(response, handleRequest);
      const html = await expectHtmlResponse(
        followed,
        200,
        "You've resubscribed",
      );
      expect(html).toContain('class="success"');
      expect(html).not.toContain('class="info"');
    });

    test("forgetting deletes the contact row outright", async () => {
      const hash = await hashEmail("forgetme@example.com");
      await unsubscribeHash(hash);
      expect(await rowExists(hash)).toBe(true);

      const response = await postUnsubscribe({ action: "forget", email: hash });
      expectRedirect(response, "/unsubscribe");
      expect(await rowExists(hash)).toBe(false);
    });

    test("explains a POST with no hash instead of acting", async () => {
      // Unreachable through the rendered page (its forms always carry the
      // hash), so this stays a direct contract with no story scenario.
      const response = await postUnsubscribe({ action: "unsubscribe" });
      expectRedirect(response, "/unsubscribe");
      const followed = await followRedirectWithFlash(response, handleRequest);
      await expectHtmlResponse(followed, 200, "That link is invalid.");
    });

    test("rejects an invalid CSRF token", async () => {
      const hash = await hashEmail("nope@example.com");
      const response = await postUnsubscribe(
        { action: "unsubscribe", email: hash },
        "bad-token",
      );
      expect(response.status).toBe(403);
      expect(await isHashUnsubscribed(hash)).toBe(false);
    });
  });
});
