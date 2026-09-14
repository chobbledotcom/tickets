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
    ["email", "email_api_key", MAX_INPUT_LENGTH],
    ["email", "email_from_address", MAX_INPUT_LENGTH],
    ["sms-gateway", "sms_gateway_username", MAX_INPUT_LENGTH],
    ["sms-gateway", "sms_gateway_base_url", MAX_INPUT_LENGTH],
    ["sms-gateway", "sms_gateway_password", MAX_INPUT_LENGTH],
    ["sms-gateway", "sms_gateway_passphrase", MAX_INPUT_LENGTH],
    ["sms-gateway", "sms_gateway_webhook_secret", MAX_INPUT_LENGTH],
    ["apple-wallet", "apple_wallet_team_id", MAX_INPUT_LENGTH],
    ["apple-wallet", "apple_wallet_signing_key", MAX_TEXTAREA_LENGTH],
    ["google-wallet", "google_wallet_service_account_email", MAX_INPUT_LENGTH],
    ["google-wallet", "google_wallet_service_account_key", MAX_TEXTAREA_LENGTH],
    ["email-templates/confirmation", "subject", MAX_INPUT_LENGTH],
    ["email-templates/confirmation", "html", MAX_EMAIL_TEMPLATE_LENGTH],
    ["email-templates/confirmation", "text", MAX_EMAIL_TEMPLATE_LENGTH],
    ["embed-hosts", "embed_hosts", MAX_INPUT_LENGTH],
    ["business-email", "business_email", MAX_INPUT_LENGTH],
    ["terms", "terms_and_conditions", MAX_TEXTAREA_LENGTH],
    ["custom-css", "custom_css", MAX_TEXTAREA_LENGTH],
    ["address-lookup", "address_lookup_api_key", MAX_INPUT_LENGTH],
  ] as const;

  test("renders each POST limit on its browser control", async () => {
    const main = await adminGet("/admin/settings");
    const advanced = await adminGet("/admin/settings-advanced");
    const html = (await main.text()) + (await advanced.text());
    for (const [, name, limit] of cases) {
      const control = html.match(
        new RegExp(`<(?:input|textarea)\\b[^>]*name="${name}"[^>]*>`),
      );
      expect(control?.[0], name).toContain(`maxlength="${limit}"`);
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
    ["stripe", "stripe_secret_key"],
    ["square", "square_access_token"],
    ["square", "square_location_id"],
    ["square-webhook", "square_webhook_signature_key"],
    ["sumup", "sumup_api_key"],
    ["sumup", "sumup_merchant_code"],
    ["custom-domain", "custom_domain"],
    ["host-subdomain", "subdomain"],
    ["listing-column-order", "column_order"],
    ["attendee-column-order", "column_order"],
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
      email_api_key: MASK_SENTINEL,
      email_provider: "resend",
    });
    expect(response.status).toBe(302);
    expect(settings.email.apiKey).toBe(oldKey);
  });

  test("accepts an email key exactly at the new limit", async () => {
    const key = "x".repeat(MAX_INPUT_LENGTH);
    await adminFormPost("/admin/settings/email", {
      email_api_key: key,
      email_provider: "resend",
    });
    expect(settings.email.apiKey).toBe(key);
  });

  test("refuses an oversized email key before any settings change", async () => {
    const { response } = await adminFormPost("/admin/settings/email", {
      email_api_key: "x".repeat(251),
      email_provider: "resend",
    });
    expectRedirectWithFlash(
      "/admin/settings-advanced?form=settings-email#settings-email",
      expect.stringContaining("250"),
      false,
    )(response);
    expect(settings.email.provider).toBe("");
  });
});
