import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL, settings } from "#shared/db/settings.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { getSmsGatewayConfig } from "#shared/sms/gateway.ts";
import {
  adminFormPost,
  describeWithEnv,
  expectFlash,
  testRequiresAuth,
} from "#test-utils";

const post = (data: Record<string, string>) =>
  adminFormPost("/admin/settings/sms-gateway", data);

describeWithEnv("server (admin settings: sms gateway)", { db: true }, () => {
  describe("POST /admin/settings/sms-gateway", () => {
    testRequiresAuth("/admin/settings/sms-gateway", {
      body: { sms_gateway_username: "u" },
      method: "POST",
    });

    test("saves credentials, passphrase and base URL", async () => {
      const { response } = await post({
        sms_gateway_base_url: "https://sms.example.com",
        sms_gateway_passphrase: "long-enough-passphrase",
        sms_gateway_password: "pw",
        sms_gateway_username: "user",
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
        sms_gateway_passphrase: "a".repeat(SMS_PASSPHRASE_MIN_LENGTH - 1),
        sms_gateway_password: "pw",
        sms_gateway_username: "user",
      });

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("at least"), false);
      // Nothing persisted on a validation failure
      expect(settings.smsGatewayUsername).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });

    test("accepts a passphrase exactly at the minimum length", async () => {
      const { response } = await post({
        sms_gateway_passphrase: "a".repeat(SMS_PASSPHRASE_MIN_LENGTH),
        sms_gateway_password: "pw",
        sms_gateway_username: "user",
      });

      expect(response.status).toBe(302);
      expect(getSmsGatewayConfig()!.passphrase).toBe(
        "a".repeat(SMS_PASSPHRASE_MIN_LENGTH),
      );
    });

    test("masked secrets leave the stored values unchanged", async () => {
      await post({
        sms_gateway_passphrase: "first-passphrase",
        sms_gateway_password: "pw1",
        sms_gateway_username: "user",
      });

      await post({
        sms_gateway_passphrase: MASK_SENTINEL,
        sms_gateway_password: MASK_SENTINEL,
        sms_gateway_username: "renamed",
      });

      const cfg = getSmsGatewayConfig();
      expect(cfg!.username).toBe("renamed");
      expect(cfg!.password).toBe("pw1");
      expect(cfg!.passphrase).toBe("first-passphrase");
    });

    test("empty secrets clear the stored values", async () => {
      await post({
        sms_gateway_passphrase: "first-passphrase",
        sms_gateway_password: "pw1",
        sms_gateway_username: "user",
      });

      await post({
        sms_gateway_passphrase: "",
        sms_gateway_password: "",
        sms_gateway_username: "user",
      });

      // Cleared password/passphrase → no longer fully configured
      expect(getSmsGatewayConfig()).toBeNull();
      expect(settings.smsGatewayPassword).toBe("");
      expect(settings.smsGatewayPassphrase).toBe("");
    });

    test("rejects an invalid server URL", async () => {
      const { response } = await post({
        sms_gateway_base_url: "not a url",
        sms_gateway_username: "user",
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
        sms_gateway_base_url: "http://sms.example.com",
        sms_gateway_username: "user",
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
          sms_gateway_base_url: url,
          sms_gateway_username: "user",
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
