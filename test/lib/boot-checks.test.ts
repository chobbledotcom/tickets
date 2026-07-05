import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  BOOT_CHECKS,
  validateBootChecks,
  validateOptionalMainInstanceKey,
} from "#shared/boot-checks.ts";
import {
  clearTestEncryptionKey,
  describeWithEnv,
  setTestEnv,
} from "#test-utils";

describeWithEnv("boot checks", { encryptionKey: true }, () => {
  test("lists the global checks run before serving requests", () => {
    expect(BOOT_CHECKS.map((check) => check.name)).toEqual([
      "DB_ENCRYPTION_KEY",
      "MAIN_INSTANCE_KEY",
    ]);
  });

  test("allows MAIN_INSTANCE_KEY to be absent", () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: undefined });
    try {
      expect(() => validateOptionalMainInstanceKey()).not.toThrow();
    } finally {
      restore();
    }
  });

  test("allows a high-entropy MAIN_INSTANCE_KEY", () => {
    const restore = setTestEnv({
      MAIN_INSTANCE_KEY: "instance-key-0123456789abcdef0123456789abcdef",
    });
    try {
      expect(() => validateOptionalMainInstanceKey()).not.toThrow();
    } finally {
      restore();
    }
  });

  test("fails fast when MAIN_INSTANCE_KEY is blank", () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: "   " });
    try {
      expect(() => validateOptionalMainInstanceKey()).toThrow(
        "MAIN_INSTANCE_KEY must be blank/unset or at least 32 bytes",
      );
    } finally {
      restore();
    }
  });

  test("fails fast when MAIN_INSTANCE_KEY is too short", () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: "short-key" });
    try {
      expect(() => validateOptionalMainInstanceKey()).toThrow(
        "MAIN_INSTANCE_KEY must be at least 32 bytes when set, got 9 bytes",
      );
    } finally {
      restore();
    }
  });

  test("runs DB_ENCRYPTION_KEY validation during boot checks", () => {
    clearTestEncryptionKey();
    expect(() => validateBootChecks()).toThrow(
      "DB_ENCRYPTION_KEY environment variable is required",
    );
  });

  test("runs MAIN_INSTANCE_KEY validation during boot checks", () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: "short-key" });
    try {
      expect(() => validateBootChecks()).toThrow(
        "MAIN_INSTANCE_KEY must be at least 32 bytes when set, got 9 bytes",
      );
    } finally {
      restore();
    }
  });
});
