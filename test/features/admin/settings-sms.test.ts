/**
 * The SMS gateway settings route directly: the passphrase minimum, the
 * central single-line limit, and what a save keeps.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleSmsGatewayPost } from "#routes/admin/settings-sms.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import {
  expectFlash,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

const PATH = "/admin/settings/sms-gateway";
const FLASH_TARGET =
  "/admin/settings-advanced?form=settings-sms-gateway#settings-sms-gateway";

const post = async (data: Record<string, string>): Promise<Response> =>
  await handleSmsGatewayPost(
    mockFormRequest(
      PATH,
      { ...data, csrf_token: await testCsrfToken() },
      await testCookie(),
    ),
  );

describeWithEnv("settings (sms gateway form)", { db: true }, () => {
  test(`saves a username of exactly ${MAX_INPUT_LENGTH} characters`, async () => {
    const username = "u".repeat(MAX_INPUT_LENGTH);
    const response = await post({
      sms_gateway_passphrase: "p".repeat(SMS_PASSPHRASE_MIN_LENGTH),
      sms_gateway_username: username,
    });

    expectRedirectWithFlash(
      FLASH_TARGET,
      "SMS gateway settings updated",
    )(response);
    expect(settings.smsGatewayUsername).toBe(username);
    expect(settings.smsGatewayPassphrase).toBe(
      "p".repeat(SMS_PASSPHRASE_MIN_LENGTH),
    );
  });

  test(`refuses a passphrase below ${SMS_PASSPHRASE_MIN_LENGTH} and saves nothing`, async () => {
    const response = await post({
      sms_gateway_passphrase: "p".repeat(SMS_PASSPHRASE_MIN_LENGTH - 1),
      sms_gateway_username: "user",
    });

    expect(response.status).toBe(302);
    expectFlash(
      response,
      `End-to-end passphrase must be at least ${SMS_PASSPHRASE_MIN_LENGTH} characters`,
      false,
    );
    expect(settings.smsGatewayUsername).toBe("");
    expect(settings.smsGatewayPassphrase).toBe("");
  });

  for (const [field, label] of [
    ["sms_gateway_username", "Phone app username"],
    ["sms_gateway_password", "Phone app password"],
    ["sms_gateway_webhook_secret", "Webhook signing secret (optional)"],
  ] as const) {
    test(`refuses an over-long ${field} before the save`, async () => {
      const response = await post({
        [field]: "x".repeat(MAX_INPUT_LENGTH + 1),
        sms_gateway_passphrase: "p".repeat(SMS_PASSPHRASE_MIN_LENGTH),
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        `${label} must be ${MAX_INPUT_LENGTH} characters or fewer`,
        false,
      );
      expect(settings.smsGatewayUsername).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });
  }
});
