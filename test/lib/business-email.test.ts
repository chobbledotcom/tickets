import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { createTestDbWithSetup, resetDb } from "#test-utils";
import {
  isValidBusinessEmail,
  normalizeBusinessEmail,
  getBusinessEmailFromDb,
  updateBusinessEmail,
} from "#lib/business-email.ts";

describe("business-email", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
  });

  afterEach(async () => {
    await resetDb();
  });

  describe("isValidBusinessEmail", () => {
    test("accepts valid email", () => {
      expect(isValidBusinessEmail("test@example.com")).toBe(true);
    });

    test("accepts email with subdomain", () => {
      expect(isValidBusinessEmail("contact@mail.example.com")).toBe(true);
    });

    test("accepts email with plus sign", () => {
      expect(isValidBusinessEmail("user+tag@example.com")).toBe(true);
    });

    test("accepts email with numbers", () => {
      expect(isValidBusinessEmail("user123@example456.com")).toBe(true);
    });

    test("accepts email with hyphens in domain", () => {
      expect(isValidBusinessEmail("user@my-domain.com")).toBe(true);
    });

    test("accepts email with uppercase letters", () => {
      expect(isValidBusinessEmail("User@Example.Com")).toBe(true);
    });

    test("accepts email with dots in local part", () => {
      expect(isValidBusinessEmail("first.last@example.com")).toBe(true);
    });

    test("rejects email without @", () => {
      expect(isValidBusinessEmail("notanemail")).toBe(false);
    });

    test("rejects email without domain", () => {
      expect(isValidBusinessEmail("test@")).toBe(false);
    });

    test("rejects email without local part", () => {
      expect(isValidBusinessEmail("@example.com")).toBe(false);
    });

    test("rejects email without TLD", () => {
      expect(isValidBusinessEmail("test@example")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidBusinessEmail("")).toBe(false);
    });

    test("rejects whitespace only", () => {
      expect(isValidBusinessEmail("   ")).toBe(false);
    });

    test("rejects email with spaces", () => {
      expect(isValidBusinessEmail("test @example.com")).toBe(false);
    });

    test("rejects email with multiple @", () => {
      expect(isValidBusinessEmail("test@@example.com")).toBe(false);
    });

    test("trims whitespace before validation", () => {
      expect(isValidBusinessEmail("  test@example.com  ")).toBe(true);
    });
  });

  describe("normalizeBusinessEmail", () => {
    test("trims whitespace", () => {
      expect(normalizeBusinessEmail("  test@example.com  ")).toBe("test@example.com");
    });

    test("converts to lowercase", () => {
      expect(normalizeBusinessEmail("Test@Example.Com")).toBe("test@example.com");
    });

    test("trims and lowercases together", () => {
      expect(normalizeBusinessEmail("  USER@EXAMPLE.COM  ")).toBe("user@example.com");
    });

    test("handles already normalized email", () => {
      expect(normalizeBusinessEmail("user@example.com")).toBe("user@example.com");
    });
  });

  describe("getBusinessEmailFromDb", () => {
    test("returns empty string when no business email is set", async () => {
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("");
    });

    test("returns business email after it is set", async () => {
      await updateBusinessEmail("test@example.com");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("test@example.com");
    });

    test("returns normalized email", async () => {
      await updateBusinessEmail("Test@Example.Com");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("test@example.com");
    });
  });

  describe("updateBusinessEmail", () => {
    test("stores valid email in database", async () => {
      await updateBusinessEmail("contact@example.com");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("contact@example.com");
    });

    test("normalizes email before storing", async () => {
      await updateBusinessEmail("  Contact@Example.Com  ");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("contact@example.com");
    });

    test("updates existing email", async () => {
      await updateBusinessEmail("old@example.com");
      await updateBusinessEmail("new@example.com");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("new@example.com");
    });

    test("clears email when given empty string", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("");
    });

    test("clears email when given whitespace only", async () => {
      await updateBusinessEmail("test@example.com");
      await updateBusinessEmail("   ");
      const result = await getBusinessEmailFromDb();
      expect(result).toBe("");
    });

    test("throws on invalid email format", async () => {
      await expect(updateBusinessEmail("not-an-email")).rejects.toThrow("Invalid business email format");
    });

    test("throws on email without @", async () => {
      await expect(updateBusinessEmail("notanemail")).rejects.toThrow("Invalid business email format");
    });

    test("throws on email without domain", async () => {
      await expect(updateBusinessEmail("test@")).rejects.toThrow("Invalid business email format");
    });

    test("throws on email without TLD", async () => {
      await expect(updateBusinessEmail("test@example")).rejects.toThrow("Invalid business email format");
    });
  });
});
