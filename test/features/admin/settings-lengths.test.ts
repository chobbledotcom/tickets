import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { settings } from "#db/settings.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("settings length refusals", { db: true }, () => {
  const cases = [
    ["email", "emailApiKey", MAX_INPUT_LENGTH],
    ["email", "emailFromAddress", MAX_INPUT_LENGTH],
    ["sms-gateway", "smsGatewayUsername", MAX_INPUT_LENGTH],
    ["sms-gateway", "smsGatewayBaseUrl", MAX_INPUT_LENGTH],
    ["sms-gateway", "smsGatewayPassword", MAX_INPUT_LENGTH],
    ["sms-gateway", "smsGatewayPassphrase", MAX_INPUT_LENGTH],
    ["sms-gateway", "smsGatewayWebhookSecret", MAX_INPUT_LENGTH],
    ["apple-wallet", "appleWalletTeamId", MAX_INPUT_LENGTH],
    ["apple-wallet", "appleWalletSigningKey", MAX_TEXTAREA_LENGTH],
    ["google-wallet", "googleWalletServiceAccountEmail", MAX_INPUT_LENGTH],
    ["google-wallet", "googleWalletServiceAccountKey", MAX_TEXTAREA_LENGTH],
    ["email-templates/confirmation", "subject", MAX_INPUT_LENGTH],
    ["email-templates/confirmation", "html", MAX_EMAIL_TEMPLATE_LENGTH],
    ["email-templates/confirmation", "text", MAX_EMAIL_TEMPLATE_LENGTH],
    ["embed-hosts", "embedHosts", MAX_INPUT_LENGTH],
    ["business-email", "businessEmail", MAX_INPUT_LENGTH],
    ["terms", "termsAndConditions", MAX_TEXTAREA_LENGTH],
    ["custom-css", "customCss", MAX_TEXTAREA_LENGTH],
    ["address-lookup", "addressLookupApiKey", MAX_INPUT_LENGTH],
  ] as const;

  test("renders each POST limit on its browser control", async () => {
    const main = await adminGet("/admin/settings");
    const advanced = await adminGet("/admin/settings-advanced");
    const html = (await main.text()) + (await advanced.text());
    for (const [, name, limit] of cases) {
      const control = html.match(
        new RegExp(`<(?:input|textarea)\\b[^>]*name="${name}"[^>]*>`),
      );
      assertStringIncludes(control?.[0] ?? "", `maxlength="${limit}"`, name);
    }
  });

  for (const [route, name, limit] of cases) {
    test(`refuses a crafted ${name} past its browser limit`, async () => {
      const { response } = await adminFormPost(`/admin/settings/${route}`, {
        [name]: "x".repeat(limit + 1),
      });
      expectFlash(
        response,
        expect.stringContaining(`${limit} characters or fewer`),
        false,
      );
    });
  }

  for (const [route, name] of [
    ["stripe", "stripeSecretKey"],
    ["square", "squareAccessToken"],
    ["square", "squareLocationId"],
    ["square-webhook", "squareWebhookSignatureKey"],
    ["sumup", "sumupApiKey"],
    ["sumup", "sumupMerchantCode"],
    ["custom-domain", "customDomain"],
    ["host-subdomain", "subdomain"],
    ["listing-column-order", "columnOrder"],
    ["attendee-column-order", "columnOrder"],
  ] as const) {
    test(`refuses oversized ${route} ${name} before external calls`, async () => {
      using fetch = stubFetch(new Error("Unexpected external call"));
      const { response } = await adminFormPost(`/admin/settings/${route}`, {
        [name]: `sk_test_${"x".repeat(MAX_INPUT_LENGTH)}`,
      });
      expectFlash(
        response,
        expect.stringContaining(`${MAX_INPUT_LENGTH} characters or fewer`),
        false,
      );
      expect(fetch.calls).toHaveLength(0);
    });
  }

  test("keeps a masked email key that exceeds the new limit", async () => {
    const oldKey = "x".repeat(MAX_INPUT_LENGTH + 1);
    await settings.update.email.apiKey(oldKey);
    const { response } = await adminFormPost("/admin/settings/email", {
      emailApiKey: MASK_SENTINEL,
      emailProvider: "resend",
    });
    expect(response.status).toBe(302);
    expect(settings.email.apiKey).toBe(oldKey);
  });

  test("accepts an email key exactly at the new limit", async () => {
    const key = "x".repeat(MAX_INPUT_LENGTH);
    await adminFormPost("/admin/settings/email", {
      emailApiKey: key,
      emailProvider: "resend",
    });
    expect(settings.email.apiKey).toBe(key);
  });

  test("refuses an oversized email key before any settings change", async () => {
    const { response } = await adminFormPost("/admin/settings/email", {
      emailApiKey: "x".repeat(251),
      emailProvider: "resend",
    });
    expectRedirectWithFlash(
      "/admin/settings-advanced?form=settings-email#settings-email",
      expect.stringContaining("250"),
      false,
    )(response);
    expect(settings.email.provider).toBe("");
  });
});
