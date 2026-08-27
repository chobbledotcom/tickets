import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import { hostEmail } from "#shared/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";

describeWithEnv("public ticket routes", { db: true }, () => {
  afterEach(() => {
    hostEmail.resetOverride();
  });

  describe("getFromEmailIfConfigured", () => {
    test("gives an empty string when nothing is configured", async () => {
      hostEmail.setOverride(null);
      expect(await getFromEmailIfConfigured()).toBe("");
    });

    test("falls back to the host's from-address", async () => {
      hostEmail.setOverride({
        apiKey: "key",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
      expect(await getFromEmailIfConfigured()).toBe("host@example.com");
    });

    test("prefers the site's own from-address over the host's", async () => {
      hostEmail.setOverride({
        apiKey: "key",
        fromAddress: validEmail("host@example.com"),
        provider: "resend",
      });
      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_test_key");
      await settings.update.email.fromAddress("site@example.com");
      expect(await getFromEmailIfConfigured()).toBe("site@example.com");
    });
  });
});
