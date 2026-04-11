import process from "node:process";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getEnv, isReadOnly, requireEnv } from "#lib/env.ts";
import { describeWithEnv } from "#test-utils";

// Unique per-file prefix so parallel workers can't see each other's state
// even if the overlay mechanism were ever bypassed.
const KEY = "TEST_ENV_VAR_FOR_ENV_SPEC";

describeWithEnv(
  "env",
  { env: { [KEY]: undefined, READ_ONLY: undefined } },
  () => {
    describe("getEnv", () => {
      test("returns the value set in the environment", () => {
        process.env[KEY] = "hello";
        expect(getEnv(KEY)).toBe("hello");
      });

      test("returns undefined when the variable is not set", () => {
        expect(getEnv(KEY)).toBeUndefined();
      });

      test("returns an empty string when the variable is set to empty", () => {
        process.env[KEY] = "";
        expect(getEnv(KEY)).toBe("");
      });
    });

    describe("requireEnv", () => {
      test("returns the value when the variable is set", () => {
        process.env[KEY] = "required_value";
        expect(requireEnv(KEY)).toBe("required_value");
      });

      test("throws an error that names the missing key", () => {
        expect(() => requireEnv(KEY)).toThrow(KEY);
      });
    });

    describe("isReadOnly", () => {
      test("is false when READ_ONLY is unset", () => {
        expect(isReadOnly()).toBe(false);
      });

      test("is true when READ_ONLY is exactly 'true'", () => {
        process.env.READ_ONLY = "true";
        expect(isReadOnly()).toBe(true);
      });

      test("is false for uppercase 'TRUE' (case-sensitive)", () => {
        process.env.READ_ONLY = "TRUE";
        expect(isReadOnly()).toBe(false);
      });

      test("is false for numeric '1'", () => {
        process.env.READ_ONLY = "1";
        expect(isReadOnly()).toBe(false);
      });

      test("is false for the literal string 'false'", () => {
        process.env.READ_ONLY = "false";
        expect(isReadOnly()).toBe(false);
      });
    });
  },
);
