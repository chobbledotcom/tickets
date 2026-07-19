import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { executeWithoutCacheInvalidation } from "#shared/db/client.ts";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const reloadBusinessEmail = async (): Promise<void> => {
  settings.invalidateCache();
  await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);
};

describeWithEnv("business-email", { db: true }, () => {
  describe("settings.businessEmail", () => {
    test("returns empty string when no business email is set", () => {
      expect(settings.businessEmail).toBe("");
    });

    test("returns business email after it is set", async () => {
      await updateBusinessEmail("test@example.com");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("test@example.com");
    });

    test("returns normalized email", async () => {
      await updateBusinessEmail("Test@Example.Com");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("test@example.com");
    });
  });

  describe("updateBusinessEmail", () => {
    test("stores valid email in database", async () => {
      await updateBusinessEmail("contact@example.com");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("contact@example.com");
    });

    test("normalizes email before storing", async () => {
      await updateBusinessEmail("  Contact@Example.Com  ");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("contact@example.com");
    });

    test("updates existing email", async () => {
      await updateBusinessEmail("old@example.com");
      await updateBusinessEmail("new@example.com");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("new@example.com");
    });

    test("clears email when given empty string", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("");
    });

    test("clears email when given whitespace only", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("   ");
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe("");
    });

    test("throws on invalid email format", async () => {
      await expect(updateBusinessEmail("not-an-email")).rejects.toThrow(
        "Invalid business email format",
      );
    });
  });

  describe("settings cache integration", () => {
    test("uses settings cache for reads", async () => {
      await updateBusinessEmail("cached@example.com");
      await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);
      await executeWithoutCacheInvalidation(
        "UPDATE settings SET value = ? WHERE key = ?",
        [await encrypt("changed@example.com"), CONFIG_KEYS.BUSINESS_EMAIL],
      );
      await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);

      expect(settings.businessEmail).toBe("cached@example.com");
    });

    test("invalidateSettingsCache forces decrypt from database", async () => {
      await updateBusinessEmail("encrypted@example.com");
      await executeWithoutCacheInvalidation(
        "UPDATE settings SET value = ? WHERE key = ?",
        [await encrypt("refreshed@example.com"), CONFIG_KEYS.BUSINESS_EMAIL],
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      expect(settings.businessEmail).toBe("refreshed@example.com");
    });
  });
});
