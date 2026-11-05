import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { SmsGatewayForm } from "#templates/admin/settings/sms-gateway.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("SmsGatewayForm", () => {
  beforeAll(setupAdminPageTest);

  test("renders the username and server url inputs with their values", () => {
    const html = String(
      SmsGatewayForm({
        ...advancedDefaultState,
        smsGatewayBaseUrl: "https://api.sms-gate.example",
        smsGatewayUsername: "cloud-admin",
      }),
    );

    expectIncludesAll(html, [
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_username" placeholder="Cloud username from the SMS Gateway app" type="text" value="cloud-admin">`,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_base_url" placeholder="https://api.sms-gate.app" type="url" value="https://api.sms-gate.example">`,
      "Phone app username",
      "Server URL (optional)",
    ]);
  });

  test("requires a long enough passphrase for a new encryption key", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    expectIncludesAll(html, [
      "End-to-end key (passphrase)",
      `<input autocomplete="off" minlength="${SMS_PASSPHRASE_MIN_LENGTH}" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_passphrase" placeholder="At least 12 characters" type="password">`,
    ]);
  });

  test("masks every stored secret: passphrase, password, and webhook", () => {
    const html = String(
      SmsGatewayForm({
        ...advancedDefaultState,
        smsGatewayPassphraseConfigured: true,
        smsGatewayPasswordConfigured: true,
        smsGatewayWebhookConfigured: true,
      }),
    );

    expectIncludesAll(html, [
      `<input autocomplete="off" minlength="${SMS_PASSPHRASE_MIN_LENGTH}" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_passphrase" placeholder="At least 12 characters" type="password" value="${MASK_SENTINEL}">`,
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password" value="${MASK_SENTINEL}"`,
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_webhook_secret" placeholder="For delivery reports + replies" type="password" value="${MASK_SENTINEL}"`,
      "Phone app password",
      "Webhook signing secret (optional)",
    ]);
  });

  test("leaves every secret blank when nothing is stored yet", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    assert(!html.includes(MASK_SENTINEL));
    assertStringIncludes(
      html,
      `name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password">`,
    );
  });

  test("posts to the sms gateway route with its guide link", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    expectIncludesAll(html, [
      "<h2>SMS Gateway</h2>",
      'action="/admin/settings/sms-gateway"',
      'id="settings-sms-gateway"',
      "Save SMS Gateway",
      'href="/admin/guide#sms"',
    ]);
  });
});
