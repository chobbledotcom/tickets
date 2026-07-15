import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  BOOT_CHECKS,
  validateBootChecks,
  validateOptionalMainInstanceKey,
} from "#shared/boot-checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { clearTestEncryptionKey, withEnv } from "#test-utils/env.ts";

describeWithEnv("boot checks", { encryptionKey: true }, () => {
  test("lists the global checks run before serving requests", () => {
    expect(BOOT_CHECKS.map((check) => check.name)).toEqual([
      "DB_ENCRYPTION_KEY",
      "MAIN_INSTANCE_KEY",
    ]);
  });

  test("allows MAIN_INSTANCE_KEY to be absent", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: undefined });
    expect(() => validateOptionalMainInstanceKey()).not.toThrow();
  });

  test("allows a high-entropy MAIN_INSTANCE_KEY", () => {
    using _env = withEnv({
      MAIN_INSTANCE_KEY: "instance-key-0123456789abcdef0123456789abcdef",
    });
    expect(() => validateOptionalMainInstanceKey()).not.toThrow();
  });

  test("fails fast when MAIN_INSTANCE_KEY is blank", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: "   " });
    expect(() => validateOptionalMainInstanceKey()).toThrow(
      "MAIN_INSTANCE_KEY must be blank/unset or at least 32 bytes",
    );
  });

  test("fails fast when MAIN_INSTANCE_KEY is too short", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: "short-key" });
    expect(() => validateOptionalMainInstanceKey()).toThrow(
      "MAIN_INSTANCE_KEY must be at least 32 bytes when set, got 9 bytes",
    );
  });

  test("runs DB_ENCRYPTION_KEY validation during boot checks", () => {
    clearTestEncryptionKey();
    expect(() => validateBootChecks()).toThrow(
      "DB_ENCRYPTION_KEY environment variable is required",
    );
  });

  test("runs MAIN_INSTANCE_KEY validation during boot checks", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: "short-key" });
    expect(() => validateBootChecks()).toThrow(
      "MAIN_INSTANCE_KEY must be at least 32 bytes when set, got 9 bytes",
    );
  });
});
