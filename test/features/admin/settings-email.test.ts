/**
 * Branch cover for the email settings routes, beside the story
 * `@story:settings.connecting-an-email-provider`.
 *
 * The story owns the owner's journey: connecting a provider and being told it
 * was kept, a from-address that is not an address, switching provider without
 * retyping the key, disconnecting, and every answer a test send can get back.
 *
 * These own what a browser cannot reach: sends the page offers no way to make,
 * and the anchor each redirect lands on.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end

/** Where each form's redirect lands: the advanced page, anchored to the form
 * that was sent, so the flash appears beside the boxes it is about. */
const SETTINGS_FORM_URL =
  "/admin/settings-advanced?form=settings-email#settings-email";

/** Where a test send lands: its own form's anchor, not the connection form's,
 * so the flash appears beside the button that was pressed. */
const TEST_FORM_URL =
  "/admin/settings-advanced?form=settings-email-test#settings-email-test";

/** A provider connected and somewhere to send to, so a test send really runs.
 * The story owns what the owner is told; these own where they land. */
const readyToSendATest = async (): Promise<void> => {
  const { settings } = await import("#db/settings.ts");
  const { updateBusinessEmail } = await import("#shared/validation/email.ts");
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_test_key");
  await settings.update.email.fromAddress("from@test.com");
  await updateBusinessEmail("owner@test.com");
  settings.invalidateCache();
};

describeWithEnv("server (admin settings: email)", { db: true }, () => {
  describe("POST /admin/settings/email", () => {
    testRequiresAuth("/admin/settings/email", {
      body: {
        email_provider: "resend",
      },
      method: "POST",
    });

    test("rejects a provider the site has never heard of", async () => {
      // The form offers a list of the providers the site supports, so a value
      // outside it is one only a crafted send can carry.
      const { response } = await adminFormPost("/admin/settings/email", {
        email_provider: "invalid-provider",
      });

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Invalid email provider"),
        false,
      )(response);
    });

    test("treats a send with no provider field as turning email off", async () => {
      // The form always carries the field, so this send is one no browser
      // could have made. The story owns choosing "no provider" on the page.
      const { response } = await adminFormPost("/admin/settings/email");

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email provider disabled"),
      )(response);
    });
  });

  describe("POST /admin/settings/email/test", () => {
    test("refuses a test send with no provider configured", async () => {
      // The page offers no test button until a provider is connected, so this
      // send is one no browser could have made either.
      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        SETTINGS_FORM_URL,
        expect.stringContaining("Email not configured"),
        false,
      )(response);
    });
  });

  test("refuses a from-address that is not an address", async () => {
    // The box is an <input type="email">, so a browser blocks this value
    // before the route ever runs. Only a crafted send reaches the check, which
    // is why the story does not claim this journey.
    const { response } = await adminFormPost("/admin/settings/email", {
      email_api_key: "re_test_123",
      email_from_address: "not-an-email",
      email_provider: "resend",
    });

    expectRedirectWithFlash(
      SETTINGS_FORM_URL,
      expect.stringContaining("Invalid from-address format"),
      false,
    )(response);
  });

  describe("where a test send lands", () => {
    // The story reads what the owner is told. Where they land is a URL
    // contract a story cannot see, because the browser follows the redirect
    // before the story reads the page — so a handler sending success to the
    // wrong anchor would drop the owner at the wrong part of a long page and
    // every scenario would still pass.
    test("sends success to the test form's own anchor", async () => {
      await readyToSendATest();
      using _fetch = stubFetch(new Response());

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("Test email sent"),
      )(response);
    });

    test("sends a refusal to the same anchor", async () => {
      await readyToSendATest();
      using _fetch = stubFetch(new Response("Forbidden", { status: 403 }));

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("Test email failed"),
        false,
      )(response);
    });

    test("sends a missing business email there too", async () => {
      const { settings } = await import("#db/settings.ts");
      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("from@test.com");
      settings.invalidateCache();

      const { response } = await adminFormPost("/admin/settings/email/test");

      expectRedirectWithFlash(
        TEST_FORM_URL,
        expect.stringContaining("No business email set"),
        false,
      )(response);
    });
  });

  test("carries the anchors its redirects land on", async () => {
    // Every redirect above targets one of these two ids. Without the anchor
    // the owner is dropped at the top of a long page with a flash about a
    // form they cannot see. The test form only exists once a provider is
    // connected, which is why one is set up here — the story owns the rule
    // that there is no test to send before then.
    const { settings } = await import("#db/settings.ts");
    await settings.update.email.provider("resend");
    settings.invalidateCache();

    const html = await (await adminGet("/admin/settings-advanced")).text();
    expect(html).toContain('id="settings-email"');
    expect(html).toContain('id="settings-email-test"');
  });
});
