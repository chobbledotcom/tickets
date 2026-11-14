import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const reloadBusinessEmail = async (): Promise<void> => {
  settings.invalidateCache();
  await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);
};

/** One round trip: the addresses written in order, and the value the setting
 *  must read back once the writes have run. */
type EmailRoundTrip = {
  title: string;
  writes: readonly string[];
  expected: string;
};

const readCases: readonly EmailRoundTrip[] = [
  {
    expected: "test@example.com",
    title: "returns business email after it is set",
    writes: ["test@example.com"],
  },
  {
    expected: "test@example.com",
    title: "returns normalized email",
    writes: ["Test@Example.Com"],
  },
];

const writeCases: readonly EmailRoundTrip[] = [
  {
    expected: "contact@example.com",
    title: "stores valid email in database",
    writes: ["contact@example.com"],
  },
  {
    expected: "contact@example.com",
    title: "normalizes email before storing",
    writes: ["  Contact@Example.Com  "],
  },
  {
    expected: "new@example.com",
    title: "updates existing email",
    writes: ["old@example.com", "new@example.com"],
  },
  {
    expected: "",
    title: "clears email when given empty string",
    writes: ["test@example.com", ""],
  },
  {
    expected: "",
    title: "clears email when given whitespace only",
    writes: ["test@example.com", "   "],
  },
];

/** Register one test per case: write its addresses, reload the setting from
 *  the DB, and assert what it reads back. */
const registerEmailRoundTrips = (cases: readonly EmailRoundTrip[]): void => {
  for (const { title, writes, expected } of cases) {
    test(title, async () => {
      for (const value of writes) await updateBusinessEmail(value);
      await reloadBusinessEmail();
      expect(settings.businessEmail).toBe(expected);
    });
  }
};

describeWithEnv("business-email", { db: true }, () => {
  describe("settings.businessEmail", () => {
    test("returns empty string when no business email is set", () => {
      expect(settings.businessEmail).toBe("");
    });

    registerEmailRoundTrips(readCases);
  });

  describe("updateBusinessEmail", () => {
    registerEmailRoundTrips(writeCases);

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
        sql`UPDATE settings SET value = ${await encrypt(
          "changed@example.com",
        )} WHERE key = ${CONFIG_KEYS.BUSINESS_EMAIL}`,
      );
      await settings.loadKeys([CONFIG_KEYS.BUSINESS_EMAIL]);

      expect(settings.businessEmail).toBe("cached@example.com");
    });

    test("invalidateSettingsCache forces decrypt from database", async () => {
      await updateBusinessEmail("encrypted@example.com");
      await executeWithoutCacheInvalidation(
        sql`UPDATE settings SET value = ${await encrypt(
          "refreshed@example.com",
        )} WHERE key = ${CONFIG_KEYS.BUSINESS_EMAIL}`,
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      expect(settings.businessEmail).toBe("refreshed@example.com");
    });
  });
});
