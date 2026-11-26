import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { settings } from "#db/settings.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { getSmsGatewayConfig } from "#shared/sms/gateway.ts";
import { expectFlash, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

const post = (data: Record<string, string>) =>
  adminFormPost("/admin/settings/sms-gateway", data);

describeWithEnv("server (admin settings: sms gateway)", { db: true }, () => {
  describe("POST /admin/settings/sms-gateway", () => {
    testRequiresAuth("/admin/settings/sms-gateway", {
      body: { smsGatewayUsername: "u" },
      method: "POST",
    });

    test("saves credentials, passphrase and base URL", async () => {
      const { response } = await post({
        smsGatewayBaseUrl: "https://sms.example.com",
        smsGatewayPassphrase: "long-enough-passphrase",
        smsGatewayPassword: "pw",
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("SMS gateway settings updated"),
      );

      const cfg = getSmsGatewayConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.username).toBe("user");
      expect(cfg!.password).toBe("pw");
      expect(cfg!.passphrase).toBe("long-enough-passphrase");
      expect(cfg!.baseUrl).toBe("https://sms.example.com");
    });

    test("rejects a passphrase shorter than the minimum length", async () => {
      const { response } = await post({
        smsGatewayPassphrase: "a".repeat(SMS_PASSPHRASE_MIN_LENGTH - 1),
        smsGatewayPassword: "pw",
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("at least"), false);
      // Nothing persisted on a validation failure
      expect(settings.smsGatewayUsername).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });

    test("rejects any field past the input length", async () => {
      // The browser maxlength on each control is skipped by a crafted POST,
      // so the server carries the cap for every single-line value, including
      // newly chosen secrets (these choose a secret, they never re-enter one
      // an older site stored). The URL stays structurally valid so the
      // length refusal, not the format refusal, is what answers.
      const { response } = await post({
        // 251 characters in all: the 24-character start pushes it over.
        smsGatewayBaseUrl: `https://sms.example.com/${"u".repeat(227)}`,
        smsGatewayPassphrase: "p".repeat(251),
        smsGatewayPassword: "w".repeat(251),
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        "Server URL must be 250 characters or fewer",
        false,
      );
      expect(settings.smsGatewayUsername).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });

    test("rejects a newly chosen secret past the input length", async () => {
      const { response } = await post({
        smsGatewayBaseUrl: "https://sms.example.com",
        smsGatewayUsername: "user",
        smsGatewayWebhookSecret: "s".repeat(251),
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        "Webhook signing secret must be 250 characters or fewer",
        false,
      );
      expect(settings.smsGatewayUsername).toBe("");
      expect(settings.smsGatewayWebhookSecret).toBe("");
    });

    test("accepts a passphrase exactly at the minimum length", async () => {
      const { response } = await post({
        smsGatewayPassphrase: "a".repeat(SMS_PASSPHRASE_MIN_LENGTH),
        smsGatewayPassword: "pw",
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expect(getSmsGatewayConfig()!.passphrase).toBe(
        "a".repeat(SMS_PASSPHRASE_MIN_LENGTH),
      );
    });

    test("masked secrets leave the stored values unchanged", async () => {
      await post({
        smsGatewayPassphrase: "first-passphrase",
        smsGatewayPassword: "pw1",
        smsGatewayUsername: "user",
      });

      await post({
        smsGatewayPassphrase: MASK_SENTINEL,
        smsGatewayPassword: MASK_SENTINEL,
        smsGatewayUsername: "renamed",
      });

      const cfg = getSmsGatewayConfig();
      expect(cfg!.username).toBe("renamed");
      expect(cfg!.password).toBe("pw1");
      expect(cfg!.passphrase).toBe("first-passphrase");
    });

    test("empty secrets clear the stored values", async () => {
      await post({
        smsGatewayPassphrase: "first-passphrase",
        smsGatewayPassword: "pw1",
        smsGatewayUsername: "user",
      });

      await post({
        smsGatewayPassphrase: "",
        smsGatewayPassword: "",
        smsGatewayUsername: "user",
      });

      // Cleared password/passphrase → no longer fully configured
      expect(getSmsGatewayConfig()).toBeNull();
      expect(settings.smsGatewayPassword).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });

    test("rejects an invalid server URL", async () => {
      const { response } = await post({
        smsGatewayBaseUrl: "not a url",
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid server URL"),
        false,
      );
      // Nothing persisted on a validation failure
      expect(settings.smsGatewayUsername).toBe("");
    });

    test("rejects a plaintext http URL", async () => {
      const { response } = await post({
        smsGatewayBaseUrl: "http://sms.example.com",
        smsGatewayUsername: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid server URL"),
        false,
      );
    });

    test("rejects localhost, internal hosts and IP addresses", async () => {
      for (const url of [
        "https://localhost",
        "https://api.localhost",
        "https://example.local",
        "https://1.1.1.1",
        "https://[::1]/",
        "https://[::ffff:10.0.0.1]/",
      ]) {
        const { response } = await post({
          smsGatewayBaseUrl: url,
          smsGatewayUsername: "user",
        });

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid server URL"),
          false,
        );
      }
    });
  });
});
