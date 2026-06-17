import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  getVisits,
  hashEmail,
  isHashUnsubscribed,
  recordVisit,
  unsubscribeHash,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import {
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  followRedirectWithFlash,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

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

    test("offers the delete-my-data action for a valid link", async () => {
      const hash = await hashEmail("erasable@example.com");
      const response = await getUnsubscribe(
        `?email=${encodeURIComponent(hash)}`,
      );
      const html = await expectHtmlResponse(response, 200, "Delete my data");
      // The forget action posts back with action=forget.
      expect(html).toContain('value="forget"');
    });

    test("does not offer delete-my-data without a hash", async () => {
      const html = await expectHtmlResponse(await getUnsubscribe(), 200);
      expect(html).not.toContain('value="forget"');
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
    test("unsubscribes the hash", async () => {
      const hash = await hashEmail("leaver@example.com");
      const response = await postUnsubscribe({
        action: "unsubscribe",
        email: hash,
      });
      expectRedirect(response, "/unsubscribe");
      expect(await isHashUnsubscribed(hash)).toBe(true);
    });

    test("resubscribes the hash", async () => {
      const hash = await hashEmail("returner@example.com");
      await unsubscribeHash(hash);
      const response = await postUnsubscribe({
        action: "resubscribe",
        email: hash,
      });
      expectRedirect(response, "/unsubscribe");
      expect(await isHashUnsubscribed(hash)).toBe(false);
    });

    test("confirms unsubscribing with an info flash", async () => {
      const hash = await hashEmail("confirm@example.com");
      const response = await postUnsubscribe({
        action: "unsubscribe",
        email: hash,
      });
      const followed = await followRedirectWithFlash(response, handleRequest);
      const html = await expectHtmlResponse(
        followed,
        200,
        "You've unsubscribed",
      );
      expect(html).toContain('class="info"');
      expect(html).not.toContain('class="success"');
    });

    test("confirms resubscribing with a success flash", async () => {
      const hash = await hashEmail("welcomeback@example.com");
      await unsubscribeHash(hash);
      const response = await postUnsubscribe({
        action: "resubscribe",
        email: hash,
      });
      const followed = await followRedirectWithFlash(response, handleRequest);
      const html = await expectHtmlResponse(
        followed,
        200,
        "You've resubscribed",
      );
      expect(html).toContain('class="success"');
      expect(html).not.toContain('class="info"');
    });

    test("forgets (deletes) the contact's row", async () => {
      const hash = await hashEmail("forgetme@example.com");
      // Seed a row so there is something to erase.
      await recordVisit(hash);
      expect(await getVisits(hash)).toBe(1);

      const response = await postUnsubscribe({ action: "forget", email: hash });
      expectRedirect(response, "/unsubscribe");

      // The row is gone entirely (not just suppressed).
      const row = await queryOne<{ contact_hash: string }>(
        "SELECT contact_hash FROM contact_preferences WHERE contact_hash = ?",
        [hash],
      );
      expect(row).toBeNull();
      expect(await getVisits(hash)).toBe(0);
    });

    test("confirms deletion with a success flash on the bare page", async () => {
      const hash = await hashEmail("erased@example.com");
      await recordVisit(hash);
      const response = await postUnsubscribe({ action: "forget", email: hash });
      const followed = await followRedirectWithFlash(response, handleRequest);
      const html = await expectHtmlResponse(
        followed,
        200,
        "Your contact record has been deleted",
      );
      expect(html).toContain('class="success"');
    });

    test("redirects with an error when the hash is missing", async () => {
      const response = await postUnsubscribe({ action: "unsubscribe" });
      expectRedirect(response, "/unsubscribe");
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
