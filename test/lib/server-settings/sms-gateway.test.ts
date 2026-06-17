import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL, settings } from "#shared/db/settings.ts";
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
        sms_gateway_passphrase: "secret-key",
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
      expect(cfg!.passphrase).toBe("secret-key");
      expect(cfg!.baseUrl).toBe("https://sms.example.com");
    });

    test("masked secrets leave the stored values unchanged", async () => {
      await post({
        sms_gateway_passphrase: "key1",
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
      expect(cfg!.passphrase).toBe("key1");
    });

    test("empty secrets clear the stored values", async () => {
      await post({
        sms_gateway_passphrase: "key1",
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
  });
});
