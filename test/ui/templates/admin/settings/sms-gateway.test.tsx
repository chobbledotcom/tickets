import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { SmsGatewayForm } from "#templates/admin/settings/sms-gateway.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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

    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_username" placeholder="Cloud username from the SMS Gateway app" type="text" value="cloud-admin">`,
    );
    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_base_url" placeholder="https://api.sms-gate.app" type="url" value="https://api.sms-gate.example">`,
    );
    expect(html).toContain("Phone app username");
    expect(html).toContain("Server URL (optional)");
  });

  test("requires a long enough passphrase for a new encryption key", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    expect(html).toContain("End-to-end key (passphrase)");
    expect(html).toContain(
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

    expect(html).toContain(
      `<input autocomplete="off" minlength="${SMS_PASSPHRASE_MIN_LENGTH}" maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_passphrase" placeholder="At least 12 characters" type="password" value="${MASK_SENTINEL}">`,
    );
    expect(html).toContain(
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password" value="${MASK_SENTINEL}"`,
    );
    expect(html).toContain(
      `maxlength="${MAX_INPUT_LENGTH}" name="sms_gateway_webhook_secret" placeholder="For delivery reports + replies" type="password" value="${MASK_SENTINEL}"`,
    );
    expect(html).toContain("Phone app password");
    expect(html).toContain("Webhook signing secret (optional)");
  });

  test("leaves every secret blank when nothing is stored yet", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    expect(html).not.toContain(MASK_SENTINEL);
    expect(html).toContain(
      `name="sms_gateway_password" placeholder="Cloud password from the SMS Gateway app" type="password">`,
    );
  });

  test("posts to the sms gateway route with its guide link", () => {
    const html = String(SmsGatewayForm(advancedDefaultState));

    expect(html).toContain("<h2>SMS Gateway</h2>");
    expect(html).toContain('action="/admin/settings/sms-gateway"');
    expect(html).toContain('id="settings-sms-gateway"');
    expect(html).toContain("Save SMS Gateway");
    expect(html).toContain('href="/admin/guide#sms"');
  });
});
