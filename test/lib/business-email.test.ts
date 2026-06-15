import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("business-email", { db: true }, () => {
  describe("settings.businessEmail", () => {
    test("returns empty string when no business email is set", () => {
      const result = settings.businessEmail ?? "";
      expect(result).toBe("");
    });

    test("returns business email after it is set", async () => {
      await updateBusinessEmail("test@example.com");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("test@example.com");
    });

    test("returns normalized email", async () => {
      await updateBusinessEmail("Test@Example.Com");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("test@example.com");
    });
  });

  describe("updateBusinessEmail", () => {
    test("stores valid email in database", async () => {
      await updateBusinessEmail("contact@example.com");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("contact@example.com");
    });

    test("normalizes email before storing", async () => {
      await updateBusinessEmail("  Contact@Example.Com  ");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("contact@example.com");
    });

    test("updates existing email", async () => {
      await updateBusinessEmail("old@example.com");
      await updateBusinessEmail("new@example.com");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("new@example.com");
    });

    test("clears email when given empty string", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("");
    });

    test("clears email when given whitespace only", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("   ");
      const result = settings.businessEmail ?? "";
      expect(result).toBe("");
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
      const first = settings.businessEmail ?? "";
      expect(first).toBe("cached@example.com");

      // Second read should use cache
      const second = settings.businessEmail ?? "";
      expect(second).toBe("cached@example.com");
    });

    test("invalidateSettingsCache forces decrypt from database", async () => {
      await updateBusinessEmail("encrypted@example.com");
      settings.invalidateCache();
      await settings.loadAll();

      const result = settings.businessEmail ?? "";
      expect(result).toBe("encrypted@example.com");
    });
  });
});
