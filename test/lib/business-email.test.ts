import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  isValidEmail,
  normalizeEmail,
  updateBusinessEmail,
} from "#shared/validation/email.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("business-email", { db: true }, () => {
  describe("isValidEmail", () => {
    test("accepts valid email", () => {
      expect(isValidEmail("test@example.com")).toBe(true);
    });

    test("accepts email with subdomain", () => {
      expect(isValidEmail("contact@mail.example.com")).toBe(true);
    });

    test("accepts email with plus sign", () => {
      expect(isValidEmail("user+tag@example.com")).toBe(true);
    });

    test("accepts email with numbers", () => {
      expect(isValidEmail("user123@example456.com")).toBe(true);
    });

    test("accepts email with hyphens in domain", () => {
      expect(isValidEmail("user@my-domain.com")).toBe(true);
    });

    test("accepts email with uppercase letters", () => {
      expect(isValidEmail("User@Example.Com")).toBe(true);
    });

    test("accepts email with dots in local part", () => {
      expect(isValidEmail("first.last@example.com")).toBe(true);
    });

    test("rejects email without @", () => {
      expect(isValidEmail("notanemail")).toBe(false);
    });

    test("rejects email without domain", () => {
      expect(isValidEmail("test@")).toBe(false);
    });

    test("rejects email without local part", () => {
      expect(isValidEmail("@example.com")).toBe(false);
    });

    test("rejects email without TLD", () => {
      expect(isValidEmail("test@example")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidEmail("")).toBe(false);
    });

    test("rejects whitespace only", () => {
      expect(isValidEmail("   ")).toBe(false);
    });

    test("rejects email with spaces", () => {
      expect(isValidEmail("test @example.com")).toBe(false);
    });

    test("rejects email with multiple @", () => {
      expect(isValidEmail("test@@example.com")).toBe(false);
    });

    test("trims whitespace before validation", () => {
      expect(isValidEmail("  test@example.com  ")).toBe(true);
    });
  });

  describe("normalizeEmail", () => {
    test("trims whitespace", () => {
      expect(normalizeEmail("  test@example.com  ")).toBe("test@example.com");
    });

    test("converts to lowercase", () => {
      expect(normalizeEmail("Test@Example.Com")).toBe("test@example.com");
    });

    test("trims and lowercases together", () => {
      expect(normalizeEmail("  USER@EXAMPLE.COM  ")).toBe("user@example.com");
    });

    test("handles already normalized email", () => {
      expect(normalizeEmail("user@example.com")).toBe("user@example.com");
    });
  });

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

    test("throws on email without @", async () => {
      await expect(updateBusinessEmail("notanemail")).rejects.toThrow(
        "Invalid business email format",
      );
    });

    test("throws on email without domain", async () => {
      await expect(updateBusinessEmail("test@")).rejects.toThrow(
        "Invalid business email format",
      );
    });

    test("throws on email without TLD", async () => {
      await expect(updateBusinessEmail("test@example")).rejects.toThrow(
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
