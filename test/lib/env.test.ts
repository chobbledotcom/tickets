import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { getEnv } from "#lib/env.ts";
import process from "node:process";

describe("env", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear test env vars
    delete process.env.TEST_ENV_VAR;
    Deno.env.delete("TEST_ENV_VAR");
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    Deno.env.delete("TEST_ENV_VAR");
  });

  describe("getEnv", () => {
    test("returns value from process.env when set", () => {
      process.env.TEST_ENV_VAR = "from_process";
      expect(getEnv("TEST_ENV_VAR")).toBe("from_process");
    });

    test("returns value from Deno.env when process.env not set", () => {
      Deno.env.set("TEST_ENV_VAR", "from_deno");
      expect(getEnv("TEST_ENV_VAR")).toBe("from_deno");
    });

    test("prefers process.env over Deno.env", () => {
      process.env.TEST_ENV_VAR = "from_process";
      Deno.env.set("TEST_ENV_VAR", "from_deno");
      expect(getEnv("TEST_ENV_VAR")).toBe("from_process");
    });

    test("returns undefined when not set in either", () => {
      expect(getEnv("TEST_ENV_VAR")).toBeUndefined();
    });
  });
});
