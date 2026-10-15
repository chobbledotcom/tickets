import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { SmsGatewayForm } from "#templates/admin/settings/sms-gateway.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

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

    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_username" placeholder="Cloud username from the SMS Gateway app" type="text" value="cloud-admin">`,
    );
    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_base_url" placeholder="https://api.sms-gate.app" type="url" value="https://api.sms-gate.example">`,
    );
    says(html, "Phone app username");
    says(html, "Server URL (optional)");
  });

  test("requires a long enough passphrase for a new encryption key", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    says(html, "End-to-end key (passphrase)");
    says(
      html,
      `<input autocomplete="off" minlength="${SMS_PASSPHRASE_MIN_LENGTH}" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_passphrase" placeholder="At least 12 characters" type="password">`,
    );
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

    says(
      html,
      `<input autocomplete="off" minlength="${SMS_PASSPHRASE_MIN_LENGTH}" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_passphrase" placeholder="At least 12 characters" type="password" value="${MASK_SENTINEL}">`,
    );
    says(
      html,
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password" value="${MASK_SENTINEL}"`,
    );
    says(
      html,
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_webhook_secret" placeholder="For delivery reports + replies" type="password" value="${MASK_SENTINEL}"`,
    );
    says(html, "Phone app password");
    says(html, "Webhook signing secret (optional)");
  });

  test("leaves every secret blank when nothing is stored yet", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    assert(!html.includes(MASK_SENTINEL));
    says(
      html,
      `name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password">`,
    );
  });

  test("posts to the sms gateway route with its guide link", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    says(html, "<h2>SMS Gateway</h2>");
    says(html, 'action="/admin/settings/sms-gateway"');
    says(html, 'id="settings-sms-gateway"');
    says(html, "Save SMS Gateway");
    says(html, 'href="/admin/guide#sms"');
  });
});
