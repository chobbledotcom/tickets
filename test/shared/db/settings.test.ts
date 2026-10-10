import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { WrappedKey } from "#crypto/sealed.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#db/users.ts";
import { DEFAULT_ORPHAN_RETENTION } from "#shared/orphan-retention.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

describeWithEnv("db > settings", { db: true }, () => {
  describe("generated string accessors", () => {
    test("read and write registry-backed plaintext and encrypted settings", async () => {
      await settings.update.customCss("body { color: red; }");
      await settings.update.businessEmail("owner@example.com");
      settings.invalidateCache();

      await settings.loadKeys([
        CONFIG_KEYS.CUSTOM_CSS,
        CONFIG_KEYS.BUSINESS_EMAIL,
      ]);

      expect(settings.customCss).toBe("body { color: red; }");
      expect(settings.businessEmail).toBe("owner@example.com");
      expect(settings.getCachedRaw(CONFIG_KEYS.CUSTOM_CSS)).toBe(
        "body { color: red; }",
      );
      expect(settings.getCachedRaw(CONFIG_KEYS.BUSINESS_EMAIL)).toMatch(
        /^enc:1:/,
      );
    });

    test("keeps read-only registry settings out of the update API", () => {
      expect("publicKey" in settings.update).toBe(false);
      expect("wrappedPrivateKey" in settings.update).toBe(false);
    });
  });

  describe("additional settings", () => {
    test("loadKeys sets theme to dark when stored value is dark", async () => {
      await settings.setRaw(CONFIG_KEYS.THEME, "dark");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.THEME]);
      expect(settings.theme).toBe("dark");
    });

    test("loadKeys sets underlineLinks true when stored value is true", async () => {
      await settings.setRaw(CONFIG_KEYS.UNDERLINE_LINKS, "true");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.UNDERLINE_LINKS]);
      expect(settings.underlineLinks).toBe(true);
    });

    test("loadKeys leaves underlineLinks false when stored value is not true", async () => {
      await settings.setRaw(CONFIG_KEYS.UNDERLINE_LINKS, "false");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.UNDERLINE_LINKS]);
      expect(settings.underlineLinks).toBe(false);
    });

    test("update.bookingFee with empty string resets to 0", async () => {
      await settings.update.bookingFee("500");
      expect(settings.bookingFee).toBe("500");
      await settings.update.bookingFee("");
      expect(settings.bookingFee).toBe("0");
    });

    test("updateUserPassword returns false when dataKey unwrap fails", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const passwordHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(passwordHash).toBeTruthy();

      const { settings: s } = await import("#db/settings.ts");
      const result = await s.updateUserPassword(user!.id, {
        newPassword: "newpassword",
        oldKekVersion: user!.kek_version,
        oldPassword: TEST_ADMIN_PASSWORD,
        oldPasswordHash: passwordHash!,
        // Hand-crafted corrupt stored wrap — test fixture cast.
        oldWrappedDataKey: "corrupted_wrapped_data_key" as WrappedKey,
      });
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Superuser choice settings DB extension
  // ---------------------------------------------------------------------------

  describe("superuser_choice schema and key registration", () => {
    test("CONFIG_KEYS.SUPERUSER_CHOICE exists with value 'superuser_choice'", () => {
      expect(CONFIG_KEYS.SUPERUSER_CHOICE).toBe("superuser_choice");
    });

    test("superuser_choice is listed in PLAINTEXT_KEYS", async () => {
      // Write it and check it comes back without encryption prefix
      await settings.update.superuserChoice("self-managed");
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      const raw = settings.getCachedRaw("superuser_choice");
      expect(raw).toBe("self-managed");
    });

    test("superuser_choice is NOT in ENCRYPTED_KEYS", async () => {
      await settings.update.superuserChoice("enabled");
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      const raw = settings.getCachedRaw("superuser_choice");
      expect(raw).not.toMatch(/^enc:1:/);
    });
  });

  describe("superuserChoice getter behavior", () => {
    test("settings.superuserChoice returns '' from a fresh database", () => {
      settings.invalidateCache();
      expect(settings.superuserChoice).toBe("");
    });

    test("settings.superuserChoice returns 'self-managed' after writing", async () => {
      await settings.update.superuserChoice("self-managed");
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("settings.superuserChoice returns 'enabled' after writing", async () => {
      await settings.update.superuserChoice("enabled");
      expect(settings.superuserChoice).toBe("enabled");
    });

    test("settings.superuserChoice getter is consistent across multiple reads", async () => {
      await settings.update.superuserChoice("self-managed");
      const read1 = settings.superuserChoice;
      const read2 = settings.superuserChoice;
      expect(read1).toBe("self-managed");
      expect(read2).toBe("self-managed");
    });

    test("settings.superuserChoice returns '' when stored value is invalid", async () => {
      await settings.setRaw(CONFIG_KEYS.SUPERUSER_CHOICE, "invalid");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);

      expect(settings.superuserChoice).toBe("");
    });
  });

  describe("superuserChoice writer behavior", () => {
    test("settings.update.superuserChoice persists across a round-trip", async () => {
      await settings.update.superuserChoice("enabled");
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.SUPERUSER_CHOICE]);
      expect(settings.superuserChoice).toBe("enabled");
    });

    test("writing the same value twice is idempotent", async () => {
      await settings.update.superuserChoice("self-managed");
      await settings.update.superuserChoice("self-managed");
      expect(settings.superuserChoice).toBe("self-managed");
    });

    test("writing '' (empty string) resets the choice", async () => {
      await settings.update.superuserChoice("enabled");
      await settings.update.superuserChoice("");
      expect(settings.superuserChoice).toBe("");
    });
  });

  describe("superuserChoice test override support", () => {
    test("setForTest can override superuser_choice to 'self-managed'", () => {
      settings.setForTest({ superuser_choice: "self-managed" });
      expect(settings.superuserChoice).toBe("self-managed");
      settings.clearTestOverride("superuser_choice");
    });

    test("setForTest can override superuser_choice to 'enabled'", () => {
      settings.setForTest({ superuser_choice: "enabled" });
      expect(settings.superuserChoice).toBe("enabled");
      settings.clearTestOverride("superuser_choice");
    });

    test("setForTest override for superuser_choice does not interfere with other settings", () => {
      settings.setForTest({ country: "US", superuser_choice: "self-managed" });
      expect(settings.superuserChoice).toBe("self-managed");
      expect(settings.country).toBe("US");
      settings.clearTestOverride("superuser_choice", "country");
    });

    test("setForTest with empty superuser_choice resets it", async () => {
      await settings.update.superuserChoice("enabled");
      settings.setForTest({ superuser_choice: "" });
      expect(settings.superuserChoice).toBe("");
      settings.clearTestOverride("superuser_choice");
    });
  });

  describe("orphan-purge settings", () => {
    const loadOrphanKeys = () =>
      settings.loadKeys([
        CONFIG_KEYS.AUTO_PURGE_ORPHANS,
        CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
      ]);

    test("autoPurgeOrphans defaults to on for a fresh database", async () => {
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(true);
    });

    test("autoPurgeOrphans reads an explicit 'false'", async () => {
      await settings.setRaw(CONFIG_KEYS.AUTO_PURGE_ORPHANS, "false");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(false);
    });

    test("autoPurgeOrphans reads an explicit 'true'", async () => {
      await settings.setRaw(CONFIG_KEYS.AUTO_PURGE_ORPHANS, "true");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(true);
    });

    test("update.autoPurgeOrphans persists across a round-trip", async () => {
      await settings.update.autoPurgeOrphans(false);
      expect(settings.autoPurgeOrphans).toBe(false);
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.autoPurgeOrphans).toBe(false);
    });

    test("orphanPurgeRetention defaults to 6 months (182 days)", async () => {
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe(DEFAULT_ORPHAN_RETENTION);
    });

    test("orphanPurgeRetention keeps a valid stored age", async () => {
      await settings.setRaw(CONFIG_KEYS.ORPHAN_PURGE_RETENTION, "365");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe("365");
    });

    test("orphanPurgeRetention coerces an invalid stored age to the default", async () => {
      await settings.setRaw(CONFIG_KEYS.ORPHAN_PURGE_RETENTION, "not-an-age");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe(DEFAULT_ORPHAN_RETENTION);
    });

    test("update.orphanPurgeRetention persists across a round-trip", async () => {
      await settings.update.orphanPurgeRetention("730");
      expect(settings.orphanPurgeRetention).toBe("730");
      settings.invalidateCache();
      await loadOrphanKeys();
      expect(settings.orphanPurgeRetention).toBe("730");
    });
  });
});
