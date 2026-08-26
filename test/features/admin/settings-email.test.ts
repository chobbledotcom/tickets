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
import { adminFormPost, adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end

/** Where each form's redirect lands: the advanced page, anchored to the form
 * that was sent, so the flash appears beside the boxes it is about. */
const SETTINGS_FORM_URL =
  "/admin/settings-advanced?form=settings-email#settings-email";

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
