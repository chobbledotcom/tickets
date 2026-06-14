import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  hashEmail,
  isHashUnsubscribed,
  unsubscribeHash,
} from "#shared/db/email-preferences.ts";
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

    test("confirms with a flash message after unsubscribing", async () => {
      const hash = await hashEmail("confirm@example.com");
      const response = await postUnsubscribe({
        action: "unsubscribe",
        email: hash,
      });
      const followed = await followRedirectWithFlash(response, handleRequest);
      await expectHtmlResponse(followed, 200, "You've unsubscribed");
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
